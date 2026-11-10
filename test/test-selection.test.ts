import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ark,
  recordEvaluation,
  tempArkHome,
  tempGitRepo,
  writeProject,
  writeTicket,
} from "./helpers.ts";

// ARK-389: every test runs real `ark test` calls on real git repos and real `bun test` suites, at base and at head.
setDefaultTimeout(120_000);

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
 * Starts a run at the building phase on `workspace` (one repo): an AC with `method: test` verified by `cases`,
 * an approved plan and the worktree. `forge` gives the repo an origin whose pushes go to a local bare repo.
 */
function startRun(options: {
  workspace: string;
  suites: SuiteConfig[];
  cases: string[];
  kind?: string;
  forge?: boolean;
  setup?: string;
}): { runId: string; runDirectory: string; mirror: string } {
  const arkHome = tempArkHome();
  if (options.forge) {
    const bare = mkdtempSync(join(tmpdir(), "ark-bare-"));
    git(bare, "init", "--bare", "-q");
    git(options.workspace, "remote", "add", "origin", "https://github.com/org/core.git");
    git(options.workspace, "config", "remote.origin.pushurl", bare);
  }
  writeProject("demo", {
    workspace: options.workspace,
    ticket_source: "local",
    ...(options.setup === undefined ? {} : { setup: options.setup }),
    suites: options.suites,
    roles,
  });
  const ticket = writeTicket(
    "demo",
    "FAKE-1",
    [{ id: "AC1", text: "criterion AC1", method: "test", verified_by: options.cases }],
    "Ticket FAKE-1",
    options.kind,
  );
  const runId = ark("run", "start", ticket, "--project", "demo").out.match(
    /\d{4}-\d{2}-\d{2}-FAKE-1-\d+/,
  )![0];
  const runDirectory = join(arkHome, "projects", "demo", "runs", runId);
  recordEvaluation(runDirectory);
  writeFileSync(
    join(runDirectory, "plan.yml"),
    JSON.stringify({
      design: { interfaces: [{ name: "fixture plan", callers: ["ark test"] }] },
      summary: {
        why: "Test the run.",
        changes: [{ criterion: "FAKE-1/AC1", where: "tests", now: "None.", fix: "A test checks." }],
      },
      steps: [
        {
          id: "build",
          role: "implementer",
          repo: ".",
          harness: "claude",
          model: "claude-sonnet",
          needs: [],
          criteria: ["FAKE-1/AC1"],
        },
      ],
      test_cases: options.cases.map((id) => ({
        id,
        action: "add",
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
    ["worktree", "create", runId, "."],
  ]) {
    const result = ark(...args);
    if (result.code !== 0) throw new Error(`${args.join(" ")} failed: ${result.err}`);
  }
  return { runId, runDirectory, mirror: join(runDirectory, "workspace") };
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
      cases: ["FAKE-T1"],
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
    expect(fixture.ran().filter((line) => line.startsWith("base "))).toEqual([
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
      "test/existing.test.ts": ["FAKE-T8 existing cli"],
      "e2e/existing.test.ts": ["FAKE-T2 existing pw"],
    });
    const run = startRun({
      workspace,
      suites: [suiteOf("cli", "test"), suiteOf("pw", "e2e", { paths: ["hub/", "package.json"] })],
      cases: ["FAKE-T2"],
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
