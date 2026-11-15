import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendEvent, deriveState, readEvents } from "../cli/events.ts";
import { installFakeOrca, removeFakeOrca } from "./fake-orca.ts";
import {
  ark,
  recordEvaluation,
  tempArkHome,
  tempGitRepo,
  writeProject,
  writeTicket,
} from "./helpers.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it. Every test starts runs and scans with a TypeScript child.
setDefaultTimeout(60_000);

const originalPath = process.env.PATH;
afterEach(() => {
  removeFakeOrca();
  process.env.PATH = originalPath;
});

const testFile = "test/a.test.ts";
const caseIds = ["ARK-T1", "ARK-T2", "ARK-T3", "ARK-T9"];

/** A bun test file with one test for each case id; `values` sets the body of the tests it names. */
function source(values: Record<string, number> = {}, extra: string[] = []): string {
  const tests = [...caseIds, ...extra].flatMap((id) => [
    `test("${id} case", () => {`,
    `  const value = ${values[id] ?? 1};`,
    `});`,
  ]);
  return `import { test } from "bun:test";\n${tests.join("\n")}\n`;
}

function git(directory: string, ...args: string[]): string {
  const result = Bun.spawnSync([
    "git",
    "-C",
    directory,
    "-c",
    "user.name=Ark",
    "-c",
    "user.email=ark@example.com",
    ...args,
  ]);
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function commitFiles(directory: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, name)), { recursive: true });
    writeFileSync(join(directory, name), content);
  }
  git(directory, "add", "-A");
  git(directory, "commit", "-qm", "change");
}

const testCase = (id: string, action?: string) => ({
  id,
  ...(action === undefined ? {} : { action }),
  criterion: "ARK-900-AC1",
  level: "integration",
  given: [],
  when: ["run it"],
  // oxlint-disable-next-line unicorn/no-thenable -- plan test-case field `then: string[]`, not a Promise-like
  then: ["it works"],
  expected: "it works",
});

type Suite = Record<string, unknown>;
const bunSuite = (name: string, repo: string): Suite => ({
  name,
  level: "integration",
  repo,
  command: "true {report}",
  parser: "bun",
});

type Options = {
  /** Repos of the workspace, each holding `source()` and `notes.txt`. */
  repos?: string[];
  suites?: Suite[];
  /** Steps of the plan, each `[id, repo]`. */
  steps?: [string, string][];
  /** Ids that the checked plan lists in test_cases. */
  planned?: string[];
  /** The workspace repos get a bare origin, so a sync and a merge are possible. */
  origin?: boolean;
  /** Steps to start. */
  start?: string[];
};

type Run = {
  runId: string;
  directory: string;
  workspace: string;
  repoPaths: string[];
  worktree: (repo?: string) => string;
};

/** A building run with an approved plan, real worktrees and the named steps started. */
function openRun(options: Options = {}): Run {
  const repos = options.repos ?? ["."];
  const steps = options.steps ?? [["build", "."]];
  installFakeOrca();
  tempArkHome();
  const workspace = repos.includes(".") ? "" : mkdtempSync(join(tmpdir(), "ark-finish-workspace-"));
  // a file named for the repo gives each repo its own base commit, so one repo's base is unknown to another
  const filesOf = (repo: string) => ({
    [testFile]: source(),
    "notes.txt": "line\n",
    "README.md": "# fixture\n",
    "repo.txt": `${repo}\n`,
  });
  const repoPaths = repos.map((repo) => {
    if (repo === ".") return tempGitRepo(filesOf(repo));
    const path = join(workspace, repo);
    mkdirSync(dirname(path), { recursive: true });
    renameSync(tempGitRepo(filesOf(repo)), path);
    return path;
  });
  if (options.origin)
    for (const path of repoPaths) {
      const bare = mkdtempSync(join(tmpdir(), "ark-finish-origin-"));
      git(bare, "init", "-q", "--bare");
      git(path, "remote", "add", "origin", bare);
      git(path, "push", "-q", "-u", "origin", "main");
      git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
      git(path, "remote", "set-head", "origin", "main");
    }
  const projectDirectory = writeProject("demo", {
    workspace: repos.includes(".") ? repoPaths[0] : workspace,
    ticket_source: "local",
    suites: options.suites ?? [bunSuite("integration", ".")],
    roles: {
      implementer: { harness: "omp", model: "test" },
      validator: { harness: "omp", model: "test" },
      reviewer: { harness: "omp", model: "test" },
    },
  });
  const ticketFile = writeTicket("demo", "ARK-900", [{ id: "ARK-900-AC1", text: "Fixture works" }]);
  const runId = ark("run", "start", ticketFile, "--project", "demo").out.trim();
  const directory = join(projectDirectory, "runs", runId);
  recordEvaluation(directory);
  writeFileSync(
    join(directory, "plan.yml"),
    JSON.stringify({
      design: { interfaces: [{ name: "fixture plan", callers: ["ark run step"] }] },
      summary: {
        why: "Test the finish check.",
        changes: [{ criterion: "ARK-900-AC1", where: "tests", now: "a", fix: "b" }],
      },
      steps: steps.map(([id, repo]) => ({
        id,
        role: "implementer",
        repo,
        harness: "omp",
        model: "test",
        needs: [],
        criteria: ["ARK-900-AC1"],
      })),
      test_cases: (options.planned ?? ["ARK-T1"]).map((id) => testCase(id)),
    }),
  );
  for (const args of [
    ["plan", "check", runId],
    ["gate", "record", runId, "plan", "approve"],
    ["worktree", "create", runId, ...repos],
  ])
    expect(ark(...args).code, args.join(" ")).toBe(0);
  for (const id of options.start ?? steps.map(([stepId]) => stepId))
    expect(ark("run", "step", runId, id, "start").code, `start ${id}`).toBe(0);
  const worktree = (repo = ".") =>
    deriveState(readEvents(directory)).worktrees.find((entry) => entry.repo === repo)!.path;
  return { runId, directory, workspace, repoPaths, worktree };
}

/** Rewrites test_cases of the approved plan.yml; the finish check reads the file, not the plan hash. */
function setTestCases(directory: string, entries: [string, string][]): void {
  const file = join(directory, "plan.yml");
  const plan = JSON.parse(readFileSync(file, "utf8"));
  plan.test_cases = entries.map(([id, action]) => testCase(id, action));
  writeFileSync(file, JSON.stringify(plan));
}

const finishedEvents = (directory: string) =>
  readEvents(directory).filter((event) => event.type === "step.finished");
const stepStatus = (directory: string, step: string) =>
  deriveState(readEvents(directory)).steps.find((entry) => entry.id === step)?.status;
const unlistedLine = (id: string) => `case id not in plan test_cases: ${id} in ${testFile}`;

// Each refusal below is made so that every other rule accepts it: the worktree is clean, the step is an implementer
// step with no --failed and no --merge, and the plan is readable. Deleting the plan-membership call of runStep, the
// `!failed` guard or the `started.merge` guard turns the matching test red.
test("ARK-T671 finishing an implementer step is refused when the run's diff changes a test whose case id the plan test_cases does not list, and the message names the ids and the ark plan hint", () => {
  const { runId, directory, worktree } = openRun();
  commitFiles(worktree(), { [testFile]: source({ "ARK-T1": 2, "ARK-T2": 2, "ARK-T3": 2 }) });
  const before = readEvents(directory);

  const refused = ark("run", "step", runId, "build", "finish");
  expect(refused.code).toBe(1);
  const output = refused.out + refused.err;
  expect(output).toContain(unlistedLine("ARK-T2"));
  expect(output).toContain(unlistedLine("ARK-T3"));
  expect(output).not.toMatch(/not in plan test_cases: ARK-T(1|9) /);
  expect(output).toContain(`ark plan check ${runId}`);
  expect(output).toContain("add each id to test_cases");
  expect(readEvents(directory)).toEqual(before);
  expect(stepStatus(directory, "build")).toBe("running");
});

test("ARK-T672 finishing an implementer step succeeds when every case id in the run's touched tests is listed in the plan test_cases, and when the diff touches no case id", () => {
  // Variant A: every action passes, an untouched listed id and a new test cause no refusal.
  const listed = openRun();
  setTestCases(listed.directory, [
    ["ARK-T1", "update"],
    ["ARK-T2", "reuse"],
    ["ARK-T3", "retire"],
    ["ARK-T4", "add"],
    ["ARK-T9", "reuse"],
  ]);
  commitFiles(listed.worktree(), {
    [testFile]: source({ "ARK-T1": 2, "ARK-T2": 2, "ARK-T3": 2 }, ["ARK-T4"]),
  });
  const passed = ark("run", "step", listed.runId, "build", "finish");
  expect(passed.code, passed.err).toBe(0);
  expect(passed.out + passed.err).not.toContain("not in plan test_cases");
  expect(finishedEvents(listed.directory)).toHaveLength(1);

  // Variant B: a changed test with no case id and a plan with no test_cases.
  const idless = openRun();
  setTestCases(idless.directory, []);
  commitFiles(idless.worktree(), {
    [testFile]: `${source()}test("plain title", () => {\n  const value = 1;\n});\n`,
  });
  const plain = ark("run", "step", idless.runId, "build", "finish");
  expect(plain.code, plain.err).toBe(0);
  expect(plain.out + plain.err).not.toContain("not in plan test_cases");
  expect(finishedEvents(idless.directory)).toHaveLength(1);

  // Variant C: a case id written in a non-test file is not a touched test.
  const prose = openRun();
  commitFiles(prose.worktree(), { "README.md": "# fixture\n\nsee ARK-T2\n" });
  const readme = ark("run", "step", prose.runId, "build", "finish");
  expect(readme.code, readme.err).toBe(0);
  expect(readme.out + readme.err).not.toContain("ARK-T2");
  expect(finishedEvents(prose.directory)).toHaveLength(1);
});

test("ARK-T673 finish --failed and finish --failed --not-started of an implementer step are not refused when the diff touches an unlisted case id", () => {
  const { runId, directory, worktree } = openRun({
    steps: [
      ["build", "."],
      ["other", "."],
    ],
  });
  commitFiles(worktree(), { [testFile]: source({ "ARK-T2": 2 }) });
  // control: the same diff refuses an ordinary finish, so the two passes below prove the --failed guard
  expect(ark("run", "step", runId, "build", "finish").code).toBe(1);
  expect(finishedEvents(directory)).toHaveLength(0);

  const failed = ark("run", "step", runId, "build", "finish", "--failed");
  expect(failed.code, failed.err).toBe(0);
  const notStarted = ark("run", "step", runId, "other", "finish", "--failed", "--not-started");
  expect(notStarted.code, notStarted.err).toBe(0);
  expect(failed.out + failed.err + notStarted.out + notStarted.err).not.toContain(
    "not in plan test_cases",
  );
  expect(finishedEvents(directory).map((event) => event.data)).toEqual([
    expect.objectContaining({ step: "build", outcome: "failed" }),
    expect.objectContaining({ step: "other", outcome: "failed", not_started: true }),
  ]);
});

/** A bare origin clone that commits `files` on main and pushes; returns the new tip. */
function advanceOrigin(repoPath: string, files: Record<string, string>): string {
  const clone = mkdtempSync(join(tmpdir(), "ark-finish-clone-"));
  git(clone, "clone", "-q", git(repoPath, "remote", "get-url", "origin"), ".");
  commitFiles(clone, files);
  git(clone, "push", "-q", "origin", "main");
  return git(clone, "rev-parse", "HEAD");
}

test("ARK-T674 finishing an implementer step that started with --merge skips the plan membership check, so main's test changes are not refused", () => {
  // Run 1: an own commit and origin both edit notes.txt, so the sync conflicts and --merge is allowed.
  const conflicted = openRun({ origin: true, start: [] });
  commitFiles(conflicted.worktree(), { "notes.txt": "own\n" });
  const tip = advanceOrigin(conflicted.repoPaths[0], {
    "notes.txt": "target\n",
    [testFile]: source({ "ARK-T9": 2 }),
  });
  expect(ark("worktree", "sync", conflicted.runId).code).toBe(1);
  const started = ark("run", "step", conflicted.runId, "build", "start", "--merge");
  expect(started.code, started.err).toBe(0);
  const worktree = conflicted.worktree();
  git(worktree, "fetch", "-q", "origin");
  expect(Bun.spawnSync(["git", "-C", worktree, "merge", "origin/main"]).exitCode).not.toBe(0);
  commitFiles(worktree, { "notes.txt": "resolved\n" });

  const merged = ark("run", "step", conflicted.runId, "build", "finish");
  expect(merged.code, merged.err).toBe(0);
  expect(merged.out + merged.err).not.toContain("plan-membership");
  expect(merged.out + merged.err).not.toContain("not in plan test_cases");
  expect(finishedEvents(conflicted.directory)).toHaveLength(1);
  const synced = readEvents(conflicted.directory).findLast(
    (event) => event.type === "worktree.synced",
  );
  expect(synced?.data).toMatchObject({ conflict: false, target_commit: tip });

  // Run 2: the same merged diff on a step that started without --merge is refused for ARK-T9.
  const clean = openRun({ origin: true });
  commitFiles(clean.worktree(), { "README.md": "# own\n" });
  advanceOrigin(clean.repoPaths[0], {
    "notes.txt": "target\n",
    [testFile]: source({ "ARK-T9": 2 }),
  });
  git(clean.worktree(), "fetch", "-q", "origin");
  git(clean.worktree(), "merge", "-q", "--no-edit", "origin/main");
  const refused = ark("run", "step", clean.runId, "build", "finish");
  expect(refused.code).toBe(1);
  expect(refused.out + refused.err).toContain(unlistedLine("ARK-T9"));
  expect(finishedEvents(clean.directory)).toHaveLength(0);
});

test("ARK-T675 finishing an implementer step with a missing or invalid plan.yml, or a plan that lists no test_cases, prints a skip line and finishes", () => {
  const skipLine = /plan-membership check {2}skipped {2}\(/;
  const variants: [string, (run: Run) => void][] = [
    ["missing", (run) => rmSync(join(run.directory, "plan.yml"))],
    ["not YAML", (run) => writeFileSync(join(run.directory, "plan.yml"), "steps: [unclosed\n")],
    [
      "old steps field",
      (run) => {
        const file = join(run.directory, "plan.yml");
        const plan = JSON.parse(readFileSync(file, "utf8"));
        plan.test_cases = [{ ...testCase("ARK-T1"), steps: ["old"] }];
        writeFileSync(file, JSON.stringify(plan));
      },
    ],
    [
      "human take_over",
      (run) => {
        // two failed rounds spend the budget; the human takes over and the restarted step has no worker
        expect(ark("run", "step", run.runId, "build", "finish", "--failed").code).toBe(0);
        expect(ark("run", "step", run.runId, "build", "start").code).toBe(0);
        expect(ark("run", "step", run.runId, "build", "finish", "--failed").code).toBe(0);
        expect(ark("escalate", run.runId, "--reason", "stuck").code).toBe(0);
        expect(ark("gate", "record", run.runId, "escalation", "take_over").code).toBe(0);
        expect(ark("run", "step", run.runId, "build", "start").code).toBe(0);
        rmSync(join(run.directory, "plan.yml"));
      },
    ],
  ];
  for (const [name, breakPlan] of variants) {
    const run = openRun();
    breakPlan(run);
    commitFiles(run.worktree(), { [testFile]: source({ "ARK-T2": 2 }) });
    const finished = ark("run", "step", run.runId, "build", "finish");
    expect(finished.code, `${name}: ${finished.err}`).toBe(0);
    expect(finished.out.match(skipLine), name).not.toBeNull();
    expect(finished.out.match(/plan-membership check/g), name).toHaveLength(1);
    expect(finished.out + finished.err, name).not.toContain("not in plan test_cases");
    expect(finished.err, name).not.toContain("    at ");
    // the take_over variant also holds its two failed finishes
    expect(
      finishedEvents(run.directory).filter((event) => event.data.outcome === "succeeded"),
      name,
    ).toHaveLength(1);
  }

  // A valid plan with no test_cases is an empty set, not a skip.
  const empty = openRun();
  setTestCases(empty.directory, []);
  commitFiles(empty.worktree(), { [testFile]: source({ "ARK-T2": 2 }) });
  const refused = ark("run", "step", empty.runId, "build", "finish");
  expect(refused.code).toBe(1);
  expect(refused.out + refused.err).toContain(unlistedLine("ARK-T2"));
  expect(refused.out + refused.err).toContain(`ark plan check ${empty.runId}`);
  expect(finishedEvents(empty.directory)).toHaveLength(0);
});

test("ARK-T676 implementer finish skips with a printed line when the scan fails, and scans only the bun suites of the step's repo that has a base commit", () => {
  const suites = [
    bunSuite("unit-a", "repos/a"),
    { ...bunSuite("py", "repos/a"), parser: "pytest" },
    bunSuite("unit-b", "repos/b"),
  ];
  const options: Options = {
    repos: ["repos/a", "repos/b"],
    suites,
    steps: [["build-a", "repos/a"]],
    planned: ["ARK-T1"],
  };
  const open = () => {
    const run = openRun(options);
    // repo B holds an unlisted ARK-T2 edit; repo A's own commit touches no case id
    commitFiles(run.worktree("repos/b"), { [testFile]: source({ "ARK-T2": 2 }) });
    commitFiles(run.worktree("repos/a"), { "notes.txt": "own\n" });
    return run;
  };
  const quiet = (output: string) => {
    expect(output).not.toContain("ARK-T2");
    expect(output).not.toContain("skipped");
    expect(output).not.toContain("pytest");
  };

  // The suites of repo B and the pytest suite print nothing and refuse nothing.
  const scoped = open();
  const first = ark("run", "step", scoped.runId, "build-a", "finish");
  expect(first.code, first.err).toBe(0);
  quiet(first.out + first.err);
  expect(finishedEvents(scoped.directory)).toHaveLength(1);

  // A repo with no base commit has nothing to scan.
  const noBase = open();
  const created = deriveState(readEvents(noBase.directory)).worktrees.find(
    (entry) => entry.repo === "repos/a",
  )!;
  appendEvent(noBase.directory, "worktree.created", {
    repo: "repos/a",
    path: created.path,
    branch: created.branch,
  });
  const second = ark("run", "step", noBase.runId, "build-a", "finish");
  expect(second.code, second.err).toBe(0);
  quiet(second.out + second.err);
  expect(finishedEvents(noBase.directory)).toHaveLength(1);

  // A base commit that is not in the repo fails the scan: a printed skip, no refusal, no stack trace.
  const broken = open();
  appendEvent(broken.directory, "worktree.synced", {
    repo: "repos/a",
    conflict: false,
    target_commit: "0123456789abcdef0123456789abcdef01234567",
  });
  const third = ark("run", "step", broken.runId, "build-a", "finish");
  expect(third.code, third.err).toBe(0);
  expect(third.out).toMatch(/plan-membership suite unit-a \(bun\) {2}skipped {2}\(scan failed: /);
  // Only the bun suite of the step repo is scanned: no line for the pytest suite or repo B's suite.
  expect(third.out + third.err).not.toContain("unit-b");
  expect(third.out + third.err).not.toContain("suite py");
  expect(third.err).not.toContain("    at ");
  expect(finishedEvents(broken.directory)).toHaveLength(1);
});
