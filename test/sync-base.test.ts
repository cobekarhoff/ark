import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendEvent, deriveState, readEvents } from "../cli/events.ts";
import {
  ark,
  recordEvaluation,
  tempArkHome,
  tempGitRepo,
  writeEvidenceFile,
  writeProject,
  writeTicket,
} from "./helpers.ts";
import { recordStartedRun, stopStartedRuns } from "./orphan-runners.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(120_000);

// ARK-419: no test-runner of a run this file started outlives its test.
afterEach(stopStartedRuns);

const roles = {
  implementer: { harness: "claude", model: "claude-sonnet" },
  validator: { harness: "codex", model: "gpt-codex" },
  reviewer: { harness: "codex", model: "gpt-codex" },
};

function git(directory: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", directory, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

// The probe test prints the commit of the checkout it runs in, so the base log names the base commit.
const probe = `import { test } from "bun:test";
import { execSync } from "node:child_process";
test("probe", () => { console.log("ark-base-sha " + execSync("git rev-parse HEAD").toString().trim()); });
`;
const ownTest = `import { test } from "bun:test";
test("FAKE-1-AC1 works", () => {});
`;
// `FAKE-T1` is the `verified_by` case of a run that asks for it: its head evidence names the tested head.
const verifiedTest = `test("FAKE-T1 works", () => {});
`;
const verifiedCase = [
  "---",
  "id: FAKE-T1",
  "title: FAKE-T1 fixture entry",
  "level: integration",
  "technique: fixture",
  "priority: low",
  "risk: none",
  "status: active",
  "changed_by: FAKE-1",
  "---",
  "",
  ...["Objective", "Preconditions", "Steps", "Expected results", "Screenshot checkpoints"].flatMap(
    (section) => [`## ${section}`, "", "x", ""],
  ),
].join("\n");
const lateTest = (file: string) => `import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
test("late ${file}", () => { expect(existsSync(${JSON.stringify(file)})).toBe(true); });
`;

type FixtureCriterion = { id: string; method: string; text: string; verified_by?: string[] };
type FixtureStep = {
  id: string;
  role: "implementer" | "validator";
  needs: string[];
  criteria: string[];
};

/**
 * Starts a run at the building phase over a repo with a local bare origin; the run has one own commit.
 * `verified`: `FAKE-1-AC1` is `verified_by: [FAKE-T1]`, so `ark merge-request open` also checks the head evidence of `FAKE-T1`.
 * `baseFiles`: more files in the base commit, pushed to the origin before the run starts.
 * `criteria`, `steps`, `title` and `summary` are written before `ark run start` and `plan check`: a later edit of the
 * criteria or the plan would send the run back to planning. They go with `verified: true` (the one plan test case is `FAKE-T1`).
 */
type SyncedRunOptions = {
  verified?: boolean;
  baseFiles?: Record<string, string>;
  criteria?: FixtureCriterion[];
  steps?: FixtureStep[];
  title?: string;
  summary?: string;
};
type SyncedRun = {
  arkHome: string;
  runId: string;
  runDirectory: string;
  workspace: string;
  mirror: string;
  createdBase: string;
};

function syncedRun(kind: "feature" | "refactor", options: SyncedRunOptions = {}): SyncedRun {
  const arkHome = tempArkHome();
  const workspace = tempGitRepo({
    "test/probe.test.ts": probe,
    "test/own.test.ts": options.verified ? `${ownTest}${verifiedTest}` : ownTest,
    ...(options.verified ? { "test/cases/FAKE-T1.md": verifiedCase } : {}),
    "src.txt": "base\n",
    ...options.baseFiles,
  });
  const bare = join(mkdtempSync(join(tmpdir(), "ark-origin-")), "github.com", "org", "core.git");
  mkdirSync(bare, { recursive: true });
  for (const args of [
    ["-C", bare, "init", "--bare", "-q", "--initial-branch=main"],
    ["-C", workspace, "remote", "add", "origin", bare],
    ["-C", workspace, "push", "origin", "HEAD:refs/heads/main"],
    ["-C", workspace, "remote", "set-head", "origin", "main"],
  ])
    Bun.spawnSync(["git", ...args]);
  const createdBase = git(workspace, "rev-parse", "HEAD");
  writeProject("demo", {
    workspace,
    ticket_source: "local",
    test_min_free_memory_percent: 0,
    test_max_swap_gb: 1000,
    suites: [
      {
        name: "e2e",
        level: "e2e",
        repo: ".",
        command: "bun test --reporter=junit --reporter-outfile={report} ./test",
        parser: "bun",
      },
    ],
    roles,
  });
  const criteria = options.criteria ?? [
    {
      id: "FAKE-1-AC1",
      method: "test",
      text: "criterion FAKE-1-AC1",
      ...(options.verified ? { verified_by: ["FAKE-T1"] } : {}),
    },
  ];
  const ticket = writeTicket("demo", "FAKE-1", criteria, options.title ?? "Ticket FAKE-1", kind);
  if (options.summary !== undefined)
    writeFileSync(
      ticket,
      readFileSync(ticket, "utf8").replace(
        "status: ready\n",
        `status: ready\nsummary: ${JSON.stringify(options.summary)}\n`,
      ),
    );
  const runId = ark("run", "start", ticket, "--project", "demo").out.match(
    /\d{4}-\d{2}-\d{2}-FAKE-1-\d+/,
  )![0];
  const runDirectory = join(arkHome, "projects", "demo", "runs", runId);
  recordStartedRun({ runId, runDirectory });
  recordEvaluation(runDirectory);
  writeFileSync(
    join(runDirectory, "plan.yml"),
    JSON.stringify({
      design: { interfaces: [{ name: "fixture plan", callers: ["ark test"] }] },
      summary: {
        why: "Test the base.",
        changes: criteria.map(({ id }) => ({ criterion: id, where: "tests", now: "x", fix: "y" })),
      },
      steps: (
        options.steps ?? [{ id: "build", role: "implementer", needs: [], criteria: ["FAKE-1-AC1"] }]
      ).map((step) => ({ repo: ".", ...roles[step.role], ...step })),
      test_cases: options.verified
        ? [{ id: "FAKE-T1", action: "reuse", level: "integration" }]
        : [
            {
              id: "proves-FAKE-1-AC1",
              criterion: "FAKE-1-AC1",
              level: "e2e",
              given: [],
              when: ["run it"],
              // oxlint-disable-next-line unicorn/no-thenable -- plan test-case field `then: string[]`, not a Promise-like
              then: ["it works"],
              expected: "it works",
            },
          ],
    }),
  );
  for (const args of [
    ["plan", "check", runId],
    ["gate", "record", runId, "plan", "approve"],
    ["worktree", "create", runId, "."],
  ]) {
    const result = ark(...args);
    if (result.code !== 0) throw new Error(`${args.join(" ")} failed: ${result.err}${result.out}`);
  }
  const mirror = join(runDirectory, "workspace");
  writeFileSync(join(mirror, "src.txt"), "own\n");
  git(mirror, "commit", "-qam", "own change");
  return { arkHome, runId, runDirectory, workspace, mirror, createdBase };
}

/** Commits `files` on the origin target in a fresh clone and returns the new tip. */
function moveTarget(workspace: string, files: Record<string, string>): string {
  const clone = mkdtempSync(join(tmpdir(), "ark-target-clone-"));
  git(clone, "clone", "-q", git(workspace, "remote", "get-url", "origin"), ".");
  git(clone, "config", "user.name", "Ark Test");
  git(clone, "config", "user.email", "ark@example.com");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(clone, name)), { recursive: true });
    writeFileSync(join(clone, name), content);
  }
  git(clone, "add", "-A");
  git(clone, "commit", "-qm", "target move");
  git(clone, "push", "-q", "origin", "HEAD:refs/heads/main");
  return git(clone, "rev-parse", "HEAD");
}

const lateFiles = (file: string) => ({
  [file]: "late\n",
  [`test/${file}.test.ts`]: lateTest(file),
});

const baseSha = (runDirectory: string): string =>
  readFileSync(join(runDirectory, "results", "base-e2e.log"), "utf8").match(
    /ark-base-sha ([0-9a-f]{40})/,
  )?.[1] ?? "no sha in the base log";

const completed = (runDirectory: string) =>
  readFileSync(join(runDirectory, "events.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((event) => event.type === "test.completed")
    .map((event) => event.data);

/** Runs `ark test` and returns the base commit its base side ran at and whether a test failed there (a feature run records no `base_passed`). */
function baseOfTest(run: { runId: string; runDirectory: string }) {
  const result = ark("test", run.runId);
  expect(result.err).not.toContain("base checkout");
  const log = readFileSync(join(run.runDirectory, "results", "base-e2e.log"), "utf8");
  return { sha: baseSha(run.runDirectory), failed: log.includes("(fail)") };
}

test("ARK-T306 after a sync ark test runs the base side at the newest synced target commit, and at the worktree.created base without a commit", () => {
  const run = syncedRun("feature");
  const first = moveTarget(run.workspace, lateFiles("late1.txt"));

  // Never synced: the created base, and no target test in the run.
  expect(baseOfTest(run)).toEqual({ sha: run.createdBase, failed: false });

  expect(ark("worktree", "sync", run.runId).code).toBe(0);
  // The target's own test and its source are merged in: a base at the target passes it.
  expect(baseOfTest(run)).toEqual({ sha: first, failed: false });
  // The state base stays the created base: the MR ahead count and the paths skip read it.
  const state = deriveState(readEvents(run.runDirectory));
  expect(state.worktrees[0].base).toBe(run.createdBase);

  // A second sync: the newest commit wins.
  const second = moveTarget(run.workspace, lateFiles("late2.txt"));
  expect(ark("worktree", "sync", run.runId).code).toBe(0);
  expect(baseOfTest(run)).toEqual({ sha: second, failed: false });

  // A newer conflict-only event does not reset the base.
  appendEvent(run.runDirectory, "worktree.synced", { repo: ".", conflict: true });
  expect(baseOfTest(run).sha).toBe(second);

  // Old-shape events (no commit) fall back to the created base.
  const eventsFile = join(run.runDirectory, "events.ndjson");
  writeFileSync(
    eventsFile,
    `${readFileSync(eventsFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const event = JSON.parse(line);
        if (event.type === "worktree.synced") delete event.data.target_commit;
        return JSON.stringify(event);
      })
      .join("\n")}\n`,
  );
  expect(baseOfTest(run).sha).toBe(run.createdBase);
});

/** The fake `gh` of test/fixtures/merge-request first on PATH; it records its calls in a fresh log. */
function useFakeHost(): void {
  const fixtures = join(import.meta.dir, "fixtures/merge-request");
  process.env.PATH = `${fixtures}:${(process.env.PATH ?? "")
    .split(":")
    .filter((entry) => entry !== fixtures)
    .join(":")}`;
  process.env.FAKE_LOG = join(mkdtempSync(join(tmpdir(), "ark-fake-log-")), "calls.ndjson");
}

test("ARK-T307 a refactor run that synced a target with new tests opens its merge request through ark merge-request open", () => {
  useFakeHost();

  // Control: not synced, the target test is not in the run at all.
  const control = syncedRun("refactor");
  moveTarget(control.workspace, lateFiles("late1.txt"));
  expect(ark("test", control.runId).code).toBe(0);
  expect(completed(control.runDirectory).at(-1).base_passed).toBe(true);

  const run = syncedRun("refactor");
  moveTarget(run.workspace, lateFiles("late1.txt"));
  expect(ark("worktree", "sync", run.runId).code).toBe(0);
  const tested = ark("test", run.runId);
  expect(tested.code, tested.err + tested.out).toBe(0);
  expect(tested.out).toContain("base      passed");
  expect(completed(run.runDirectory).at(-1).base_passed).toBe(true);

  const opened = ark("merge-request", "open", run.runId);
  expect(opened.code, opened.err + opened.out).toBe(0);
  expect(readFileSync(join(run.runDirectory, "events.ndjson"), "utf8")).toContain(
    '"merge_request.opened"',
  );
  expect(existsSync(process.env.FAKE_LOG!)).toBe(true);
});

// --- ARK-463: a clean sync after the passing test --------------------------------------------------------------------------

type TestedRun = {
  runId: string;
  runDirectory: string;
  workspace: string;
  mirror: string;
  /** The head H that the passing full test ran at. */
  testedHead: string;
};

/** A `verified_by` run whose full `ark test` passed at head H; the evidence of `FAKE-T1` names H, so open checks it. */
function testedRun(): TestedRun {
  const run = syncedRun("feature", { verified: true });
  const tested = ark("test", run.runId);
  expect(tested.code, tested.err + tested.out).toBe(0);
  const testedHead = git(run.mirror, "rev-parse", "HEAD");
  const evidence = JSON.parse(
    readFileSync(
      join(run.runDirectory, "results", "evidence", "FAKE-T1", "head", "result.json"),
      "utf8",
    ),
  );
  expect(evidence.sha).toBe(testedHead);
  return { ...run, testedHead };
}

function sync(run: { runId: string }): void {
  const synced = ark("worktree", "sync", run.runId);
  expect(synced.code, synced.err + synced.out).toBe(0);
}

/** What a refused open must leave alone: the origin refs, the event count and the phase. */
const snapshot = (run: TestedRun) => ({
  refs: git(run.mirror, "ls-remote", "origin"),
  events: readFileSync(join(run.runDirectory, "events.ndjson"), "utf8").trim().split("\n").length,
  phase: deriveState(readEvents(run.runDirectory)).phase,
});

/** The lines of `text` that name both commits by their first 8 characters. */
const linesNaming = (text: string, first: string, second: string): string[] =>
  text
    .split("\n")
    .filter((line) => line.includes(first.slice(0, 8)) && line.includes(second.slice(0, 8)));

test("ARK-T373 merge-request open accepts a head that moved past the passing test only by clean ark worktree sync merges, and names the tested and the merged commit", () => {
  useFakeHost();
  const run = testedRun();
  const target = moveTarget(run.workspace, { "target.txt": "t1\n" });
  sync(run);
  expect(git(run.mirror, "rev-parse", "HEAD^1")).toBe(run.testedHead);
  expect(git(run.mirror, "rev-parse", "HEAD^2")).toBe(target);

  const status = ark("status", run.runId);
  expect(status.out).toContain("test head: current");
  expect(status.out).not.toContain("test head: stale");

  const opened = ark("merge-request", "open", run.runId);
  const text = opened.err + opened.out;
  expect(opened.code, text).toBe(0);
  expect(text).not.toContain("changed since the last test run");
  expect(text).not.toContain("test evidence stale");
  expect(linesNaming(text, run.testedHead, target)).toHaveLength(1);
  const branch = git(run.mirror, "branch", "--show-current");
  expect(git(run.mirror, "ls-remote", "origin", `refs/heads/${branch}`).split("\t")[0]).toBe(
    git(run.mirror, "rev-parse", "HEAD"),
  );

  // The MR is open and the head is unchanged: open again refuses nothing as stale.
  const again = ark("merge-request", "open", run.runId);
  expect(again.code, again.err + again.out).toBe(0);
});

test("ARK-T373 a chain of two clean syncs is accepted and the line names the newest merged commit", () => {
  useFakeHost();
  const run = testedRun();
  moveTarget(run.workspace, { "target1.txt": "t1\n" });
  sync(run);
  const newest = moveTarget(run.workspace, { "target2.txt": "t2\n" });
  sync(run);
  expect(git(run.mirror, "rev-parse", "HEAD^2")).toBe(newest);

  const opened = ark("merge-request", "open", run.runId);
  const text = opened.err + opened.out;
  expect(opened.code, text).toBe(0);
  expect(linesNaming(text, run.testedHead, newest)).toHaveLength(1);
});

function commitFile(mirror: string, name: string): void {
  writeFileSync(join(mirror, name), `${name}\n`);
  git(mirror, "add", "-A");
  git(mirror, "commit", "-qm", name);
}

type Shape = { name: string; refused: boolean; build: (run: TestedRun) => void };

// Each shape builds the commits after the tested head H in a fresh run. The last row is the accepted one: one clean sync.
const shapes: Shape[] = [
  { name: "(a) an own commit", refused: true, build: (run) => commitFile(run.mirror, "own2.txt") },
  {
    name: "(b) a merge that resolved a conflict",
    refused: true,
    build: (run) => {
      moveTarget(run.workspace, { "src.txt": "target\n" });
      git(run.mirror, "fetch", "-q", "origin");
      // A conflicting merge is the point here: `git()` would throw on its exit code.
      const merged = Bun.spawnSync(["git", "-C", run.mirror, "merge", "-q", "origin/main"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(merged.exitCode).not.toBe(0);
      writeFileSync(join(run.mirror, "src.txt"), "resolved by hand\n");
      git(run.mirror, "add", "src.txt");
      git(run.mirror, "commit", "-q", "--no-edit");
    },
  },
  {
    name: "(c) a merge whose tree holds an extra file",
    refused: true,
    build: (run) => {
      moveTarget(run.workspace, { "target.txt": "t1\n" });
      git(run.mirror, "fetch", "-q", "origin");
      git(run.mirror, "merge", "-q", "--no-commit", "--no-ff", "origin/main");
      writeFileSync(join(run.mirror, "extra.txt"), "extra\n");
      git(run.mirror, "add", "-A");
      git(run.mirror, "commit", "-qm", "merge with an extra file");
    },
  },
  {
    name: "(d) a clean merge of a commit that is not on the target",
    refused: true,
    build: (run) => {
      const branch = git(run.mirror, "branch", "--show-current");
      git(run.mirror, "checkout", "-q", "-b", "foreign", run.testedHead);
      commitFile(run.mirror, "foreign.txt");
      git(run.mirror, "checkout", "-q", branch);
      git(run.mirror, "merge", "-q", "--no-ff", "-m", "merge foreign", "foreign");
    },
  },
  {
    name: "(e) an own commit between two clean syncs",
    refused: true,
    build: (run) => {
      moveTarget(run.workspace, { "target1.txt": "t1\n" });
      sync(run);
      commitFile(run.mirror, "own2.txt");
      moveTarget(run.workspace, { "target2.txt": "t2\n" });
      sync(run);
    },
  },
  {
    name: "(f) an octopus merge of H and two target commits",
    refused: true,
    build: (run) => {
      const first = moveTarget(run.workspace, { "target1.txt": "t1\n" });
      const second = moveTarget(run.workspace, { "target2.txt": "t2\n" });
      git(run.mirror, "fetch", "-q", "origin");
      // `git merge` drops a parent that is an ancestor of another, so the commit is built with plumbing.
      const tree = git(run.mirror, "merge-tree", "--write-tree", "HEAD", "origin/main");
      const octopus = git(
        run.mirror,
        "commit-tree",
        tree,
        "-p",
        run.testedHead,
        "-p",
        first,
        "-p",
        second,
        "-m",
        "octopus",
      );
      git(run.mirror, "reset", "-q", "--hard", octopus);
      expect(git(run.mirror, "rev-list", "--parents", "-1", "HEAD").split(" ")).toHaveLength(4);
    },
  },
  {
    name: "(g) one clean ark worktree sync, the accepted control",
    refused: false,
    build: (run) => {
      moveTarget(run.workspace, { "target.txt": "t1\n" });
      sync(run);
    },
  },
];

test.each(shapes)("ARK-T374 open on a head with $name", ({ refused, build }) => {
  useFakeHost();
  const run = testedRun();
  build(run);
  const before = snapshot(run);
  const status = ark("status", run.runId);
  const opened = ark("merge-request", "open", run.runId);
  const text = opened.err + opened.out;
  if (!refused) {
    expect(opened.code, text).toBe(0);
    expect(status.out).toContain("test head: current");
    return;
  }
  expect(opened.code, text).toBe(1);
  expect(opened.err).toContain("changed since the last test run");
  expect(opened.err).toContain("repo .");
  expect(opened.err).toContain(`run ark test ${run.runId} again`);
  expect(snapshot(run)).toEqual(before);
  expect(status.out).toContain("test head: stale");
  expect(status.out).not.toContain("test head: current");
});

const oldIdSource = `import { test } from "bun:test";
test("ARK-9-AC2 first", () => {
  const a = 1;
  const b = 2;
});
test("ARK-9-AC3 second", () => {
  const c = 3;
});
test("ARK-9-AC4 third", () => {
  const d = 4;
});
`;
// The target deletes a line of the AC2 test and edits the AC3 test; neither is a change of the run.
const targetOldIdSource = oldIdSource.replace("  const b = 2;\n", "").replace("c = 3", "c = 30");
const oldIdLine = /old id\s+suite e2e \(bun\)\s+(\S+)/;

test("ARK-T375 the old-id check of ark test diffs from the synced target commit, so a merged target commit never counts, while the run's own change to an old-id declaration still fails", () => {
  const run = syncedRun("feature", { baseFiles: { "test/old.test.ts": oldIdSource } });
  moveTarget(run.workspace, { "test/old.test.ts": targetOldIdSource });
  sync(run);

  const merged = ark("test", run.runId);
  expect(merged.code, merged.err + merged.out).toBe(0);
  expect(merged.out).toMatch(
    /old id\s+suite e2e \(bun\)\s+passed\s+\(0 old-id declarations touched\)/,
  );
  expect(merged.out).not.toContain("old id touched");
  expect(readFileSync(join(run.runDirectory, "results", "check-old-id-e2e.log"), "utf8")).toBe("");

  // The run edits the AC4 test itself.
  const file = join(run.mirror, "test", "old.test.ts");
  const merged4 = readFileSync(file, "utf8");
  writeFileSync(file, merged4.replace("d = 4", "d = 40"));
  git(run.mirror, "commit", "-qam", "own old-id edit");
  const line = merged4.split("\n").findIndex((text) => text.includes("ARK-9-AC4")) + 1;

  const own = ark("test", run.runId);
  expect(own.code).not.toBe(0);
  expect(own.out).toMatch(/old id\s+suite e2e \(bun\)\s+failed/);
  const touched = own.out.split("\n").filter((text) => text.startsWith("old id touched"));
  expect(touched).toEqual([`old id touched: test/old.test.ts:${line} ARK-9-AC4 third`]);
  expect(own.out).toContain("write a test case");
});

test("ARK-T375 a synced commit that HEAD does not hold leaves the target's work out of the old-id check", () => {
  const run = syncedRun("feature", { baseFiles: { "test/old.test.ts": oldIdSource } });
  const before = git(run.mirror, "rev-parse", "HEAD");
  moveTarget(run.workspace, { "test/old.test.ts": targetOldIdSource });
  sync(run);
  git(run.mirror, "reset", "-q", "--hard", before);

  const result = ark("test", run.runId);
  expect(result.code, result.err + result.out).toBe(0);
  expect(result.out.match(oldIdLine)?.[1]).toBe("passed");
  expect(result.out).not.toContain("old id touched");
});

// --- ARK-405: ark merge-request check, the head block of ark test, and the manual answer ----------------------------------

const noString = "`no-such-string-405` and `no-such-other-405`";
const allCriteria = ["FAKE-1-AC1", "FAKE-1-AC2", "FAKE-1-AC3"];
/** A test AC, an analysis AC and a demonstration AC. `text` is the text of the test AC: it holds the strings of the AC check. */
const stageCriteria = (text = `criterion with ${noString}`): FixtureCriterion[] => [
  { id: "FAKE-1-AC1", method: "test", verified_by: ["FAKE-T1"], text },
  { id: "FAKE-1-AC2", method: "analysis", text: "analysis criterion" },
  { id: "FAKE-1-AC3", method: "demonstration", text: "demonstration criterion" },
];
const stageSteps: FixtureStep[] = [
  { id: "build", role: "implementer", needs: [], criteria: allCriteria },
  { id: "check", role: "validator", needs: ["build"], criteria: allCriteria },
];
const stageRun = (options: SyncedRunOptions = {}) =>
  syncedRun("feature", {
    verified: true,
    criteria: stageCriteria(),
    steps: stageSteps,
    ...options,
  });

/** Each fixture has its own ARK_HOME and `tempArkHome` switches the variable: every command names its fixture. */
function arkIn(run: Pick<SyncedRun, "arkHome">, ...args: string[]) {
  process.env.ARK_HOME = run.arkHome;
  return ark(...args);
}

const outputLines = (result: { out: string }) =>
  result.out.split("\n").filter((line) => line !== "");
const manualLine = 'evidence malformed: AC3: missing section "What the human saw"';
const evidencePath = (run: SyncedRun, id: string) =>
  join(run.runDirectory, "results", "evidence", `${id}.md`);
const readEvidence = (run: SyncedRun, id: string) => readFileSync(evidencePath(run, id), "utf8");
const writeEvidence = (run: SyncedRun, id: string, text: string) =>
  writeFileSync(evidencePath(run, id), text);
/** A demonstration file without its last line `human: ok`. `saw: false` drops the section `What the human saw`. */
function writeDemonstration(run: SyncedRun, { saw = true } = {}) {
  writeEvidenceFile(run.runDirectory, "AC3", "demonstration", { humanOk: false });
  if (!saw)
    writeEvidence(
      run,
      "AC3",
      readEvidence(run, "AC3").replace(/## What the human saw\n\nThe feature\.\n\n/, ""),
    );
}

function commitTracked(run: SyncedRun, name: string, content: string): void {
  writeFileSync(join(run.mirror, name), content);
  git(run.mirror, "add", name);
  git(run.mirror, "commit", "-qm", name);
}

const answerManual = (run: SyncedRun, id: string) => {
  const answered = arkIn(run, "gate", "record", run.runId, "manual", id, "ok");
  expect(answered.code, answered.err + answered.out).toBe(0);
};

function fullTest(run: SyncedRun, expectedCode = 0) {
  const tested = arkIn(run, "test", run.runId);
  expect(tested.code, tested.err + tested.out).toBe(expectedCode);
  return tested;
}

const names = (directory: string): string[] =>
  readdirSync(directory, { recursive: true })
    .map(String)
    .filter((name) => !name.split("/").includes(".git"))
    .sort()
    .map((name) => `${name} ${lstatSync(join(directory, name)).size}`);

/** What a read-only command must leave alone: the event log, the files of the run and the worktree, and the origin refs. */
const readOnlyRecord = (run: SyncedRun) => ({
  events: readFileSync(join(run.runDirectory, "events.ndjson"), "utf8"),
  porcelain: git(run.mirror, "status", "--porcelain"),
  refs: git(run.mirror, "ls-remote", "origin"),
  runFiles: names(run.runDirectory),
  worktreeFiles: names(run.mirror),
});

/**
 * Runs `ark merge-request check` and expects exactly `expected` as its lines (every line if `exact`, else at least these),
 * the exit code 1 for a problem line and 0 for none or only warnings, and no change to what the run holds.
 */
function expectStage(run: SyncedRun, args: string[], expected: string[], exact = true) {
  const before = readOnlyRecord(run);
  const result = arkIn(run, "merge-request", "check", run.runId, ...args);
  const lines = outputLines(result);
  if (exact) expect(lines.toSorted(), result.err).toEqual(expected.toSorted());
  else expect(lines, result.err).toEqual(expect.arrayContaining(expected));
  expect(result.code, result.err).toBe(lines.some((line) => !line.startsWith("warning: ")) ? 1 : 0);
  expect(readOnlyRecord(run)).toEqual(before);
  return result;
}

const stringsLine = (...strings: string[]) =>
  `AC string in no tracked file at head: ${strings.map((text) => `FAKE-1/AC1 \`${text}\``).join("; ")}`;
const absentLine = stringsLine("no-such-string-405", "no-such-other-405");
const seventyThree = `FAKE-1: ${"s".repeat(65)}`;

test("ARK-T379 ark merge-request check lists the problems of stage head, step and final, one line each, and changes nothing", () => {
  useFakeHost();
  // Problem fixture: no string in a tracked file, no file for AC2, a demonstration file without a section.
  const problem = stageRun();
  writeDemonstration(problem, { saw: false });
  expectStage(problem, ["--stage", "head"], [absentLine, manualLine]);
  // --summary makes a title of 73 characters.
  expectStage(
    problem,
    ["--stage", "head", "--summary", "s".repeat(65)],
    [
      absentLine,
      manualLine,
      `--summary makes a title of 73 characters, 72 allowed: ${seventyThree}`,
    ],
  );
  // The step that serves the analysis AC owns the missing file; a step without it does not.
  const stepLines = [absentLine, manualLine, "evidence missing: AC2 (analysis)"];
  expectStage(problem, ["--stage", "step", "--step", "check"], stepLines);
  expectStage(problem, ["--stage", "step"], stepLines);
  expectStage(
    problem,
    ["--stage", "final"],
    [...stepLines, "no test result yet: run `ark test` first"],
    false,
  );
  const narrow = stageRun({
    steps: [stageSteps[0]!, { ...stageSteps[1]!, criteria: ["FAKE-1-AC1"] }],
  });
  writeDemonstration(narrow, { saw: false });
  expectStage(narrow, ["--stage", "step", "--step", "check"], [absentLine, manualLine]);
  expectStage(narrow, ["--stage", "step"], stepLines);

  // The title: the ticket's own summary and title are both too long.
  const long = stageRun({
    criteria: stageCriteria("criterion with no string"),
    title: "t".repeat(70),
    summary: "s".repeat(70),
  });
  expectStage(long, ["--stage", "head"], ["ticket has no summary: pass --summary"]);
  expectStage(long, ["--stage", "head", "--summary", "short"], []);

  // Passing fixture, then the control: the same files, the last line of AC3 added by the human's answer.
  const control = stageRun();
  commitTracked(control, "strings.txt", `${noString}\n`);
  writeEvidenceFile(control.runDirectory, "AC2", "analysis");
  writeDemonstration(control);
  answerManual(control, "AC2");
  fullTest(control, 1);
  expectStage(control, ["--stage", "head"], []);
  expectStage(control, ["--stage", "step", "--step", "check"], []);
  expectStage(control, ["--stage", "final"], ["manual criterion without ok: FAKE-1/AC3"], false);
  answerManual(control, "AC3");
  fullTest(control);
  for (const stage of ["head", "step", "final"]) expectStage(control, ["--stage", stage], []);

  // Final lines of open: the files that open checks come out as the lines that open refuses with.
  const demonstration = readEvidence(control, "AC3");
  const analysis = readEvidence(control, "AC2");
  rmSync(evidencePath(control, "AC2"));
  writeEvidence(
    control,
    "AC3",
    demonstration.replace("## What the human saw\n\nThe feature.\n\n", ""),
  );
  const evidenceLines = ["evidence missing: AC2 (analysis)", manualLine];
  expectStage(control, ["--stage", "final"], evidenceLines);
  let before = readOnlyRecord(control);
  const refused = arkIn(control, "merge-request", "open", control.runId);
  expect(refused.code).toBe(1);
  expect(refused.err).toBe(`ark: refused: evidence is not complete\n${evidenceLines.join("\n")}\n`);
  expect(readOnlyRecord(control)).toEqual(before);

  // An AC string: the one joined line is the open refusal, byte for byte.
  writeEvidence(control, "AC2", analysis);
  writeEvidence(control, "AC3", demonstration);
  const ticketFile = join(control.runDirectory, "ticket.md");
  writeFileSync(
    ticketFile,
    readFileSync(ticketFile, "utf8").replace(noString, "`absent-one-405` and `absent-two-405`"),
  );
  const absent = stringsLine("absent-one-405", "absent-two-405");
  expectStage(control, ["--stage", "head"], [absent]);
  before = readOnlyRecord(control);
  const refusedString = arkIn(control, "merge-request", "open", control.runId);
  expect(refusedString.err).toBe(`ark: ${absent}\n`);
  expect(readOnlyRecord(control)).toEqual(before);
});

const headBlock = (text: string) =>
  text.match(/^merge-request check\n(?:.+\n?)*/m)?.[0] ?? "no merge-request check block";
const lastCompleted = (run: SyncedRun) => completed(run.runDirectory).at(-1);

test("ARK-T380 ark test prints the head problems under merge-request check, keeps its exit code and passed, and open refuses with the printed line", () => {
  useFakeHost();
  // AC2 is answered, so the run exits 0 and only the head block differs between the two fixtures.
  const problem = stageRun({
    criteria: stageCriteria().slice(0, 2),
    steps: stageSteps.slice(0, 1),
  });
  const control = stageRun({
    criteria: stageCriteria().slice(0, 2),
    steps: stageSteps.slice(0, 1),
  });
  commitTracked(control, "strings.txt", `${noString}\n`);
  for (const run of [problem, control]) answerManual(run, "AC2");

  const printed = fullTest(problem);
  expect(printed.out).toContain(`merge-request check\n${absentLine}\n`);
  expect(headBlock(printed.out)).not.toContain("evidence missing");
  expect(lastCompleted(problem).passed).toBe(true);

  const clean = fullTest(control);
  expect(clean.out).not.toContain("merge-request check");
  expect(lastCompleted(control).passed).toBe(true);
  // Only the block differs; the suite lines may carry a `reused` suffix.
  const withoutSuites = (text: string) =>
    text
      .replace(headBlock(text), "")
      .split("\n")
      .filter((line) => !line.startsWith("suite "));
  expect(withoutSuites(printed.out)).toEqual(withoutSuites(clean.out));
  expect(Object.keys(lastCompleted(problem)).sort()).toEqual(
    Object.keys(lastCompleted(control)).sort(),
  );

  // Open refuses with the printed line; after the fix it refuses for the evidence file, a problem of stage final.
  expect(arkIn(problem, "merge-request", "open", problem.runId).err).toBe(`ark: ${absentLine}\n`);
  commitTracked(problem, "strings.txt", `${noString}\n`);
  expect(fullTest(problem).out).not.toContain("merge-request check");
  const refused = arkIn(problem, "merge-request", "open", problem.runId);
  expect(refused.err).toBe(
    "ark: refused: evidence is not complete\nevidence missing: AC2 (analysis)\n",
  );
});

test("ARK-T380 a failing run still prints the head block before the failure, with the exit code and passed of the run without the problem", () => {
  const failing = (withString: boolean) => {
    const run = stageRun({ criteria: stageCriteria().slice(0, 2), steps: stageSteps.slice(0, 1) });
    if (withString) commitTracked(run, "strings.txt", `${noString}\n`);
    answerManual(run, "AC2");
    writeFileSync(
      join(run.mirror, "test/own.test.ts"),
      readFileSync(join(run.mirror, "test/own.test.ts"), "utf8").replace(
        'test("FAKE-T1 works", () => {});',
        'test("FAKE-T1 works", () => { throw new Error("red"); });',
      ),
    );
    git(run.mirror, "commit", "-qam", "break FAKE-T1");
    return { run, result: fullTest(run, 1) };
  };
  const problem = failing(false);
  const control = failing(true);
  expect(problem.result.out).toContain(`merge-request check\n${absentLine}\n`);
  expect(control.result.out).not.toContain("merge-request check");
  expect(problem.result.err).toContain("suite e2e failed");
  expect(problem.result.err).toBe(control.result.err);
  expect(lastCompleted(problem.run).passed).toBe(false);
  expect(lastCompleted(control.run).passed).toBe(false);
});

const warningLine = "warning: manual answer older than head: FAKE-1/AC2";
const answeredHeads = (run: SyncedRun) =>
  readEvents(run.runDirectory).findLast(
    (event) => event.type === "gate.answered" && event.data.criterion === "FAKE-1/AC2",
  )?.data.heads;

/** A run whose AC2 (demonstration) has a well-formed file that lacks `human: ok`. AC1 has no string, so stage final is clean at its head. */
function answeredRun() {
  const run = stageRun({
    criteria: [
      stageCriteria("criterion without a string")[0]!,
      { id: "FAKE-1-AC2", method: "demonstration", text: "demonstration criterion" },
    ],
    steps: [{ ...stageSteps[0]!, criteria: ["FAKE-1-AC1", "FAKE-1-AC2"] }],
  });
  writeEvidenceFile(run.runDirectory, "AC2", "demonstration", { humanOk: false });
  return run;
}
const commitAndTest = (run: SyncedRun, name: string) => {
  commitTracked(run, name, `${name}\n`);
  fullTest(run);
};

test("ARK-T383 a manual answer records the head of each repo and stage final warns when a head moved after it, with the exit code and open unchanged", () => {
  useFakeHost();
  const run = answeredRun();
  const answeredAt = git(run.mirror, "rev-parse", "HEAD");
  answerManual(run, "AC2");
  fullTest(run);
  expect(answeredHeads(run)).toEqual({ ".": answeredAt });
  expectStage(run, ["--stage", "final"], []);

  commitAndTest(run, "later.txt");
  expectStage(run, ["--stage", "final"], [warningLine]);
  expectStage(run, ["--stage", "head"], []);
  expectStage(run, ["--stage", "step"], []);

  const opened = arkIn(run, "merge-request", "open", run.runId);
  expect(opened.code, opened.err + opened.out).toBe(0);
  expect(opened.err + opened.out).not.toContain("warning:");
});

test("ARK-T383 stage final warns about an old answer beside a problem with the exit code of the problem alone, and not after a clean ark worktree sync", () => {
  useFakeHost();
  const moved = answeredRun();
  answerManual(moved, "AC2");
  fullTest(moved);
  commitAndTest(moved, "later.txt");
  const still = answeredRun();
  answerManual(still, "AC2");
  fullTest(still);
  const longSummary = ["--stage", "final", "--summary", "s".repeat(65)];
  const titleLine = `--summary makes a title of 73 characters, 72 allowed: ${seventyThree}`;
  expectStage(moved, longSummary, [titleLine, warningLine]);
  expectStage(still, longSummary, [titleLine]);

  // A clean merge of the target after the answer: the sync is the only change, so no warning and no stale head.
  const synced = answeredRun();
  answerManual(synced, "AC2");
  fullTest(synced);
  moveTarget(synced.workspace, { "target.txt": "t1\n" });
  process.env.ARK_HOME = synced.arkHome;
  sync(synced);
  expectStage(synced, ["--stage", "final"], []);
});

test("ARK-T383 an answer with no recorded heads gives no warning", () => {
  const run = answeredRun();
  writeEvidence(run, "AC2", `${readEvidence(run, "AC2")}\nhuman: ok\n`);
  process.env.ARK_HOME = run.arkHome;
  appendEvent(run.runDirectory, "gate.answered", {
    gate: "manual",
    criterion: "FAKE-1/AC2",
    answer: "ok",
    by: "human",
  });
  commitAndTest(run, "later.txt");
  expectStage(run, ["--stage", "final"], []);
});
