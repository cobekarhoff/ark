import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendEvent, deriveState, readEvents } from "../cli/events.ts";
import { buildLedger } from "../skills/pr-writing/lib/ledger.ts";
import { lintBody } from "../skills/pr-writing/lib/lint.ts";
import {
  ark,
  recordEvaluation,
  tempArkHome,
  tempGitRepo,
  writeEvidenceFile,
  writeProject,
  writeTicket,
} from "./helpers.ts";
import {
  macOnly,
  recordStartedRun,
  proveFixtureSkipsMemoryWait,
  stopStartedRuns,
} from "./orphan-runners.ts";

// ARK-389: every test runs real `ark test` calls on real git repos and real `bun test` suites, at base and at head.
setDefaultTimeout(120_000);

// ARK-419: no test-runner of a run this file started outlives its test.
afterEach(stopStartedRuns);

const reportFlags = "--reporter=junit --reporter-outfile={report}";
const roles = {
  implementer: { harness: "claude", model: "claude-sonnet" },
  validator: { harness: "codex", model: "gpt-codex" },
  reviewer: { harness: "codex", model: "gpt-codex" },
};

type SuiteConfig = {
  name: string;
  level: string;
  repo: string;
  command: string;
  parser: "bun";
  base_files?: string;
  base_command?: string;
  changed_command?: string;
  paths?: string[];
};

/** A suite over the test files of `folder`: its base command runs a list of files. */
const suiteOf = (name: string, folder: string, extra: Partial<SuiteConfig> = {}): SuiteConfig => ({
  name,
  level: "integration",
  repo: ".",
  command: `bun test ./${folder} ${reportFlags}`,
  parser: "bun",
  base_files: `${folder}/**/*.test.ts`,
  base_command: `bun test {files} ${reportFlags}`,
  ...extra,
});

function git(directory: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", directory, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed in ${directory}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** Writes `files` (a null value deletes the file) and commits them in `directory`. */
function commit(directory: string, message: string, files: Record<string, string | null>): void {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) rmSync(join(directory, path));
    else {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), content);
    }
  }
  git(directory, "add", "-A");
  git(directory, "commit", "-q", "-m", message);
}

/**
 * Test files that record which checkout ran them: each appends `<base|head> <folder>/<file>` to one marker file,
 * so the test reads from disk which files each side ran. `base` is the commit written to `baseShaFile`.
 */
type Fixture = {
  directory: string;
  testFile: (names: string[], fails?: boolean, revision?: number) => string;
  recordBase: (workspace: string) => void;
  ran: () => string[];
  clear: () => void;
};

function markerFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "selection-"));
  const marker = join(directory, "marker.txt");
  const baseShaFile = join(directory, "base-sha.txt");
  return {
    directory,
    /** Each name is a test whose title starts with a case ID; `fails` makes them fail on every checkout. */
    testFile: (names: string[], fails = false, revision = 0) =>
      [
        'import { appendFileSync, readFileSync } from "node:fs";',
        'import { expect, test } from "bun:test";',
        'const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();',
        `const side = sha === readFileSync(${JSON.stringify(baseShaFile)}, "utf8").trim() ? "base" : "head";`,
        `appendFileSync(${JSON.stringify(marker)}, side + " " + import.meta.path.split("/").slice(-2).join("/") + "\\n");`,
        ...names.map(
          (name) => `test(${JSON.stringify(name)}, () => { expect(${fails ? 1 : 2}).toBe(2); });`,
        ),
        `// revision ${revision}`,
        "",
      ].join("\n"),
    recordBase: (workspace: string) =>
      writeFileSync(baseShaFile, git(workspace, "rev-parse", "HEAD")),
    /** The lines the test files wrote, in a stable order. */
    ran: () =>
      existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean).toSorted() : [],
    clear: () => rmSync(marker, { force: true }),
  };
}

/**
 * Starts a run at the building phase on `workspace`: an AC with `method: test` verified by `cases`, an approved plan and
 * a worktree for each of `repos` (default the one repo "."; else folders of the workspace, the first holds the plan step).
 * `forge` gives each of those repos an origin whose pushes go to a local bare repo. `action` is the plan `test_cases`
 * action of each case (default `add`), `generated` the `generated` list of ark.yml (default none) and `manualAc` adds a
 * second AC with `manual: true`.
 */
function startRun(options: {
  workspace: string;
  suites: SuiteConfig[];
  cases: string[];
  kind?: string;
  forge?: boolean;
  checks?: { name: string; repo: string; command: string }[];
  setup?: string;
  action?: string;
  /** The plan `test_cases` as written, in place of one entry of `action` for each of `cases`. */
  planCases?: Record<string, unknown>[];
  generated?: { path: string; command: string }[];
  repos?: string[];
  manualAc?: boolean;
}): { runId: string; runDirectory: string; mirror: string; mirrors: Record<string, string> } {
  const arkHome = tempArkHome();
  const repos = options.repos ?? ["."];
  const repoPath = (repo: string) =>
    repo === "." ? options.workspace : join(options.workspace, repo);
  if (options.forge) {
    for (const repo of repos) {
      const name = repo === "." ? "core" : repo;
      const bare = join(
        mkdtempSync(join(tmpdir(), "ark-origin-")),
        "github.com",
        "org",
        `${name}.git`,
      );
      mkdirSync(bare, { recursive: true });
      git(bare, "init", "--bare", "-q");
      git(repoPath(repo), "remote", "add", "origin", bare);
      git(repoPath(repo), "push", "origin", "HEAD:refs/heads/main");
      git(repoPath(repo), "remote", "set-head", "origin", "main");
    }
  }
  writeProject("demo", {
    workspace: options.workspace,
    ticket_source: "local",
    test_min_free_memory_percent: 0,
    test_max_swap_gb: 1000,
    ...(options.setup === undefined ? {} : { setup: options.setup }),
    ...(options.checks === undefined ? {} : { checks: options.checks }),
    ...(options.generated === undefined ? {} : { generated: options.generated }),
    suites: options.suites,
    roles,
  });
  const ticket = writeTicket(
    "demo",
    "FAKE-1",
    [
      // With no case to verify it, AC1 is an inspection AC: plan check refuses a test AC with no integration case.
      {
        id: "AC1",
        text: "criterion AC1",
        method: options.cases.length === 0 ? "inspection" : "test",
        verified_by: options.cases,
      },
      ...(options.manualAc
        ? [{ id: "AC2", text: "criterion AC2", method: "demonstration", manual: true }]
        : []),
    ],
    "Ticket FAKE-1",
    options.kind,
  );
  const runId = ark("run", "start", ticket, "--project", "demo").out.match(
    /\d{4}-\d{2}-\d{2}-FAKE-1-\d+/,
  )![0];
  const runDirectory = join(arkHome, "projects", "demo", "runs", runId);
  recordStartedRun({ runId, runDirectory });
  recordEvaluation(runDirectory);
  const criteria = ["FAKE-1/AC1", ...(options.manualAc ? ["FAKE-1/AC2"] : [])];
  writeFileSync(
    join(runDirectory, "plan.yml"),
    JSON.stringify({
      design: { interfaces: [{ name: "fixture plan", callers: ["ark test"] }] },
      summary: {
        why: "Test the run.",
        changes: criteria.map((criterion) => ({
          criterion,
          where: "tests",
          now: "None.",
          fix: "A test checks.",
        })),
      },
      steps: [
        {
          id: "build",
          role: "implementer",
          repo: repos[0],
          harness: "claude",
          model: "claude-sonnet",
          needs: [],
          criteria,
        },
      ],
      test_cases:
        options.planCases ??
        options.cases.map((id) => ({
          id,
          action: options.action ?? "add",
          level: "integration",
          given: [],
          when: ["run it"],
          // oxlint-disable-next-line unicorn/no-thenable -- plan test-case field `then: string[]`, not a Promise-like
          then: ["it works"],
          expected: "it works",
        })),
    }),
  );
  for (const args of [
    ["plan", "check", runId],
    ["gate", "record", runId, "plan", "approve"],
    ["worktree", "create", runId, ...repos],
  ]) {
    const result = ark(...args);
    if (result.code !== 0) throw new Error(`${args.join(" ")} failed: ${result.err}${result.out}`);
  }
  const mirrors = Object.fromEntries(
    repos.map((repo) => [
      repo,
      repo === "." ? join(runDirectory, "workspace") : join(runDirectory, "workspace", repo),
    ]),
  );
  return { runId, runDirectory, mirror: mirrors[repos[0]!]!, mirrors };
}

const readResult = (runDirectory: string, id: string, side: "base" | "head") =>
  JSON.parse(readFileSync(join(runDirectory, "results/evidence", id, side, "result.json"), "utf8"));

function events(runDirectory: string, type: string) {
  return readFileSync(join(runDirectory, "events.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.type === type)
    .map((event) => event.data);
}

/** The repo of a run with `test/<name>.test.ts` files in `files` (case names) and a first commit recorded as the base. */
function repoWith(fixture: Fixture, files: Record<string, string[]>): string {
  const workspace = tempGitRepo(
    Object.fromEntries(
      Object.entries(files).map(([path, names]) => [path, fixture.testFile(names)]),
    ),
  );
  fixture.recordBase(workspace);
  return workspace;
}

describe("ark test base selection", () => {
  test("ARK-T119 ARK-389/AC1 a feature run runs at the base only the test files of its own commits, ignores merge-in files, and shows an unrun head case as not run at base", () => {
    const fixture = markerFixture();
    const setupLog = join(fixture.directory, "setup.log");
    const workspace = repoWith(fixture, {
      "test/untouched.test.ts": ["FAKE-T4 untouched"],
      "e2e/pw.test.ts": ["FAKE-T5 pw"],
    });
    const run = startRun({
      workspace,
      suites: [suiteOf("cli", "test"), suiteOf("pw", "e2e")],
      cases: ["FAKE-T1", "FAKE-T3"],
      setup: `pwd -P >> ${setupLog}`,
    });
    // Own commits: add a test, add one and delete it. Main then gains a test, and the branch merges main.
    commit(run.mirror, "own test", { "test/own.test.ts": fixture.testFile(["FAKE-T1 own"]) });
    commit(run.mirror, "temporary test", {
      "test/gone.test.ts": fixture.testFile(["FAKE-T2 gone"]),
    });
    commit(run.mirror, "drop it", { "test/gone.test.ts": null });
    commit(workspace, "main gains a test", {
      "test/main-only.test.ts": fixture.testFile(["FAKE-T3 main only"]),
    });
    git(run.mirror, "merge", "-q", "--no-edit", "main");
    fixture.clear();

    const result = ark("test", run.runId);
    expect(result.code, result.err + result.out).toBe(0);
    expect(fixture.ran().filter((line) => line.startsWith("base "))).toEqual([
      "base test/own.test.ts",
    ]);
    expect(fixture.ran().filter((line) => line.startsWith("head "))).toEqual([
      "head e2e/pw.test.ts",
      "head test/main-only.test.ts",
      "head test/own.test.ts",
      "head test/untouched.test.ts",
    ]);
    expect(result.out).toContain("pw base  skipped  (no changed test file)");
    expect(readResult(run.runDirectory, "FAKE-T1", "head").status).toBe("passed");
    expect(readResult(run.runDirectory, "FAKE-T1", "base").status).toBe("passed");
    for (const id of ["FAKE-T3", "FAKE-T4", "FAKE-T5"]) {
      expect(readResult(run.runDirectory, id, "head").status).toBe("passed");
      expect(readResult(run.runDirectory, id, "base").status, id).toBe("not run");
    }
    expect("base_passed" in events(run.runDirectory, "test.completed")[0]).toBe(false);
  });

  test("ARK-T119 ARK-389/AC1 a run with no changed test file makes no base checkout and runs no base setup", () => {
    const fixture = markerFixture();
    const setupLog = join(fixture.directory, "setup.log");
    const workspace = repoWith(fixture, { "test/untouched.test.ts": ["FAKE-T1 untouched"] });
    const run = startRun({
      workspace,
      suites: [suiteOf("cli", "test"), suiteOf("pw", "test")],
      cases: ["FAKE-T1"],
      setup: `pwd -P >> ${setupLog}`,
    });
    commit(run.mirror, "source only", { "src/a.ts": "export const a = 1;\n" });
    fixture.clear();

    const result = ark("test", run.runId);
    expect(result.code, result.err + result.out).toBe(0);
    expect(result.out).toContain("cli base  skipped  (no changed test file)");
    expect(result.out).toContain("pw base  skipped  (no changed test file)");
    expect(fixture.ran().filter((line) => line.startsWith("base "))).toEqual([]);
    // `setup` ran once, in the run's worktree, at `worktree create`: a base checkout would run it in a temp folder.
    const setupFolders = readFileSync(setupLog, "utf8").split("\n").filter(Boolean);
    expect(setupFolders).toEqual([realpathSync(run.mirror)]);
  });

  test("ARK-T122 ARK-389/AC1 a refactor run still runs the whole suite at the base, and a case that failed there reads failed", () => {
    const fixture = markerFixture();
    const workspace = tempGitRepo({
      "test/a.test.ts": fixture.testFile(["FAKE-T1 passes"]),
      "test/b.test.ts": fixture.testFile(["FAKE-T2 fails everywhere"], true),
    });
    fixture.recordBase(workspace);
    const run = startRun({
      workspace,
      suites: [suiteOf("cli", "test")],
      cases: ["FAKE-T1"],
      kind: "refactor",
    });
    commit(run.mirror, "change a", {
      "test/a.test.ts": fixture.testFile(["FAKE-T1 passes"], false, 1),
    });
    fixture.clear();

    ark("test", run.runId);
    expect(events(run.runDirectory, "test.completed")[0].base_passed).toBe(false);
    expect(readResult(run.runDirectory, "FAKE-T1", "base").status).toBe("passed");
    expect(readResult(run.runDirectory, "FAKE-T2", "base").status).toBe("failed");
  });

  test("ARK-T122 ARK-389/AC1 a refactor run copies an added test outside test/ to the base, where it runs with the whole suite", () => {
    const fixture = markerFixture();
    const workspace = repoWith(fixture, { "e2e/old.test.ts": ["FAKE-T2 old"] });
    const run = startRun({
      workspace,
      suites: [suiteOf("pw", "e2e")],
      cases: ["FAKE-T1"],
      kind: "refactor",
    });
    commit(run.mirror, "add e2e test", { "e2e/new.test.ts": fixture.testFile(["FAKE-T1 new"]) });
    fixture.clear();

    const result = ark("test", run.runId);
    expect(result.code, result.err + result.out).toBe(0);
    expect([...new Set(fixture.ran().filter((line) => line.startsWith("base ")))].sort()).toEqual([
      "base e2e/new.test.ts",
      "base e2e/old.test.ts",
    ]);
    expect(readResult(run.runDirectory, "FAKE-T1", "base").status).toBe("passed");
  });
});

describe("ark test suite paths and quick mode", () => {
  const skipReason = "diff touches none of: hub/, package.json";
  const bothTests = (fixture: Fixture) => ({
    "test/cli.test.ts": fixture.testFile(["FAKE-T9 cli"]),
    "e2e/pw.test.ts": fixture.testFile(["FAKE-T2 pw"]),
  });

  type PathsRun = {
    fixture: Fixture;
    workspace: string;
    runId: string;
    runDirectory: string;
    mirror: string;
  };

  /** Two suites on one repo: `cli` has no paths, `pw` lists `paths`. The AC is served by the case of the `pw` suite. */
  function pathsRun(): PathsRun {
    const fixture = markerFixture();
    const workspace = repoWith(fixture, {
      "test/existing.test.ts": ["FAKE-T8 existing cli", "FAKE-T9 existing cli"],
      "e2e/existing.test.ts": ["FAKE-T2 existing pw"],
    });
    const run = startRun({
      workspace,
      suites: [suiteOf("cli", "test"), suiteOf("pw", "e2e", { paths: ["hub/", "package.json"] })],
      cases: ["FAKE-T2", "FAKE-T9"],
    });
    return { fixture, workspace, ...run };
  }

  const quickOn = (change: (run: PathsRun) => void) => {
    const run = pathsRun();
    change(run);
    run.fixture.clear();
    return { ...run, result: ark("test", run.runId, "--quick") };
  };

  test("ARK-T120 ARK-389/AC2 a quick run runs a suite when the diff touches one of its paths", () => {
    const run = quickOn(({ fixture, mirror }) => {
      commit(mirror, "tests", bothTests(fixture));
      commit(mirror, "hub", { "hub/app.ts": "export {};\n" });
    });
    expect(run.result.code, run.result.err + run.result.out).toBe(0);
    expect(run.fixture.ran()).toEqual(["head e2e/pw.test.ts", "head test/cli.test.ts"]);
    expect(run.result.out).not.toContain("skipped  (");
  });

  test("ARK-T120 ARK-389/AC2 a quick run skips a suite whose paths the diff does not touch, prints the reason, and the AC it alone serves reads not run", () => {
    const run = quickOn(({ fixture, mirror }) => {
      commit(mirror, "tests", bothTests(fixture));
      commit(mirror, "docs", { "docs/x.md": "x\n" });
    });
    expect(run.result.code, run.result.err + run.result.out).toBe(0);
    expect(run.fixture.ran()).toEqual(["head test/cli.test.ts"]);
    expect(run.result.out).toContain(`pw head  skipped  (${skipReason})`);
    expect(events(run.runDirectory, "test.completed")[0].criteria).toEqual({
      "FAKE-1/AC1": "not run",
    });
  });

  test("ARK-T120 ARK-389/AC2 a file that main brought into the merged branch counts for paths, and a folder that shares only the prefix does not", () => {
    const merged = quickOn(({ fixture, mirror, workspace }) => {
      commit(mirror, "tests", bothTests(fixture));
      commit(workspace, "main gains a hub file", { "hub/main.ts": "export {};\n" });
      git(mirror, "merge", "-q", "--no-edit", "main");
    });
    expect(merged.result.code, merged.result.err + merged.result.out).toBe(0);
    expect(merged.fixture.ran()).toEqual(["head e2e/pw.test.ts", "head test/cli.test.ts"]);

    const prefix = quickOn(({ fixture, mirror }) => {
      commit(mirror, "tests", bothTests(fixture));
      commit(mirror, "hubble", { "hubble/x.ts": "export {};\n" });
    });
    expect(prefix.result.code, prefix.result.err + prefix.result.out).toBe(0);
    expect(prefix.fixture.ran()).toEqual(["head test/cli.test.ts"]);
    expect(prefix.result.out).toContain(`pw head  skipped  (${skipReason})`);
  });

  test("ARK-T120 ARK-389/AC2 a full run ignores paths and runs every suite on a docs-only diff", () => {
    const run = pathsRun();
    commit(run.mirror, "docs", { "docs/x.md": "x\n" });
    run.fixture.clear();
    const result = ark("test", run.runId);
    expect(result.code, result.err + result.out).toBe(0);
    expect(run.fixture.ran()).toEqual(["head e2e/existing.test.ts", "head test/existing.test.ts"]);
    expect(result.out).not.toContain("head  skipped");
    expect(events(run.runDirectory, "test.completed")[0].criteria).toEqual({
      "FAKE-1/AC1": "passing",
    });
  });
});

describe("ark test quick mode gates", () => {
  const fakeForge = join(import.meta.dir, "fixtures/merge-request");

  /** A run whose repo has a fake forge. The unchanged test fails in `breaks` runs, as a source change could break it. */
  function gateRun(breaks = false) {
    process.env.PATH = `${fakeForge}:${(process.env.PATH ?? "")
      .split(":")
      .filter((entry) => entry !== fakeForge)
      .join(":")}`;
    process.env.FAKE_LOG = join(mkdtempSync(join(tmpdir(), "ark-fake-log-")), "calls.ndjson");
    const fixture = markerFixture();
    const workspace = tempGitRepo({
      "test/untouched.test.ts": fixture.testFile(["FAKE-T2 untouched"], breaks),
    });
    fixture.recordBase(workspace);
    const run = startRun({
      workspace,
      suites: [suiteOf("cli", "test")],
      cases: ["FAKE-T1"],
      forge: true,
    });
    commit(run.mirror, "own test", { "test/own.test.ts": fixture.testFile(["FAKE-T1 own"]) });
    fixture.clear();
    return { fixture, ...run };
  }

  const mergeRequestsOpened = (runDirectory: string) =>
    events(runDirectory, "merge_request.opened").length;
  const closed = (runDirectory: string) => events(runDirectory, "run.closed");

  test("ARK-T121 ARK-389/AC3 a quick run runs the changed files at head only, passes though an unchanged test breaks, and is no gate for merge-request open or a handed_off close", () => {
    const run = gateRun(true);
    const quick = ark("test", run.runId, "--quick");
    expect(quick.code, quick.err + quick.out).toBe(0);
    // One run of the own file: no base run, no whole-suite head run.
    expect(run.fixture.ran()).toEqual(["head test/own.test.ts"]);
    expect(quick.out).toContain("not a gate");
    expect(events(run.runDirectory, "test.completed")[0]).toMatchObject({
      mode: "quick",
      passed: true,
    });

    const opened = ark("merge-request", "open", run.runId);
    expect(opened.code).toBe(1);
    expect(opened.err).toContain("quick");
    expect(opened.err).toContain(`ark test ${run.runId}`);
    const handedOff = ark("run", "close", run.runId, "handed_off");
    expect(handedOff.code).toBe(1);
    expect(handedOff.err).toContain("quick");
    expect(handedOff.err).toContain(`ark test ${run.runId}`);
    expect(mergeRequestsOpened(run.runDirectory)).toBe(0);
    expect(closed(run.runDirectory)).toEqual([]);
  });

  test("ARK-T121 ARK-389/AC3 a full run at the current head runs every head test, opens the MR and closes the run handed_off", () => {
    const forMergeRequest = gateRun();
    const full = ark("test", forMergeRequest.runId);
    expect(full.code, full.err + full.out).toBe(0);
    expect(forMergeRequest.fixture.ran()).toEqual([
      "base test/own.test.ts",
      "head test/own.test.ts",
      "head test/untouched.test.ts",
    ]);
    expect(events(forMergeRequest.runDirectory, "test.completed")[0].mode).toBe("full");
    const opened = ark("merge-request", "open", forMergeRequest.runId);
    expect(opened.code, opened.err + opened.out).toBe(0);
    expect(mergeRequestsOpened(forMergeRequest.runDirectory)).toBe(1);

    const forClose = gateRun();
    expect(ark("test", forClose.runId).code).toBe(0);
    const handedOff = ark("run", "close", forClose.runId, "handed_off");
    expect(handedOff.code, handedOff.err + handedOff.out).toBe(0);
    expect(closed(forClose.runDirectory)).toHaveLength(1);
  });

  test("ARK-T121 ARK-389/AC3 a full run followed by a new commit refuses both commands and names ark test", () => {
    const run = gateRun();
    expect(ark("test", run.runId).code).toBe(0);
    commit(run.mirror, "later commit", { "src/a.ts": "export const a = 1;\n" });
    for (const args of [
      ["merge-request", "open", run.runId],
      ["run", "close", run.runId, "handed_off"],
    ]) {
      const refused = ark(...args);
      expect(refused.code, args.join(" ")).toBe(1);
      expect(refused.err).toContain(`ark test ${run.runId}`);
    }
    expect(mergeRequestsOpened(run.runDirectory)).toBe(0);
    expect(closed(run.runDirectory)).toEqual([]);
  });

  test("ARK-T121 ARK-389/AC3 a test.completed event with no mode reads as a full run", () => {
    const run = gateRun();
    expect(ark("test", run.runId).code).toBe(0);
    // An old log predates `mode`: drop it from the only test.completed event.
    const eventsFile = join(run.runDirectory, "events.ndjson");
    const lines = readFileSync(eventsFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const logged = JSON.parse(line);
        if (logged.type === "test.completed") delete logged.data.mode;
        return JSON.stringify(logged);
      });
    writeFileSync(eventsFile, `${lines.join("\n")}\n`);
    expect("mode" in events(run.runDirectory, "test.completed")[0]).toBe(false);

    const opened = ark("merge-request", "open", run.runId);
    expect(opened.code, opened.err + opened.out).toBe(0);
    expect(mergeRequestsOpened(run.runDirectory)).toBe(1);
  });
});

// ARK-393: skipped and deleted tests of a run.
const aBase = `import { test } from "bun:test";
test("FAKE-T1 keeps", () => {});
test("to skip", () => {});
test("to delete", () => {});
test.skip("old skip", () => {});
`;
const aHead = `import { test } from "bun:test";
test("FAKE-T1 keeps", () => {});
test.skip("to skip", () => {});
test.skip("old skip", () => {});
`;
const bFile = `import { test } from "bun:test";
test("b passes", () => {});
test.skip("b skipped at base", () => {});
`;

/** Base: a.test.ts (1 skipped) and b.test.ts (1 skipped, unchanged by the run, so not in the base count). Head: `to skip` skipped, `to delete` removed, plus any `headFiles`. */
function skipDeleteRun(headFiles: Record<string, string | null> = {}) {
  const workspace = tempGitRepo({ "test/a.test.ts": aBase, "test/b.test.ts": bFile });
  const run = startRun({ workspace, suites: [suiteOf("cli", "test")], cases: ["FAKE-T1"] });
  commit(run.mirror, "skip one, delete one", { "test/a.test.ts": aHead, ...headFiles });
  return run;
}

describe("ark test skipped and deleted tests", () => {
  test("ARK-T199 ark test prints and records the skipped counts at head and base and the tests deleted against the base, and its exit code does not change", () => {
    const run = skipDeleteRun();
    const first = ark("test", run.runId);
    expect(first.code, first.err + first.out).toBe(0);
    const lines = first.out.split("\n");
    const tests = lines.indexOf("tests      2 passed, 3 skipped (base 1), 1 deleted");
    expect(tests).toBeGreaterThan(lines.findIndex((line) => line.startsWith("suite      cli")));
    expect(lines[tests + 1]).toBe("deleted    test/a.test.ts  to delete");
    expect(lines.filter((line) => line.startsWith("deleted "))).toHaveLength(1);
    const [event] = events(run.runDirectory, "test.completed");
    expect(event).toMatchObject({
      passed_count: 2,
      skipped: 3,
      base_skipped: 1,
      deleted: [{ file: "test/a.test.ts", name: "to delete" }],
    });

    // A rerun reuses the cached suites and reports the same counts.
    const again = ark("test", run.runId);
    expect(again.code, again.err + again.out).toBe(0);
    expect(again.out).toContain("reused");
    expect(again.out).toContain("tests      2 passed, 3 skipped (base 1), 1 deleted");
    expect(again.out).toContain("deleted    test/a.test.ts  to delete");
    expect(events(run.runDirectory, "test.completed")[1]).toMatchObject({
      skipped: 3,
      base_skipped: 1,
      deleted: [{ file: "test/a.test.ts", name: "to delete" }],
    });
  });

  test("ARK-T199 a suite with no base_files counts base skips and deleted tests from the pristine base, not from the head files copied into the base run", () => {
    const workspace = tempGitRepo({ "test/a.test.ts": aBase, "test/b.test.ts": bFile });
    const run = startRun({
      workspace,
      suites: [suiteOf("cli", "test", { base_files: undefined, base_command: undefined })],
      cases: ["FAKE-T1"],
    });
    commit(run.mirror, "skip one, delete one", { "test/a.test.ts": aHead });
    const result = ark("test", run.runId);
    expect(result.code, result.err + result.out).toBe(0);
    expect(result.out).toContain("tests      2 passed, 3 skipped (base 2), 1 deleted");
    expect(result.out).toContain("deleted    test/a.test.ts  to delete");
  });

  test("ARK-T199 a run with no changed test file prints no base fields and no deleted line, and a deleted file lists each of its tests sorted", () => {
    const clean = tempGitRepo({ "test/a.test.ts": aBase, "test/b.test.ts": bFile });
    const same = startRun({
      workspace: clean,
      suites: [suiteOf("cli", "test")],
      cases: ["FAKE-T1"],
    });
    commit(same.mirror, "source only", { "src/a.ts": "export const a = 1;\n" });
    const unchanged = ark("test", same.runId);
    expect(unchanged.code, unchanged.err + unchanged.out).toBe(0);
    expect(unchanged.out).toContain("tests      4 passed, 2 skipped\n");
    expect(unchanged.out).not.toContain("deleted    ");

    const run = skipDeleteRun({
      "test/b.test.ts": null,
      "test/c.test.ts": `import { test } from "bun:test";\ntest("c", () => {});\n`,
    });
    const result = ark("test", run.runId);
    expect(result.code, result.err + result.out).toBe(0);
    expect(result.out.split("\n").filter((line) => line.startsWith("deleted "))).toEqual([
      "deleted    test/a.test.ts  to delete",
      "deleted    test/b.test.ts  b passes",
      "deleted    test/b.test.ts  b skipped at base",
    ]);
  });

  test("ARK-T201 a quick ark test prints the skipped count at head only and leaves the base fields out of the event", () => {
    const run = skipDeleteRun();
    const result = ark("test", run.runId, "--quick");
    expect(result.code, result.err + result.out).toBe(0);
    expect(result.out).toContain("tests      1 passed, 2 skipped\n");
    expect(result.out).not.toContain("base 1");
    expect(result.out).not.toContain("deleted");
    const [event] = events(run.runDirectory, "test.completed");
    expect(event.mode).toBe("quick");
    expect(event).toMatchObject({ passed_count: 1, skipped: 2 });
    expect("base_skipped" in event).toBe(false);
    expect("deleted" in event).toBe(false);
  });
});

// ARK-419: the demo fixture of this suite ends no suite on a memory wait and leaves no runner behind.
const orphanFixture = {
  start: (body: string) =>
    startRun({
      workspace: tempGitRepo({
        "test/hold.test.ts": `import { test } from "bun:test";\ntest("FAKE-T1 holds", async () => { ${body} }, 400_000);\n`,
      }),
      suites: [suiteOf("cli", "test")],
      cases: ["FAKE-T1"],
    }),
};

macOnly(
  "ARK-T235 the demo fixture of this suite finishes with free memory and swap past the default limits",
  () => proveFixtureSkipsMemoryWait(orphanFixture),
  120_000,
);

describe("ark test pristine base duration of a refactor run", () => {
  type Completed = {
    suites: { name: string; passed: boolean; head_s?: number; pristine_s?: number }[];
  };

  /** A passing one-test file titled `title`; `body` runs first (at module load or in the test). */
  const passingFile = (title: string, prelude = "", work = "") =>
    [
      'import { appendFileSync } from "node:fs";',
      'import { expect, test } from "bun:test";',
      prelude,
      `test(${JSON.stringify(title)}, () => { ${work} expect(1).toBe(1); }, 30_000);`,
      "",
    ].join("\n");

  const wholeSuite = (name: string, file: string): SuiteConfig => ({
    name,
    level: "integration",
    repo: ".",
    command: `bun test ./test/${file} ${reportFlags}`,
    parser: "bun",
  });

  /**
   * Two suites. `slow` sleeps `sleepSeconds` (3 s) at the base commit and, once the run's own commit rewrites it, not at all (the refactor
   * makes the file faster); the base version also writes one line to a marker file each time it runs, so the marker
   * counts the pristine runs. `fast` never sleeps.
   */
  function pristineRun(kind: string, sleepSeconds = 3) {
    const directory = mkdtempSync(join(tmpdir(), "pristine-"));
    const marker = join(directory, "marker.txt");
    const slowAtBase = passingFile(
      "FAKE-T1 slow",
      `appendFileSync(${JSON.stringify(marker)}, "slow\\n");`,
      sleepSeconds > 0 ? `Bun.spawnSync(["sleep", "${sleepSeconds}"]);` : "",
    );
    const workspace = tempGitRepo({
      "test/slow.test.ts": slowAtBase,
      "test/fast.test.ts": passingFile("FAKE-T2 fast"),
    });
    const run = startRun({
      workspace,
      suites: [wholeSuite("slow", "slow.test.ts"), wholeSuite("fast", "fast.test.ts")],
      cases: ["FAKE-T1", "FAKE-T2"],
      kind,
    });
    commit(run.mirror, "make slow faster", {
      "test/slow.test.ts": passingFile("FAKE-T1 slow", "// no sleep"),
    });
    return {
      ...run,
      pristineRuns: () =>
        existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean).length : 0,
    };
  }

  const resourcesOf = (runDirectory: string) => {
    const path = join(runDirectory, "results", "resources.json");
    return existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as {
          suites?: Record<string, Record<string, Record<string, unknown>>>;
        })
      : {};
  };

  /** The head and pristine seconds that the suite line of `out` prints, or null when the line has none. */
  const printed = (out: string, name: string) => {
    const line = out.match(new RegExp(`^suite {6}${name} \\(integration\\) .*$`, "m"))![0];
    const found = line.match(/ {2}head ([\d.]+)s {2}pristine base ([\d.]+)s/);
    return found === null ? null : { head: Number(found[1]), pristine: Number(found[2]) };
  };

  const byName = (completed: Completed) =>
    Object.fromEntries(completed.suites.map((s) => [s.name, s]));

  test("ARK-T725 a full ark test of a refactor run records and prints the pristine base duration of each suite beside the head duration, and a rerun that replays the cached census still reports it", () => {
    const run = pristineRun("refactor");

    const first = ark("test", run.runId);
    expect(first.code, first.err + first.out).toBe(0);
    const [completed] = events(run.runDirectory, "test.completed") as Completed[];
    const { slow, fast } = byName(completed);
    for (const suite of [slow, fast]) {
      expect(typeof suite.head_s, `${suite.name} head_s`).toBe("number");
      expect(typeof suite.pristine_s, `${suite.name} pristine_s`).toBe("number");
    }
    // The refactor made slow faster by its 3 s sleep: its pristine time is above its head time by most of it. The other
    // suite did not change, so one wall time written to every suite fails here.
    expect(slow.pristine_s!).toBeGreaterThanOrEqual(slow.head_s! + 2);
    expect(fast.pristine_s!).toBeLessThan(fast.head_s! + 2);
    // The pristine file ran once, in the census; the base run holds the head's copy, which has no sleep and no marker.
    expect(run.pristineRuns()).toBe(1);

    const resources = resourcesOf(run.runDirectory).suites!;
    for (const suite of [slow, fast]) {
      const pristine = resources[suite.name]!.pristine!;
      expect(Math.abs((pristine.wall_s as number) - suite.pristine_s!)).toBeLessThanOrEqual(1);
      expect("peak_mb" in pristine || "cpu_s" in pristine).toBe(false);
      expect("peak_mb" in resources[suite.name]!.head!).toBe(true);
    }
    for (const suite of [slow, fast])
      expect(printed(first.out, suite.name), `${suite.name} line`).toEqual({
        head: suite.head_s!,
        pristine: suite.pristine_s!,
      });

    // Step 2: the census replays from the cache; the figure is the one the cache entry stored.
    const again = ark("test", run.runId);
    expect(again.code, again.err + again.out).toBe(0);
    expect(run.pristineRuns()).toBe(1);
    const rerun = byName((events(run.runDirectory, "test.completed") as Completed[])[1]!);
    for (const name of ["slow", "fast"]) {
      expect(rerun[name]!.pristine_s, `${name} replayed`).toBe(
        byName(completed)[name]!.pristine_s!,
      );
      expect(printed(again.out, name)!.pristine).toBe(byName(completed)[name]!.pristine_s!);
      expect(resourcesOf(run.runDirectory).suites![name]!.pristine).toEqual({
        wall_s: byName(completed)[name]!.pristine_s!,
      });
    }

    // Step 4: ark retro counts the CPU of the head and base sides only.
    expect(ark("retro", run.runId).code).toBe(0);
    const metrics = JSON.parse(readFileSync(join(run.runDirectory, "metrics.json"), "utf8"));
    const counted = Object.values(resourcesOf(run.runDirectory).suites!).flatMap((sides) =>
      ["head", "base"].map((side) => sides[side]!.cpu_s as number),
    );
    expect(counted.length).toBe(4);
    expect(metrics.resources.cpu_s).toBeCloseTo(
      counted.reduce((sum, cpu) => sum + cpu, 0),
      1,
    );
    expect(metrics.resources.top.map((entry: { name: string }) => entry.name).join()).not.toContain(
      "pristine",
    );
  });

  for (const [title, kind, args] of [
    ["a quick run of a refactor run", "refactor", ["--quick"]],
    ["a full run of a feature run", "feature", []],
  ] as const)
    test(`ARK-T725 ${title} records and prints no pristine base duration`, () => {
      const run = pristineRun(kind, 0);
      const result = ark("test", run.runId, ...args);
      expect(result.code, result.err + result.out).toBe(0);
      const [completed] = events(run.runDirectory, "test.completed") as Completed[];
      expect(completed.suites.length).toBe(2);
      for (const suite of completed.suites) {
        expect("head_s" in suite, `${suite.name} head_s`).toBe(false);
        expect("pristine_s" in suite, `${suite.name} pristine_s`).toBe(false);
        expect("pristine" in (resourcesOf(run.runDirectory).suites?.[suite.name] ?? {})).toBe(
          false,
        );
      }
      expect(result.out).not.toContain("pristine base");
    });

  test("ARK-T726 a pristine suite that fails records no figure and never changes base_passed or the exit code of a refactor run, and the base run still holds the head's copy of an added test file", () => {
    const directory = mkdtempSync(join(tmpdir(), "pristine-red-"));
    const marker = join(directory, "marker.txt");
    const workspace = tempGitRepo({
      // red in the pristine checkout (no added file there), green once the base run copies the head's added file
      "test/old.test.ts": [
        'import { existsSync } from "node:fs";',
        'import { expect, test } from "bun:test";',
        'test("FAKE-T1 old", () => { expect(existsSync(import.meta.dir + "/added.test.ts")).toBe(true); });',
        "",
      ].join("\n"),
    });
    const run = startRun({
      workspace,
      suites: [{ ...wholeSuite("cli", ""), command: `bun test ./test ${reportFlags}` }],
      cases: ["FAKE-T1", "FAKE-T2"],
      kind: "refactor",
    });
    commit(run.mirror, "add a test", {
      "test/added.test.ts": passingFile(
        "FAKE-T2 added",
        `appendFileSync(${JSON.stringify(marker)}, "added " + process.cwd() + "\\n");`,
      ),
    });

    for (const round of [0, 1]) {
      const result = ark("test", run.runId);
      expect(result.code, result.err + result.out).toBe(0);
      const completed = (
        events(run.runDirectory, "test.completed") as (Completed & {
          base_passed?: boolean;
        })[]
      )[round]!;
      expect(completed.base_passed, `round ${round}`).toBe(true);
      expect(result.out).toContain("base      passed");
      expect("pristine_s" in completed.suites[0]!).toBe(false);
      expect("pristine" in (resourcesOf(run.runDirectory).suites?.cli ?? {})).toBe(false);
      expect(result.out).not.toContain("pristine base");
      if (round === 0) {
        // the head ran the added file in the run's worktree; the base run ran the head's copy once, in another checkout
        const folders = readFileSync(marker, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => line.slice("added ".length));
        expect(folders.filter((folder) => folder === realpathSync(run.mirror)).length).toBe(1);
        expect(folders.filter((folder) => folder !== realpathSync(run.mirror)).length).toBe(1);
      }
    }
  });
});

// ARK-580: a suite's `changed_command` runs in a quick `ark test` only.
describe("ark test changed_command", () => {
  const fakeForge = join(import.meta.dir, "fixtures/merge-request");

  /** A shell command that writes a JUnit report naming `files`, one passing `FAKE-T1` test each. */
  const reportFor = (...files: string[]) =>
    `printf '%s' '<testsuites>${files
      .map((file) => `<testcase name="FAKE-T1 ${file}" classname="${file}" file="${file}"/>`)
      .join("")}</testsuites>' > {report}`;

  /**
   * A suite whose commands leave markers in `markers` and report test files: `command` names a.test.ts and b.test.ts,
   * `changed_command` (when `changedFiles` is set) names `changedFiles` and keeps the `{base}` it got.
   */
  const stubSuite = (
    markers: string,
    name: string,
    changedFiles?: string[],
    extra: Partial<SuiteConfig> = {},
  ): SuiteConfig => ({
    name,
    level: "integration",
    repo: ".",
    parser: "bun",
    command: `touch ${markers}/${name}-full-ran; ${reportFor("a.test.ts", "b.test.ts")}`,
    ...(changedFiles === undefined
      ? {}
      : {
          changed_command: `touch ${markers}/${name}-changed-ran; echo {base} > ${markers}/${name}-base-seen; ${reportFor(...changedFiles)}`,
        }),
    ...extra,
  });

  const markerDirectory = () => mkdtempSync(join(tmpdir(), "changed-command-"));
  const marked = (markers: string, name: string) => existsSync(join(markers, name));
  const clearMarkers = (markers: string) => {
    rmSync(markers, { recursive: true, force: true });
    mkdirSync(markers);
  };
  const suiteLine = (output: string, name: string) =>
    output.split("\n").find((line) => line.startsWith(`suite      ${name} `));
  const baseOf = (runDirectory: string): string => events(runDirectory, "worktree.created")[0].base;

  test("ARK-T737 a quick run runs changed_command with the worktree base and not command or base_files, records and prints the files that ran, skips an empty set, and runs a suite without one whole", () => {
    const markers = markerDirectory();
    const workspace = tempGitRepo({ "a.test.ts": "export {};\n", "b.test.ts": "export {};\n" });
    const run = startRun({
      workspace,
      cases: ["FAKE-T1"],
      suites: [
        stubSuite(markers, "unit", ["a.test.ts"]),
        stubSuite(markers, "both", ["a.test.ts"], {
          base_files: "a.test.ts",
          base_command: `touch ${markers}/both-base-command-ran; ${reportFor("a.test.ts")} # {files}`,
        }),
        stubSuite(markers, "plain"),
        stubSuite(markers, "none", []),
      ],
    });
    // The own commit changes a.test.ts: the own-commit selection of base_files would run base_command.
    commit(run.mirror, "own test", { "a.test.ts": "export const a = 1;\n" });
    const base = baseOf(run.runDirectory);
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    expect(git(run.mirror, "rev-parse", "HEAD")).not.toBe(base);

    const quick = ark("test", run.runId, "--quick");
    expect(quick.code, quick.err + quick.out).toBe(0);
    expect(marked(markers, "unit-changed-ran")).toBe(true);
    expect(marked(markers, "unit-full-ran")).toBe(false);
    expect(readFileSync(join(markers, "unit-base-seen"), "utf8").trim()).toBe(base);
    expect(marked(markers, "both-changed-ran")).toBe(true);
    expect(marked(markers, "both-base-command-ran")).toBe(false);
    expect(readFileSync(join(markers, "both-base-seen"), "utf8").trim()).toBe(base);
    expect(marked(markers, "plain-full-ran")).toBe(true);
    expect(quick.out).toContain("none head  skipped  (no test files are affected)");
    expect(suiteLine(quick.out, "none")).not.toContain("passed");
    for (const name of ["unit", "both"]) {
      expect(suiteLine(quick.out, name)).toContain("files: a.test.ts");
      expect(suiteLine(quick.out, name)).not.toContain("b.test.ts");
    }
    expect(suiteLine(quick.out, "plain")).not.toContain("files:");
    const [completed] = events(run.runDirectory, "test.completed");
    expect(completed.mode).toBe("quick");
    const row = (name: string) =>
      completed.suites.find((suite: { name: string }) => suite.name === name);
    expect(row("unit").files).toEqual(["a.test.ts"]);
    expect(row("both").files).toEqual(["a.test.ts"]);
    expect("files" in row("plain")).toBe(false);

    // The same heads again: the suites are reused and still name their files.
    clearMarkers(markers);
    const again = ark("test", run.runId, "--quick");
    expect(again.code, again.err + again.out).toBe(0);
    for (const name of ["unit", "both"]) {
      expect(suiteLine(again.out, name)).toContain("reused");
      expect(suiteLine(again.out, name)).toContain("files: a.test.ts");
      expect(marked(markers, `${name}-changed-ran`)).toBe(false);
    }
    // A cached empty affected set is skipped, not reused: the record never lists it.
    expect(again.out).toContain("none head  skipped  (no test files are affected)");
    const secondCompleted = events(run.runDirectory, "test.completed").at(-1);
    expect(secondCompleted.reused).toContain("head:unit");
    expect(secondCompleted.reused).not.toContain("head:none");
  });

  test("ARK-T737 a quick run on the real bun runner selects the tests the base diff reaches, by import graph", () => {
    const workspace = tempGitRepo({
      "lib.ts": "export const value = 1;\n",
      "lib.test.ts": `import { expect, test } from "bun:test";\nimport { value } from "./lib.ts";\ntest("FAKE-T1 lib", () => { expect(value).toBeGreaterThan(0); });\n`,
      "other.test.ts": `import { expect, test } from "bun:test";\ntest("FAKE-T2 other", () => { expect(1).toBe(1); });\n`,
    });
    const run = startRun({
      workspace,
      cases: ["FAKE-T1", "FAKE-T2"],
      suites: [
        {
          name: "cli",
          level: "integration",
          repo: ".",
          parser: "bun",
          command: `bun test ${reportFlags}`,
          changed_command: `bun test --changed={base} ${reportFlags}`,
        },
      ],
    });
    commit(run.mirror, "change the library", { "lib.ts": "export const value = 2;\n" });

    const quick = ark("test", run.runId, "--quick");
    expect(quick.code, quick.err + quick.out).toBe(0);
    expect(suiteLine(quick.out, "cli")).toContain("files: lib.test.ts");
    expect(suiteLine(quick.out, "cli")).not.toContain("other.test.ts");
    expect(events(run.runDirectory, "test.completed")[0].suites[0].files).toEqual(["lib.test.ts"]);
  });

  test("ARK-T737 a changed_command that exits non-zero with no report fails the suite and is no empty affected set", () => {
    const markers = markerDirectory();
    const workspace = tempGitRepo({ "a.test.ts": "export {};\n" });
    const run = startRun({
      workspace,
      cases: ["FAKE-T1"],
      suites: [
        stubSuite(markers, "crash", ["a.test.ts"], {
          changed_command: `touch ${markers}/crash-ran; echo boom >&2; exit 1 # {base} {report}`,
        }),
      ],
    });
    const quick = ark("test", run.runId, "--quick");
    expect(marked(markers, "crash-ran")).toBe(true);
    expect(quick.code).not.toBe(0);
    expect(quick.out).not.toContain("no test files are affected");
    expect(events(run.runDirectory, "test.completed")[0].suites[0]).toMatchObject({
      name: "crash",
      passed: false,
    });
  });

  test("ARK-T737 a worktree that records no base runs the whole command and never sends {base}", () => {
    const markers = markerDirectory();
    const workspace = tempGitRepo({ "a.test.ts": "export {};\n" });
    const run = startRun({
      workspace,
      cases: ["FAKE-T1"],
      suites: [stubSuite(markers, "unit", ["a.test.ts"])],
    });
    const created = deriveState(readEvents(run.runDirectory)).worktrees[0]!;
    // An old log: the later worktree.created event of the repo has no base.
    appendEvent(run.runDirectory, "worktree.created", {
      repo: ".",
      path: created.path,
      branch: created.branch,
    });

    const quick = ark("test", run.runId, "--quick");
    expect(quick.code, quick.err + quick.out).toBe(0);
    expect(marked(markers, "unit-full-ran")).toBe(true);
    expect(marked(markers, "unit-changed-ran")).toBe(false);
    expect(marked(markers, "unit-base-seen")).toBe(false);
    expect(quick.out).not.toContain("unit head  skipped");
  });

  /** A run on a fake forge, with suites `unit` (changed_command only) and `e2e` (changed_command and base_files). */
  function gatedRun(checks?: { name: string; repo: string; command: string }[]) {
    process.env.PATH = `${fakeForge}:${(process.env.PATH ?? "")
      .split(":")
      .filter((entry) => entry !== fakeForge)
      .join(":")}`;
    process.env.FAKE_LOG = join(mkdtempSync(join(tmpdir(), "ark-fake-log-")), "calls.ndjson");
    const markers = markerDirectory();
    const workspace = tempGitRepo({ "a.test.ts": "export {};\n", "e2e.test.ts": "export {};\n" });
    const run = startRun({
      workspace,
      cases: ["FAKE-T1"],
      forge: true,
      checks,
      suites: [
        stubSuite(markers, "unit", ["a.test.ts"]),
        stubSuite(markers, "e2e", ["e2e.test.ts"], {
          base_files: "e2e.test.ts",
          base_command: `touch ${markers}/e2e-base-command-ran; ${reportFor("e2e.test.ts")} # {files}`,
        }),
      ],
    });
    commit(run.mirror, "own test", { "e2e.test.ts": "export const own = 1;\n" });
    // A new head and no marker: the cache reuses a suite of the same heads and mode, so every run starts from here.
    let revision = 0;
    const freshHead = () => {
      revision += 1;
      commit(run.mirror, `change ${revision}`, { "a.test.ts": `export const n = ${revision};\n` });
      clearMarkers(markers);
    };
    return { ...run, markers, freshHead };
  }

  test("ARK-T738 a full run runs command of every suite and never changed_command, with or without --keep-going, and a last quick run is refused at merge-request open while a last full run opens", () => {
    const { runId, runDirectory, markers, freshHead } = gatedRun();
    const ranFull = () => {
      for (const name of ["unit", "e2e"]) {
        expect(marked(markers, `${name}-full-ran`), `${name} command`).toBe(true);
        expect(marked(markers, `${name}-changed-ran`), `${name} changed_command`).toBe(false);
      }
    };

    freshHead();
    expect(ark("test", runId).code).toBe(0);
    ranFull();
    expect(events(runDirectory, "test.completed").at(-1).mode).toBe("full");

    freshHead();
    expect(ark("test", runId, "--keep-going").code).toBe(0);
    ranFull();

    freshHead();
    expect(ark("test", runId, "--quick").code).toBe(0);
    expect(marked(markers, "unit-changed-ran")).toBe(true);
    expect(marked(markers, "unit-full-ran")).toBe(false);
    expect(events(runDirectory, "test.completed").at(-1).mode).toBe("quick");
    const refused = ark("merge-request", "open", runId);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("quick");
    expect(refused.err).toContain(`ark test ${runId}`);
    expect(events(runDirectory, "merge_request.opened")).toHaveLength(0);

    freshHead();
    expect(ark("test", runId).code).toBe(0);
    ranFull();
    const opened = ark("merge-request", "open", runId);
    expect(opened.code, opened.err + opened.out).toBe(0);
    expect(events(runDirectory, "merge_request.opened")).toHaveLength(1);

    // A failed check with --keep-going: the suites still run in full. A new run, so it comes last: it replaces ARK_HOME.
    const failing = gatedRun([{ name: "lint", repo: ".", command: "false" }]);
    failing.freshHead();
    expect(ark("test", failing.runId, "--keep-going").code).toBe(1);
    for (const name of ["unit", "e2e"]) {
      expect(marked(failing.markers, `${name}-full-ran`)).toBe(true);
      expect(marked(failing.markers, `${name}-changed-ran`)).toBe(false);
    }
  });

  test("ARK-T739 ark.yml refuses a changed_command with no {base}, no {report}, no text or an empty value, hints a misspelled key, and loads a valid one", () => {
    const markers = markerDirectory();
    const workspace = tempGitRepo({ "a.test.ts": "export {};\n" });
    const run = startRun({
      workspace,
      cases: ["FAKE-T1"],
      suites: [stubSuite(markers, "unit", ["a.test.ts"])],
    });
    const valid = stubSuite(markers, "unit", ["a.test.ts"]);
    const withSuite = (suite: Record<string, unknown>) =>
      writeProject("demo", {
        workspace,
        ticket_source: "local",
        test_min_free_memory_percent: 0,
        test_max_swap_gb: 1000,
        suites: [suite],
        roles,
      });
    const refusals: [string, Record<string, unknown>, string][] = [
      [
        "no {base}",
        { ...valid, changed_command: `bun test --changed ${reportFlags}` },
        "suites[0].changed_command must contain {base}",
      ],
      [
        "no {report}",
        { ...valid, changed_command: "bun test --changed={base}" },
        "suites[0].changed_command must contain {report}",
      ],
      [
        "empty",
        { ...valid, changed_command: "" },
        "suites[0].changed_command is required and must be a non-empty string",
      ],
      [
        "not text",
        { ...valid, changed_command: ["bun"] },
        "suites[0].changed_command is required and must be a non-empty string",
      ],
      [
        "misspelled",
        { ...valid, changed_command: undefined, changed_comand: valid.changed_command },
        "suites[0].changed_comand is not a key; did you mean changed_command?",
      ],
    ];
    for (const [label, suite, message] of refusals) {
      withSuite(suite);
      const refused = ark("test", run.runId, "--quick");
      expect(refused.code, label).toBe(1);
      expect(refused.err, label).toContain(message);
      expect(marked(markers, "unit-full-ran"), `${label}: no suite runs`).toBe(false);
      expect(marked(markers, "unit-changed-ran"), `${label}: no suite runs`).toBe(false);
    }

    withSuite(valid);
    const loaded = ark("test", run.runId, "--quick");
    expect(loaded.code, loaded.err + loaded.out).toBe(0);
    expect(marked(markers, "unit-changed-ran")).toBe(true);
  });
});

describe("ark merge-request open on a quick test of a run with no code file", () => {
  const fakeForge = join(import.meta.dir, "fixtures/merge-request");
  const fullSuiteLine = "Full suite: CI (no code file in this diff)";
  const quickRefusal = (runId: string) =>
    `the last test at this head is quick, not a gate: run \`ark test ${runId}\``;
  const notPassedRefusal =
    "the last test run did not pass: fix the failures and run `ark test` again";

  type Shape = {
    kind?: string;
    cases?: string[];
    action?: string;
    planCases?: Record<string, unknown>[];
    manualAc?: boolean;
    /** "one": the repo of the workspace. "core": two repos, a worktree in `core` only. "both": a worktree in each. */
    repos?: "one" | "core" | "both";
    /** No `base_files`, so a quick run runs the whole suite (and `test/other.test.ts` joins the base). */
    wholeSuite?: boolean;
    checks?: { name: string; repo: string; command: string }[];
    /** Extra change on top of the own Markdown commit, in the mirrors of the run. */
    change?: (mirrors: Record<string, string>) => void;
  };

  /**
   * A run on a fake forge whose own commit holds `docs/guide.md` and `skills/demo/SKILL.md` only (the accepted head
   * of ARK-T748 fixture A), with `shape` changing one thing. `ark.yml` lists `docs/reference/cli.md` as generated.
   */
  function noCodeRun(shape: Shape = {}) {
    process.env.PATH = `${fakeForge}:${(process.env.PATH ?? "")
      .split(":")
      .filter((entry) => entry !== fakeForge)
      .join(":")}`;
    const logFile = join(mkdtempSync(join(tmpdir(), "ark-fake-log-")), "calls.ndjson");
    process.env.FAKE_LOG = logFile;
    const caseEntry = (id: string) =>
      [
        "---",
        `id: ${id}`,
        `title: ${id} fixture entry`,
        "level: integration",
        "technique: fixture",
        "priority: low",
        "risk: none",
        "status: active",
        "changed_by: FAKE-1",
        "---",
        "",
        ...[
          "Objective",
          "Preconditions",
          "Steps",
          "Expected results",
          "Screenshot checkpoints",
        ].flatMap((section) => [`## ${section}`, "", "x", ""]),
      ].join("\n");
    const fixture = markerFixture();
    const switchFile = join(fixture.directory, "switch");
    const files: Record<string, string> = {
      "test/existing.test.ts": fixture.testFile(["FAKE-T1 existing"]),
      "src/old.ts": "export const old = 1;\n",
      "test/cases/FAKE-T1.md": caseEntry("FAKE-T1"),
      "test/cases/FAKE-T9.md": caseEntry("FAKE-T9"),
      ...(shape.wholeSuite
        ? {
            "test/other.test.ts": [
              'import { existsSync } from "node:fs";',
              'import { expect, test } from "bun:test";',
              `test("FAKE-T2 other", () => { expect(existsSync(${JSON.stringify(switchFile)})).toBe(false); });`,
              "",
            ].join("\n"),
          }
        : {}),
    };
    const layout = shape.repos ?? "one";
    let workspace: string;
    let repos: string[] | undefined;
    if (layout === "one") workspace = tempGitRepo(files);
    else {
      workspace = mkdtempSync(join(tmpdir(), "ark-workspace-"));
      renameSync(tempGitRepo(files), join(workspace, "core"));
      renameSync(tempGitRepo(), join(workspace, "site"));
      repos = layout === "both" ? ["core", "site"] : ["core"];
    }
    const suiteRepo = layout === "one" ? "." : "core";
    fixture.recordBase(layout === "one" ? workspace : join(workspace, "core"));
    const run = startRun({
      workspace,
      suites: [
        suiteOf("cli", "test", {
          repo: suiteRepo,
          ...(shape.wholeSuite ? { base_files: undefined, base_command: undefined } : {}),
        }),
      ],
      cases: shape.cases ?? ["FAKE-T1"],
      forge: true,
      kind: shape.kind,
      action: shape.action ?? "reuse",
      planCases: shape.planCases,
      manualAc: shape.manualAc,
      checks: shape.checks,
      generated: [{ path: "docs/reference/cli.md", command: "true" }],
      repos,
    });
    if (shape.cases?.length === 0) {
      // The inspection AC1 is a manual criterion: its evidence file and a manual ok are the gate.
      writeEvidenceFile(run.runDirectory, "AC1", "inspection");
      const answered = ark("gate", "record", run.runId, "manual", "FAKE-1/AC1", "ok");
      if (answered.code !== 0) throw new Error(`manual ok failed: ${answered.err}${answered.out}`);
    }
    commit(run.mirror, "own markdown", {
      "docs/guide.md": "# Guide\n",
      "skills/demo/SKILL.md": "# Demo\n",
    });
    shape.change?.(run.mirrors);
    return {
      ...run,
      workspace,
      switchFile,
      remote: (mirror = run.mirror) => git(mirror, "ls-remote", "origin"),
    };
  }

  type Call = { tool: string; argv: string[]; body?: string };
  const calls = (): Call[] =>
    existsSync(process.env.FAKE_LOG!)
      ? readFileSync(process.env.FAKE_LOG!, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const created = () =>
    calls().filter((call) => call.argv[0] === "pr" && call.argv[1] === "create");
  const edited = () => calls().filter((call) => call.argv[0] === "pr" && call.argv[1] === "edit");
  const lastQuick = (runDirectory: string) => events(runDirectory, "test.completed").at(-1);
  const openedCount = (runDirectory: string) => events(runDirectory, "merge_request.opened").length;
  const linesOf = (body: string, text: string) =>
    body.split("\n").filter((line) => line.includes(text));

  /** The checks every accepted open shares: the body of the first `gh pr create` call says the full suite is CI's. */
  function expectFullSuiteBody(body: string | undefined) {
    expect(linesOf(body!, fullSuiteLine)).toHaveLength(1);
    expect(body!.split("\n").filter((line) => /^\s*- Tests: .*\d+ passed/.test(line))).toEqual([]);
  }
  const noRefusal = (text: string) => {
    for (const refusal of ["quick, not a gate", "criteria not passing", "test evidence missing"])
      expect(text).not.toContain(refusal);
  };

  test("ARK-T748 a passing quick test of a run whose own diff holds only hand-written Markdown opens the MR, check --stage final agrees, and the body says the full suite is CI's", () => {
    const run = noCodeRun();
    const quick = ark("test", run.runId, "--quick");
    expect(quick.code, quick.err + quick.out).toBe(0);
    expect(quick.out).toContain("skipped  (no changed test file)");
    expect(lastQuick(run.runDirectory)).toMatchObject({
      mode: "quick",
      passed: true,
      criteria: { "FAKE-1/AC1": "not run" },
    });

    const check = ark("merge-request", "check", run.runId, "--stage", "final");
    expect(check.code, check.err + check.out).toBe(0);
    expect(check.err + check.out).toBe("");

    const opened = ark("merge-request", "open", run.runId);
    expect(opened.code, opened.err + opened.out).toBe(0);
    noRefusal(opened.err + opened.out);
    expect(openedCount(run.runDirectory)).toBe(1);
    expect(run.remote()).toContain(`refs/heads/ark/`);
    expect(created()).toHaveLength(1);
    const body = created()[0]!.body;
    expectFullSuiteBody(body);
    const title = created()[0]!.argv[created()[0]!.argv.indexOf("--title") + 1]!;
    // gather.ts --run-dir builds this ledger, so it writes the same Full suite line as the open.
    const ledger = buildLedger({
      runFolder: run.runDirectory,
      heads: { ".": git(run.mirror, "rev-parse", "HEAD") },
    });
    expect(ledger.fullSuiteIsCi).toBe(true);
    const lint = lintBody({ body: body!, title, ledger });
    expect(lint.filter((check) => check.result === "fail")).toEqual([]);
  });

  test("ARK-T748 a run with empty test_cases and a refactor run open on a passing quick test, with no refactor refusal", () => {
    for (const shape of [{ cases: [] }, { kind: "refactor" }]) {
      const run = noCodeRun(shape);
      ark("test", run.runId, "--quick");
      expect(lastQuick(run.runDirectory)).toMatchObject({ mode: "quick", passed: true });
      expect("base_passed" in lastQuick(run.runDirectory)).toBe(false);
      const opened = ark("merge-request", "open", run.runId);
      expect(opened.code, JSON.stringify(shape) + opened.err + opened.out).toBe(0);
      expect(opened.err + opened.out).not.toContain("refactor run:");
      expect(openedCount(run.runDirectory)).toBe(1);
      expectFullSuiteBody(created()[0]!.body);
    }
  });

  test("ARK-T748 a clean sync after the quick test that brings a target .ts keeps the run a no-code run, because the own diff is read from the synced commit", () => {
    const run = noCodeRun();
    expect(ark("test", run.runId, "--quick").code).toBe(0);
    const clone = mkdtempSync(join(tmpdir(), "ark-target-clone-"));
    git(clone, "clone", "-q", git(run.workspace, "remote", "get-url", "origin"), ".");
    git(clone, "config", "user.name", "Ark Test");
    git(clone, "config", "user.email", "ark@example.com");
    commit(clone, "target move", { "src/target.ts": "export const target = 1;\n" });
    git(clone, "push", "-q", "origin", "HEAD:refs/heads/main");
    const synced = ark("worktree", "sync", run.runId);
    expect(synced.code, synced.err + synced.out).toBe(0);
    expect(git(run.mirror, "ls-tree", "-r", "--name-only", "HEAD")).toContain("src/target.ts");

    const opened = ark("merge-request", "open", run.runId);
    expect(opened.code, opened.err + opened.out).toBe(0);
    expect(openedCount(run.runDirectory)).toBe(1);
    expectFullSuiteBody(created()[0]!.body);
  });

  for (const layout of ["core", "both"] as const) {
    test(`ARK-T748 a two-repo workspace with a worktree in ${layout === "core" ? "core only" : "each repo and no own commit in the second"} opens on a passing quick test`, () => {
      const run = noCodeRun({ repos: layout });
      expect(ark("test", run.runId, "--quick").code).toBe(0);
      expect(lastQuick(run.runDirectory)).toMatchObject({ mode: "quick", passed: true });
      const check = ark("merge-request", "check", run.runId, "--stage", "final");
      expect(check.code, check.err + check.out).toBe(0);
      expect(check.err + check.out).toBe("");

      const opened = ark("merge-request", "open", run.runId);
      expect(opened.code, opened.err + opened.out).toBe(0);
      noRefusal(opened.err + opened.out);
      expect(openedCount(run.runDirectory)).toBe(1);
      expect(created()).toHaveLength(1);
      expectFullSuiteBody(created()[0]!.body);
    });
  }

  test("ARK-T749 the refresh of an open MR refuses a quick test after a code commit and pushes nothing, and after a full test it edits a body with no Full suite line", () => {
    const run = noCodeRun({ wholeSuite: true });
    expect(ark("test", run.runId, "--quick").code).toBe(0);
    const first = ark("merge-request", "open", run.runId);
    expect(first.code, first.err + first.out).toBe(0);
    expect(created()).toHaveLength(1);
    expect(linesOf(created()[0]!.body!, fullSuiteLine)).toHaveLength(1);
    const firstTip = run.remote();

    commit(run.mirror, "code", { "src/a.ts": "export const a = 1;\n" });
    const quick = ark("test", run.runId, "--quick");
    expect(quick.code, quick.err + quick.out).toBe(0);
    const refused = ark("merge-request", "open", run.runId);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(quickRefusal(run.runId));
    expect(run.remote()).toBe(firstTip);
    expect(edited()).toEqual([]);
    expect(openedCount(run.runDirectory)).toBe(1);

    const full = ark("test", run.runId);
    expect(full.code, full.err + full.out).toBe(0);
    for (const side of ["base", "head"])
      expect(readResult(run.runDirectory, "FAKE-T1", side as "base" | "head").status).toBe(
        "passed",
      );
    const refreshed = ark("merge-request", "open", run.runId);
    expect(refreshed.code, refreshed.err + refreshed.out).toBe(0);
    expect(edited()).toHaveLength(1);
    const body = edited()[0]!.body!;
    expect(linesOf(body, "Full suite:")).toEqual([]);
    expect(body).toMatch(/^- Tests: \d+ passed/m);
    expect(run.remote()).toContain(git(run.mirror, "rev-parse", "HEAD"));
  });

  type NoCodeRun = {
    runId: string;
    runDirectory: string;
    switchFile: string;
  };
  type Row = {
    label: string;
    shape: Shape;
    refusal: (runId: string) => string;
    /** What the quick run records as `passed`; default true. */
    passed?: boolean;
    beforeQuick?: (run: NoCodeRun) => void;
    afterQuick?: (run: NoCodeRun) => void;
  };
  const own = (path: string, content: string): Pick<Shape, "change"> => ({
    change: (mirrors) => commit(mirrors["."]!, `own ${path}`, { [path]: content }),
  });
  const rows: Row[] = [
    {
      label: "adds src/a.ts",
      shape: own("src/a.ts", "export const a = 1;\n"),
      refusal: quickRefusal,
    },
    {
      label: "adds the script scripts/release.sh",
      shape: own("scripts/release.sh", "echo release\n"),
      refusal: quickRefusal,
    },
    { label: "changes package.json", shape: own("package.json", "{}\n"), refusal: quickRefusal },
    {
      label: "adds the Markdown fixture test/fixtures/lint/fail.md",
      shape: own("test/fixtures/lint/fail.md", "# fail\n"),
      refusal: quickRefusal,
    },
    {
      label: "changes the generated docs/reference/cli.md",
      shape: own("docs/reference/cli.md", "# cli\n"),
      refusal: quickRefusal,
    },
    {
      label: "renames a .ts to .md",
      shape: {
        change: (mirrors) => {
          git(mirrors["."]!, "mv", "src/old.ts", "docs/old.md");
          git(mirrors["."]!, "commit", "-qm", "rename");
        },
      },
      refusal: quickRefusal,
    },
    { label: "plan case action add", shape: { action: "add" }, refusal: quickRefusal },
    { label: "plan case action update", shape: { action: "update" }, refusal: quickRefusal },
    {
      label: "plan case action retire",
      shape: {
        planCases: [
          { id: "FAKE-T1", action: "reuse", level: "integration" },
          { id: "FAKE-T9", action: "retire", reason: "The case is gone." },
        ],
      },
      refusal: quickRefusal,
    },
    {
      label: "plan case action empty (old plan shape)",
      shape: {
        planCases: [
          {
            id: "FAKE-T1",
            criterion: "FAKE-1/AC1",
            title: "old shape",
            level: "integration",
            given: [],
            when: ["run it"],
            // oxlint-disable-next-line unicorn/no-thenable -- plan test-case field `then: string[]`, not a Promise-like
            then: ["it works"],
            expected: "it works",
          },
        ],
      },
      refusal: quickRefusal,
    },
    {
      label: "a check exits 1",
      shape: { checks: [{ name: "lint", repo: ".", command: "false" }] },
      refusal: () => notPassedRefusal,
      passed: false,
    },
    {
      label: "the quick suite fails through a test no AC names",
      shape: { wholeSuite: true },
      refusal: () => notPassedRefusal,
      passed: false,
      beforeQuick: ({ switchFile }) => writeFileSync(switchFile, "on\n"),
    },
    {
      label: "a manual AC has no ok",
      shape: { manualAc: true },
      refusal: () => "manual criterion without ok: FAKE-1/AC2",
    },
    {
      label: "plan.yml is missing",
      shape: {},
      refusal: quickRefusal,
      afterQuick: ({ runDirectory }) => rmSync(join(runDirectory, "plan.yml")),
    },
    {
      label: "a second repo holds an own src/b.ts",
      shape: {
        repos: "both",
        change: (mirrors) =>
          commit(mirrors.site!, "own code", { "src/b.ts": "export const b = 1;\n" }),
      },
      refusal: quickRefusal,
    },
    {
      label: "adds the Markdown eval input skills/pr-writing/evals/pr-200.md",
      shape: own("skills/pr-writing/evals/pr-200.md", "# pr 200\n"),
      refusal: quickRefusal,
    },
  ];

  for (const [index, row] of rows.entries())
    test(`ARK-T750 row ${index + 1} merge-request open refuses a quick last test when ${row.label}`, () => {
      const run = noCodeRun(row.shape);
      row.beforeQuick?.(run);
      ark("test", run.runId, "--quick");
      const completed = lastQuick(run.runDirectory);
      expect(completed).toMatchObject({ mode: "quick", passed: row.passed ?? true });
      if (row.shape.wholeSuite) {
        // A failed check stops the run with no suite; this row fails through its suite alone.
        expect(completed.checks.filter((check: { passed: boolean }) => !check.passed)).toEqual([]);
        expect(completed.suites.some((suite: { passed: boolean }) => !suite.passed)).toBe(true);
      }
      row.afterQuick?.(run);

      const refused = ark("merge-request", "open", run.runId);
      expect(refused.code, refused.err + refused.out).toBe(1);
      expect(refused.err.split("\n")[0]).toStartWith(`ark: ${row.refusal(run.runId)}`);
      expect(openedCount(run.runDirectory)).toBe(0);
      expect(run.remote()).not.toContain("refs/heads/ark/");
      expect(created()).toEqual([]);

      if (row.label === "plan.yml is missing") {
        const check = ark("merge-request", "check", run.runId, "--stage", "final");
        const text = check.err + check.out;
        expect(check.code).toBe(1);
        expect(text).toContain(quickRefusal(run.runId));
        expect(text).not.toMatch(/\n\s+at |Error:/);
      }
    });

  test("ARK-T750 the row of the failed quick suite is an accepted head with its switch off", () => {
    const run = noCodeRun({ wholeSuite: true });
    const quick = ark("test", run.runId, "--quick");
    expect(quick.code, quick.err + quick.out).toBe(0);
    expect(lastQuick(run.runDirectory)).toMatchObject({
      mode: "quick",
      passed: true,
      criteria: { "FAKE-1/AC1": "not run" },
    });
    const check = ark("merge-request", "check", run.runId, "--stage", "final");
    expect(check.code, check.err + check.out).toBe(0);
    expect(check.err + check.out).toBe("");
  });
});
