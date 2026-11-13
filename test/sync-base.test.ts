import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendEvent, deriveState, readEvents } from "../cli/events.ts";
import {
  ark,
  recordEvaluation,
  tempArkHome,
  tempGitRepo,
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
const lateTest = (file: string) => `import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
test("late ${file}", () => { expect(existsSync(${JSON.stringify(file)})).toBe(true); });
`;

/** Starts a run at the building phase over a repo with a local bare origin; the run has one own commit. */
function syncedRun(kind: "feature" | "refactor") {
  const arkHome = tempArkHome();
  const workspace = tempGitRepo({
    "test/probe.test.ts": probe,
    "test/own.test.ts": ownTest,
    "src.txt": "base\n",
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
  const ticket = writeTicket(
    "demo",
    "FAKE-1",
    [{ id: "FAKE-1-AC1", method: "test", text: "criterion FAKE-1-AC1" }],
    "Ticket FAKE-1",
    kind,
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
        changes: [{ criterion: "FAKE-1-AC1", where: "tests", now: "x", fix: "y" }],
      },
      steps: [
        {
          id: "build",
          role: "implementer",
          repo: ".",
          harness: "claude",
          model: "claude-sonnet",
          needs: [],
          criteria: ["FAKE-1-AC1"],
        },
      ],
      test_cases: [
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
    if (result.code !== 0) throw new Error(`${args.join(" ")} failed: ${result.err}`);
  }
  const mirror = join(runDirectory, "workspace");
  writeFileSync(join(mirror, "src.txt"), "own\n");
  git(mirror, "commit", "-qam", "own change");
  return { runId, runDirectory, workspace, mirror, createdBase };
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

test("ARK-T307 a refactor run that synced a target with new tests opens its merge request through ark merge-request open", () => {
  // The fake `gh` records its calls here.
  const fixtures = join(import.meta.dir, "fixtures/merge-request");
  process.env.PATH = `${fixtures}:${(process.env.PATH ?? "")
    .split(":")
    .filter((entry) => entry !== fixtures)
    .join(":")}`;
  process.env.FAKE_LOG = join(mkdtempSync(join(tmpdir(), "ark-fake-log-")), "calls.ndjson");

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
