import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ark,
  recordEvaluation,
  tempArkHome,
  tempGitRepo,
  writeProject,
  writeTicket,
} from "./helpers.ts";
import { recordStartedRun, stopStartedRuns } from "./orphan-runners.ts";

// ARK-581: every time below is a number in a fixture report that a fake suite command copies to {report}.
// No test sleeps or reads the wall clock, so a figure of 900 s costs the same as 0.01 s.
setDefaultTimeout(60_000);
afterEach(stopStartedRuns);

const roles = {
  implementer: { harness: "claude", model: "claude-sonnet" },
  validator: { harness: "codex", model: "gpt-codex" },
  reviewer: { harness: "codex", model: "gpt-codex" },
};

type TestSpec = { name: string; time?: number; file?: string; failed?: boolean };
type Keys = { time_budget_s?: number; slow_test_s?: number; on_over?: string };
type Side = "head" | "base" | "selected";

/** A JUnit report as bun writes it: `time` on the root and on each testcase, and a `file` on each testcase. */
function junit(tests: TestSpec[], suiteTime?: number): string {
  const cases = tests.map(
    (spec) =>
      `<testcase name="${spec.name}" classname=""${spec.time === undefined ? "" : ` time="${spec.time}"`}${spec.file === undefined ? "" : ` file="${spec.file}"`}${spec.failed ? '><failure message="boom"/></testcase>' : "/>"}`,
  );
  return `<?xml version="1.0"?>\n<testsuites name="bun test"${suiteTime === undefined ? "" : ` time="${suiteTime}"`}>\n<testsuite name="suite">\n${cases.join("\n")}\n</testsuite>\n</testsuites>\n`;
}

const emptyReport = '<testsuites name="bun test" time="0"></testsuites>\n';

/** A valid test case entry (test/cases/<id>.md); `extra` adds front matter lines such as `slow_reason: why`. */
function entry(id: string, extra: string[] = []): string {
  return [
    "---",
    `id: ${id}`,
    `title: ${id} an entry`,
    "level: integration",
    "technique: fixture",
    "priority: high",
    "risk: fixture",
    "status: active",
    "changed_by: fixture",
    ...extra,
    "---",
    "",
    "## Objective",
    "",
    "## Preconditions",
    "",
    "## Steps",
    "",
    "## Expected results",
    "",
    "## Screenshot checkpoints",
    "",
  ].join("\n");
}

/** The last `test.completed` event of the run. */
type Completed = {
  passed: boolean;
  mode: string;
  reused?: string[];
  flaky?: { suite: string; file: string }[];
  suites: { name: string; failed_files?: string[]; [field: string]: unknown }[];
};
type TestRun = { code: number; out: string; err: string; event: Completed; completed: number };
type Fixture = {
  state: { selectiveFiles: Record<string, string>; parser: Record<string, string> };
  /** Writes the report a fake command copies; `sides` default to head and base. */
  report: (name: string, content: string, sides?: Side[]) => void;
  exitCode: (name: string, code: number, mode?: "suite" | "selected") => void;
  /** Commits files into one repo of the run's mirror; a null content deletes the file. */
  commit: (repo: string, files: Record<string, string | null>) => void;
  /** `ark test` with a new command text: nothing is reused. */
  run: (...args: string[]) => TestRun;
  /** `ark test` with the command text of the last run: the passed suites are reused. */
  rerun: (...args: string[]) => TestRun;
  /** How many times the fake command ran on `side` for `name`. */
  count: (name: string, side: Side) => number;
  /** Sets the keys of the suites; a suite not named gets none. */
  keys: (suites: Record<string, Keys>) => void;
  /** Commits head.marker, a.test.ts and b.test.ts on the run's branch: the head checkout has them, the base checkout has not. */
  commitMarker: (repo?: string) => void;
};

function runGit(directory: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", directory, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

/**
 * A single-repo (or two-repo) workspace and a started run at the building phase. The suites `unit` and `e2e` run a fake
 * command: it copies the report of its side to {report}, appends the side to `<suite>.count` and exits with `<suite>.exit`.
 * The side is `head` where `head.marker` exists (the run's branch commits it), else `base`; a `base_command`
 * (a retry or a quick selection) copies the `selected` report. The cache key holds the command text, so each fresh
 * run changes the trailing `# <runNumber>` and a reuse keeps it.
 */
function buildFixture(
  options: { entries?: Record<string, string>; nested?: boolean } = {},
): Fixture {
  const arkHome = tempArkHome();
  const reports = mkdtempSync(join(tmpdir(), "ark-time-reports-"));
  const script = join(reports, "suite.sh");
  writeFileSync(
    script,
    [
      "name=$1; report=$2; mode=$3",
      `reports=${reports}`,
      'if [ "$mode" = suite ]; then',
      "  if [ -e head.marker ]; then side=head; else side=base; fi",
      '  cp "$reports/$side-$name.rep" "$report"',
      '  echo $side >> "$reports/$name.count"',
      '  exit $(cat "$reports/$name.exit")',
      "fi",
      'if [ -e head.marker ]; then echo selected >> "$reports/$name.count"; fi',
      'cp "$reports/selected-$name.rep" "$report"',
      'exit $(cat "$reports/selected-$name.exit")',
    ].join("\n"),
  );
  const workspace = tempGitRepo({ "dot.txt": "dot", ...options.entries });
  const suiteRepo = options.nested ? "repos/b" : ".";
  if (options.nested) {
    mkdirSync(join(workspace, "repos"));
    renameSync(tempGitRepo({ "a.txt": "a" }), join(workspace, "repos/a"));
    renameSync(tempGitRepo({ "b.txt": "b", ...options.entries }), join(workspace, "repos/b"));
  }
  const state = {
    runNumber: 0,
    keys: { unit: {}, e2e: {} } as Record<string, Keys>,
    parser: { unit: "bun", e2e: "bun" } as Record<string, string>,
    selectiveFiles: {} as Record<string, string>,
  };
  const activate = () => {
    process.env.ARK_HOME = arkHome;
  };
  const writeConfig = () => {
    activate();
    writeProject("demo", {
      workspace,
      ticket_source: "local",
      test_min_free_memory_percent: 0,
      test_max_swap_gb: 1000,
      suites: ["unit", "e2e"].map((name) => ({
        name,
        level: name === "unit" ? "unit" : "e2e",
        repo: name === "unit" ? "." : suiteRepo,
        command: `sh ${script} ${name} {report} suite # ${state.runNumber}`,
        parser: state.parser[name],
        ...(state.selectiveFiles[name] === undefined
          ? {}
          : {
              base_files: state.selectiveFiles[name],
              base_command: `sh ${script} ${name} {report} selected # ${state.runNumber} {files}`,
            }),
        ...state.keys[name],
      })),
      roles,
    });
  };
  const report = (name: string, content: string, sides: Side[] = ["head", "base"]) => {
    for (const side of sides) writeFileSync(join(reports, `${side}-${name}.rep`), content);
  };
  const exitCode = (name: string, code: number, mode: "suite" | "selected" = "suite") =>
    writeFileSync(
      join(reports, mode === "suite" ? `${name}.exit` : `selected-${name}.exit`),
      String(code),
    );
  for (const name of ["unit", "e2e"]) {
    report(name, emptyReport, ["head", "base", "selected"]);
    exitCode(name, 0);
    exitCode(name, 0, "selected");
  }

  writeConfig();
  const ticket = writeTicket(
    "demo",
    "FAKE-1",
    [{ id: "AC1", text: "criterion AC1", method: "test", verified_by: ["FAKE-T1"] }],
    "Ticket FAKE-1",
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
        why: "Time the suites.",
        changes: [{ criterion: "FAKE-1/AC1", where: "tests", now: "x", fix: "y" }],
      },
      steps: [
        {
          id: "build",
          role: "implementer",
          repo: options.nested ? "repos/a" : ".",
          harness: "claude",
          model: "claude-sonnet",
          needs: [],
          criteria: ["FAKE-1/AC1"],
        },
      ],
      test_cases: [
        {
          id: "FAKE-T1",
          action: "add",
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
    ...(options.nested
      ? [
          ["worktree", "create", runId, "repos/a"],
          ["worktree", "create", runId, "repos/b"],
        ]
      : []),
  ]) {
    const result = ark(...args);
    if (result.code !== 0) throw new Error(`${args.join(" ")} failed: ${result.err}`);
  }
  const mirror = join(runDirectory, "workspace");

  /** Commits files into one repo of the run's mirror (the run's branch). */
  const commit = (repo: string, files: Record<string, string | null>) => {
    const directory = join(mirror, repo);
    for (const [path, content] of Object.entries(files)) {
      if (content === null) rmSync(join(directory, path), { force: true });
      else {
        mkdirSync(join(directory, path, ".."), { recursive: true });
        writeFileSync(join(directory, path), content);
      }
    }
    runGit(directory, "add", "-A");
    runGit(directory, "commit", "-q", "--allow-empty", "-m", "change");
  };
  const readEvents = () =>
    readFileSync(join(runDirectory, "events.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const runTest = (fresh: boolean, args: string[]): TestRun => {
    if (fresh) state.runNumber += 1;
    writeConfig();
    const result = ark("test", runId, ...args);
    const completed = readEvents().filter((event) => event.type === "test.completed");
    return { ...result, event: completed.at(-1)?.data as Completed, completed: completed.length };
  };
  return {
    state,
    report,
    exitCode,
    commit,
    run: (...args: string[]) => runTest(true, args),
    rerun: (...args: string[]) => runTest(false, args),
    count: (name: string, side: Side) => {
      const file = join(reports, `${name}.count`);
      return existsSync(file)
        ? readFileSync(file, "utf8")
            .split("\n")
            .filter((line) => line === side).length
        : 0;
    },
    keys: (suites: Record<string, Keys>) => {
      state.keys = { unit: {}, e2e: {}, ...suites };
    },
    commitMarker: (repo = ".") =>
      commit(repo, { "head.marker": "", "a.test.ts": "// a\n", "b.test.ts": "// b\n" }),
  };
}

/** The lines `ark test` prints about time: suite time, slow tests and over budget, in the words of cli/time-limit.ts. */
const timeLines = (out: string): string[] =>
  out.split("\n").filter((line) => /^(time|slow|warning|failure)\s/.test(line));
/** The word of a time line of a warn run or a fail run, as cli/time-limit.ts pads it to 11 columns. */
const word = (text: string) => text.padEnd(11);

const standard: TestSpec[] = [
  { name: "FAKE-T1 fast", time: 0.5, file: "a.test.ts" },
  { name: "FAKE-T2 limit", time: 2, file: "a.test.ts" },
  { name: "FAKE-T3 slow", time: 3.5, file: "b.test.ts" },
];
/** The slow line of `FAKE-T3 slow` at 3.5 s over a 2 s limit, with `mark` warning or failure. */
const slowT3 = (mark: "warning" | "failure", limit = 2) =>
  `${word(mark)}slow test  e2e  b.test.ts  FAKE-T3 slow  3.5 s  over slow_test_s ${limit}  (no slow_reason)`;
const overBudget = (mark: "warning" | "failure", seconds: string, budget = 10) =>
  `${word(mark)}suite e2e  ${seconds}  over time_budget_s ${budget}`;
const suiteTime = (seconds: string) => `${word("time")}suite e2e  ${seconds}`;

/** The stdout of a run without its time lines: a time check only adds those, so the rest must read as in a keyless run. */
const withoutTimeLines = (output: string): string[] =>
  output.split("\n").filter((line) => !/^(time|slow|warning|failure)\s/.test(line));

describe("ARK-T741 a full ark test judges each suite's time by its own keys", () => {
  let fixture: Fixture;
  // The keyless run, which steps 2 to 11 are read against. Nothing in the stdout of a fresh keyless run changes from run to
  // run in this fixture (no refactor head figure, no reuse line), so no line is dropped when two of them are compared.
  let keyless: TestRun;
  beforeAll(() => {
    fixture = buildFixture();
    fixture.commitMarker();
    fixture.keys({});
    fixture.report("e2e", junit(standard, 900));
    keyless = fixture.run();
  });

  test("ARK-T741 step 1: with none of the keys the whole output is the same whatever times the report holds", () => {
    fixture.keys({});
    fixture.report("e2e", junit(standard.map(({ time: _time, ...spec }) => spec)));
    const untimed = fixture.run();

    expect(keyless.code).toBe(0);
    expect(keyless.event.passed).toBe(true);
    expect(timeLines(keyless.out)).toEqual([]);
    expect(keyless.out).not.toMatch(/time_budget_s|slow_test_s|slow_reason|not judged/);
    expect(keyless.out).toContain("tests      3 passed, 0 skipped (base 0), 0 deleted");
    // Every line a keyless run prints starts with a prefix `ark test` printed before this ticket: a new line fails here.
    for (const line of keyless.out.split("\n").filter((text) => text !== ""))
      expect(line).toMatch(/^(old id|plan-membership|base|suite|tests|criterion|evidence)\s/);
    expect(keyless.out).toContain(
      "\nsuite      unit (unit)  passed\nsuite      e2e (e2e)  passed\n",
    );
    // The whole stdout, line for line, whatever the times in the report: nothing varies from run to run, so no line is dropped.
    expect(untimed.out).toBe(keyless.out);
    expect(untimed.code).toBe(0);
    expect(untimed.event.passed).toBe(true);
  });

  // Steps 2 to 10: one fresh full run each. `mark` is what the run prints and does: warn passes, fail exits 1.
  const matrix: {
    step: string;
    keys: Keys;
    tests?: TestSpec[];
    time: number;
    code: 0 | 1;
    slow?: boolean;
    over?: boolean;
  }[] = [
    { step: "2 slow_test_s only", keys: { slow_test_s: 2 }, time: 7, code: 0, slow: true },
    {
      step: "3 time_budget_s equal to the suite time",
      keys: { time_budget_s: 10 },
      time: 10,
      code: 0,
    },
    {
      step: "3 time_budget_s just over",
      keys: { time_budget_s: 10 },
      time: 10.01,
      code: 0,
      over: true,
    },
    {
      step: "4 both limits, on_over unset",
      keys: { time_budget_s: 10, slow_test_s: 2 },
      time: 12,
      code: 0,
      slow: true,
      over: true,
    },
    {
      step: "5 both limits, on_over warn",
      keys: { time_budget_s: 10, slow_test_s: 2, on_over: "warn" },
      time: 12,
      code: 0,
      slow: true,
      over: true,
    },
    {
      step: "6 on_over fail, a slow test only",
      keys: { slow_test_s: 2, on_over: "fail" },
      time: 7,
      code: 1,
      slow: true,
    },
    {
      step: "7 on_over fail, over the budget only",
      keys: { time_budget_s: 10, on_over: "fail" },
      time: 12,
      code: 1,
      over: true,
    },
    {
      step: "8 on_over fail, both over",
      keys: { time_budget_s: 10, slow_test_s: 2, on_over: "fail" },
      time: 12,
      code: 1,
      slow: true,
      over: true,
    },
    {
      step: "9 on_over fail, every figure at its limit",
      keys: { time_budget_s: 10, slow_test_s: 3.5, on_over: "fail" },
      time: 10,
      code: 0,
    },
    {
      step: "10 on_over fail, nothing over a limit that is set",
      keys: { slow_test_s: 2, on_over: "fail" },
      tests: standard.map((spec) => ({ ...spec, time: 0.5 })),
      time: 7,
      code: 0,
    },
  ];
  for (const row of matrix)
    test(`ARK-T741 step ${row.step}: exit ${row.code}, the suite time, and the slow test and budget lines it names`, () => {
      const hasBudget = row.keys.time_budget_s !== undefined;
      const hasLimit = row.keys.slow_test_s !== undefined;
      fixture.keys({ e2e: row.keys });
      fixture.report("e2e", junit(row.tests ?? standard, row.time));
      const result = fixture.run();
      const mark = row.code === 1 ? "failure" : "warning";

      expect(result.code).toBe(row.code);
      expect(result.event.passed).toBe(row.code === 0);
      const expected = [
        suiteTime(`${row.time} s`),
        ...(row.slow ? [slowT3(mark, row.keys.slow_test_s)] : []),
        ...(row.over ? [overBudget(mark, `${row.time} s`)] : []),
      ];
      expect(timeLines(result.out)).toEqual(expected);
      // A limit that is not set never speaks: no budget line without time_budget_s, no slow test without slow_test_s.
      if (!hasBudget) expect(result.out).not.toContain("time_budget_s");
      if (!hasLimit) expect(result.out).not.toContain("slow_test_s");
      if (row.code === 1)
        expect(result.err).toContain("suite e2e is over its time limit (on_over: fail)");
      else expect(result.err).not.toContain("time limit");
      // Everything but the time lines (suite rows, tests line, criteria, evidence) reads as in the keyless run.
      expect(withoutTimeLines(result.out)).toEqual(withoutTimeLines(keyless.out));
      expect(result.event.suites).toEqual([
        { name: "unit", level: "unit", passed: true, loadAtStart: 0, loadPeak: 0 },
        { name: "e2e", level: "e2e", passed: true, loadAtStart: 0, loadPeak: 0 },
      ]);
    });

  test("ARK-T741 step 11: a base or census report that is slower than the head's never counts", () => {
    const tests = [
      ...standard.map((spec) => (spec.name === "FAKE-T3 slow" ? { ...spec, time: 0.5 } : spec)),
      { name: "FAKE-T9 base only", time: 0.5, file: "b.test.ts" },
    ];
    fixture.keys({ e2e: { slow_test_s: 2, time_budget_s: 10, on_over: "fail" } });
    fixture.report("e2e", junit(tests, 4), ["head"]);
    fixture.report(
      "e2e",
      junit(
        tests.map((spec) => (spec.name === "FAKE-T9 base only" ? { ...spec, time: 9 } : spec)),
        30,
      ),
      ["base"],
    );
    const before = fixture.count("e2e", "base");
    const result = fixture.run();

    expect(result.code).toBe(0);
    expect(result.event.passed).toBe(true);
    expect(timeLines(result.out)).toEqual([suiteTime("4 s")]);
    expect(result.out).not.toMatch(/30 s|9 s|^deleted/m);
    expect(result.out).toContain("tests      4 passed, 0 skipped (base 0), 0 deleted");
    // The suite rows read as in the keyless run (the tests line differs: the fixture holds one more test).
    expect(result.out.split("\n").filter((line) => /^suite\s/.test(line))).toEqual(
      keyless.out.split("\n").filter((line) => /^suite\s/.test(line)),
    );
    // The base side did run (and read the slower report), so the case cannot pass because the base never ran.
    expect(fixture.count("e2e", "base")).toBeGreaterThan(before);
  });
});

describe("ARK-T741 each suite is judged by its own keys", () => {
  const unitTests: TestSpec[] = [{ name: "FAKE-U1 unit a", time: 0.5, file: "u.test.ts" }];
  let fixture: Fixture;
  beforeAll(() => {
    fixture = buildFixture();
    fixture.commitMarker();
  });

  test("ARK-T741 step 12a: a warn suite with a slow test beside a fail suite inside its budget passes", () => {
    fixture.report("unit", junit(unitTests, 5));
    fixture.report("e2e", junit(standard, 7));
    fixture.keys({});
    const reference = fixture.run();
    fixture.keys({
      unit: { time_budget_s: 10, on_over: "fail" },
      e2e: { slow_test_s: 2, on_over: "warn" },
    });
    const result = fixture.run();

    expect(reference.code).toBe(0);
    expect(result.code).toBe(0);
    expect(result.event.passed).toBe(true);
    // unit (on_over fail) is inside its budget and lists nothing; e2e (warn) lists its slow test as a warning.
    expect(timeLines(result.out)).toEqual([
      `${word("time")}suite unit  5 s`,
      suiteTime("7 s"),
      slowT3("warning"),
    ]);
    expect(result.out).not.toMatch(/^failure/m);
    expect(withoutTimeLines(result.out)).toEqual(withoutTimeLines(reference.out));
  });

  test("ARK-T741 step 12b: a keyed suite with nothing over beside an unkeyed suite with a slow test lists nothing for either", () => {
    fixture.report("unit", junit([{ name: "FAKE-T5 slower", time: 6, file: "u.test.ts" }], 20));
    fixture.report(
      "e2e",
      junit(
        standard.map((spec) => ({ ...spec, time: 0.5 })),
        4,
      ),
    );
    fixture.keys({});
    const reference = fixture.run();
    fixture.keys({ e2e: { slow_test_s: 2, on_over: "fail" } });
    const result = fixture.run();

    expect(result.code).toBe(0);
    expect(result.event.passed).toBe(true);
    expect(timeLines(result.out)).toEqual([suiteTime("4 s")]);
    expect(result.out).not.toContain("FAKE-T5 slower  6 s");
    expect(result.out).not.toContain("20 s");
    expect(withoutTimeLines(result.out)).toEqual(withoutTimeLines(reference.out));
  });
});

describe("ARK-T742 the verdict is made once, on the head results, from the current ark.yml", () => {
  test("ARK-T742 step 1: a reused suite is judged by the limits of the current ark.yml, with its stored suite time", () => {
    const fixture = buildFixture();
    fixture.commitMarker();
    fixture.report("e2e", junit(standard, 12));
    fixture.keys({});
    const first = fixture.run();
    expect(first.code).toBe(0);
    expect(fixture.count("e2e", "head")).toBe(1);

    fixture.keys({ e2e: { slow_test_s: 2, on_over: "fail" } });
    const slow = fixture.rerun();
    expect(slow.code).toBe(1);
    expect(slow.event.passed).toBe(false);
    expect(slow.event.reused).toContain("head:e2e");
    expect(timeLines(slow.out)).toEqual([suiteTime("12 s"), slowT3("failure")]);

    fixture.keys({ e2e: { time_budget_s: 10, slow_test_s: 4, on_over: "fail" } });
    const over = fixture.rerun();
    expect(over.code).toBe(1);
    expect(timeLines(over.out)).toEqual([suiteTime("12 s"), overBudget("failure", "12 s")]);

    fixture.keys({ e2e: { time_budget_s: 20, slow_test_s: 4, on_over: "fail" } });
    const inside = fixture.rerun();
    expect(inside.code).toBe(0);
    expect(timeLines(inside.out)).toEqual([suiteTime("12 s")]);
    expect(inside.event.reused).toContain("head:e2e");
    // The suite command ran once: every later verdict came from the stored results and the current limits.
    expect(fixture.count("e2e", "head")).toBe(1);
  });

  test("ARK-T742 step 2: a quick run lists a slow test, prints no suite budget and does not fail in fail mode", () => {
    const fixture = buildFixture();
    fixture.state.selectiveFiles.e2e = "a.test.ts";
    fixture.commitMarker();
    fixture.report("e2e", junit(standard, 12), ["selected"]);
    fixture.keys({});
    const reference = fixture.run("--quick");
    fixture.keys({ e2e: { slow_test_s: 2, time_budget_s: 10, on_over: "fail" } });
    const quick = fixture.run("--quick");

    expect(reference.code).toBe(0);
    expect(quick.event.mode).toBe("quick");
    expect(quick.code).toBe(reference.code);
    expect(quick.event.passed).toBe(true);
    expect(timeLines(quick.out)).toEqual([slowT3("warning")]);
    expect(quick.out).not.toContain("time_budget_s");
    expect(fixture.count("e2e", "selected")).toBeGreaterThan(0);
  });

  // The suite command writes the first report and exits 1; its retry (`base_command`) writes the second one.
  const flakyHead: TestSpec[] = [
    { name: "FAKE-T1 fast", time: 0.1, file: "a.test.ts" },
    { name: "FAKE-T4 other", time: 5, file: "a.test.ts" },
    { name: "FAKE-T3 flaky", time: 0.5, file: "b.test.ts", failed: true },
    { name: "FAKE-T2 limit", time: 9, file: "b.test.ts" },
  ];
  const slowT4 = (mark: "warning" | "failure") =>
    `${word(mark)}slow test  e2e  a.test.ts  FAKE-T4 other  5 s  over slow_test_s 2  (no slow_reason)`;
  const retriedFixture = () => {
    const fixture = buildFixture();
    fixture.state.selectiveFiles.e2e = "*.test.ts";
    fixture.commitMarker();
    fixture.keys({ e2e: { slow_test_s: 2, on_over: "fail" } });
    fixture.report("e2e", junit(flakyHead, 15));
    fixture.exitCode("e2e", 1);
    return fixture;
  };

  test("ARK-T742 step 3: after a file retry the verdict reads the replaced results and keeps the files the retry did not run", () => {
    const fixture = retriedFixture();
    fixture.report(
      "e2e",
      junit([
        { name: "FAKE-T3 flaky", time: 0.4, file: "b.test.ts" },
        { name: "FAKE-T2 limit", time: 0.4, file: "b.test.ts" },
      ]),
      ["selected"],
    );
    const result = fixture.run();

    expect(result.code).toBe(1);
    // The suite passed after its retry: the only failure is the time failure.
    expect(result.err).toContain("suite e2e is over its time limit (on_over: fail)");
    expect(result.err).not.toContain("suite e2e failed");
    expect(result.out).toContain("flaky: b.test.ts");
    expect(timeLines(result.out)).toEqual([suiteTime("15 s"), slowT4("failure")]);
    expect(result.event.flaky).toEqual([{ suite: "e2e", file: "b.test.ts" }]);
    expect(result.event.suites.find((suite) => suite.name === "e2e")).toEqual({
      name: "e2e",
      level: "e2e",
      passed: true,
      loadAtStart: 0,
      loadPeak: 0,
      flaky: ["b.test.ts"],
    });
  });

  test("ARK-T742 step 4: a failing suite beside a time failure names only the failed file", () => {
    const fixture = retriedFixture();
    fixture.report("e2e", junit(flakyHead, 15), ["selected"]);
    fixture.exitCode("e2e", 1, "selected");
    const result = fixture.run();

    expect(result.code).toBe(1);
    expect(result.event.passed).toBe(false);
    expect(result.err).toContain("suite e2e failed");
    expect(result.err).toContain("suite e2e is over its time limit (on_over: fail)");
    expect(result.out).toContain(slowT4("failure"));
    expect(result.out).toMatch(/^suite {6}e2e \(e2e\) {2}failed/m);
    const row = result.event.suites.find((suite) => suite.name === "e2e");
    expect(row?.failed_files).toEqual(["b.test.ts"]);
  });

  test("ARK-T742 step 5: a time failure alone records no failed file, so the next run runs no pre-run", () => {
    const fixture = buildFixture();
    fixture.state.selectiveFiles.e2e = "*.test.ts";
    fixture.commitMarker();
    fixture.keys({ e2e: { slow_test_s: 2, on_over: "fail" } });
    fixture.report(
      "e2e",
      junit(
        flakyHead.filter((spec) => !spec.failed),
        6,
      ),
    );
    fixture.report("e2e", junit([{ name: "FAKE-T1 fast", time: 0.1, file: "a.test.ts" }]), [
      "selected",
    ]);
    const timeFailure = fixture.run();

    expect(timeFailure.code).toBe(1);
    expect(timeFailure.event.passed).toBe(false);
    expect(timeFailure.event.suites.find((suite) => suite.name === "e2e")).not.toHaveProperty(
      "failed_files",
    );
    expect(timeLines(timeFailure.out)).toEqual([
      suiteTime("6 s"),
      `${word("failure")}slow test  e2e  b.test.ts  FAKE-T2 limit  9 s  over slow_test_s 2  (no slow_reason)`,
      slowT4("failure"),
    ]);

    fixture.keys({ e2e: { slow_test_s: 10, on_over: "fail" } });
    const fixed = fixture.rerun();
    expect(fixed.code).toBe(0);
    expect(fixed.out).not.toContain("failed files of the last test, run first");
    expect(fixed.event.reused).toContain("head:e2e");
    expect(fixture.count("e2e", "head")).toBe(1);
    expect(fixture.count("e2e", "selected")).toBe(0);
  });

  test("ARK-T742 step 6: a report with no time is never over a limit, fresh or reused, and says so", () => {
    const fixture = buildFixture();
    fixture.commitMarker();
    fixture.keys({ e2e: { slow_test_s: 2, time_budget_s: 10, on_over: "fail" } });
    fixture.report("e2e", junit(standard.map(({ time: _time, ...spec }) => spec)));
    const fresh = fixture.run();
    const reused = fixture.rerun();

    for (const result of [fresh, reused]) {
      expect(result.code).toBe(0);
      expect(result.event.passed).toBe(true);
      expect(result.out).not.toMatch(/NaN|^(slow|warning|failure)\s/m);
    }
    expect(timeLines(fresh.out)).toEqual([
      `${word("time")}suite e2e  no suite time and test times in the report: not judged`,
    ]);
    expect(timeLines(reused.out)).toEqual([
      `${word("time")}suite e2e  no suite time and test times in the reused result: not judged`,
    ]);
    expect(reused.event.reused).toContain("head:e2e");
    expect(fixture.count("e2e", "head")).toBe(1);
  });

  const pytestReport = (limit: number) => `<?xml version="1.0"?>
<testsuites><testsuite name="pytest" time="${limit}">
<testcase classname="t" name="FAKE-T1 fast" time="0.5" file="t.py"><properties><property name="case" value="FAKE-T1"/></properties></testcase>
<testcase classname="t" name="FAKE-T3 slow" time="3.5" file="t.py"><properties><property name="case" value="FAKE-T3"/></properties></testcase>
</testsuite></testsuites>
`;
  const step = (seconds: number[]) =>
    seconds.map((duration) => ({ result: { status: "passed", duration } }));
  const behaveReport = JSON.stringify([
    {
      keyword: "Feature",
      name: "F",
      tags: [],
      location: "features/f.feature:1",
      status: "passed",
      elements: [
        {
          type: "scenario",
          name: "fast",
          tags: ["FAKE-T1"],
          status: "passed",
          steps: step([0.25, 0.25]),
        },
        {
          type: "scenario",
          name: "slow",
          tags: ["FAKE-T3"],
          status: "passed",
          steps: step([1.5, 2.0]),
        },
      ],
    },
  ]);
  // The suite time of a pytest report is the `time` of its `<testsuite>`; a behave report is JSON and has none.
  for (const [parser, content, slowName, file, suiteLine] of [
    ["pytest", pytestReport(4), "t::FAKE-T3 slow", "t.py", suiteTime("4 s")],
    [
      "behave",
      behaveReport,
      "F: slow",
      "features/f.feature",
      `${word("time")}suite e2e  no suite time in the report: not judged`,
    ],
  ] as const)
    test(`ARK-T742 step 7: the ${parser} parser carries each test time, so a slow test is listed and slow_test_s 4 lists none`, () => {
      const fixture = buildFixture();
      fixture.commitMarker();
      fixture.state.parser.e2e = parser;
      fixture.report("e2e", content);
      fixture.keys({ e2e: { slow_test_s: 2, on_over: "fail" } });
      const slow = fixture.run();
      fixture.keys({ e2e: { slow_test_s: 4, time_budget_s: 10, on_over: "fail" } });
      const inside = fixture.run();

      expect(slow.code).toBe(1);
      expect(timeLines(slow.out)).toContain(
        `${word("failure")}slow test  e2e  ${file}  ${slowName}  3.5 s  over slow_test_s 2  (no slow_reason)`,
      );
      expect(inside.code).toBe(0);
      expect(timeLines(inside.out)).toEqual([suiteLine]);
    });

  const invalid: [string, Keys][] = [
    ["slow_test_s must be a positive number", { slow_test_s: 0 }],
    ["slow_test_s must be a positive number", { slow_test_s: -1 }],
    ["time_budget_s must be a positive number", { time_budget_s: "ten" as unknown as number }],
    ["on_over must be one of warn, fail", { on_over: "stop" }],
    ["on_over must be one of warn, fail", { on_over: "" }],
  ];
  test("ARK-T742 step 8: a bad key is refused at load, before any suite runs", () => {
    const fixture = buildFixture();
    fixture.commitMarker();
    for (const [message, keys] of invalid) {
      fixture.keys({ e2e: keys });
      const result = fixture.run();
      expect(result.err, JSON.stringify(keys)).toContain(message);
      expect(result.code).toBe(1);
      expect(result.completed).toBe(0);
    }
    expect(fixture.count("e2e", "head")).toBe(0);
    expect(fixture.count("e2e", "base")).toBe(0);
  });
});

describe("ARK-T743 a slow test whose test case entry gives a slow_reason is listed with it and does not fail the run", () => {
  const baseEntries = {
    "test/cases/FAKE-T1.md": entry("FAKE-T1", ["slow_reason: base reason"]),
    "test/cases/FAKE-T2.md": entry("FAKE-T2"),
  };
  const slowTest = (name: string): TestSpec => ({ name, time: 4, file: "a.test.ts" });
  const fast = (name: string): TestSpec => ({ name, time: 0.5, file: "a.test.ts" });
  const onlyFirstSlow = junit(
    [
      slowTest("FAKE-T1 slow with reason"),
      fast("FAKE-T2 slow with no reason"),
      fast("FAKE-T3 fast"),
      fast("slow with no id"),
    ],
    6,
  );
  const allSlow = junit(
    [
      slowTest("FAKE-T1 slow with reason"),
      slowTest("FAKE-T2 slow with no reason"),
      fast("FAKE-T3 fast"),
      slowTest("slow with no id"),
    ],
    6,
  );
  const excused = (name: string, reason: string) =>
    `${word("slow")}e2e  a.test.ts  ${name}  4 s  over slow_test_s 2  reason: ${reason}`;
  const unexcused = (mark: "warning" | "failure", name: string) =>
    `${word(mark)}slow test  e2e  a.test.ts  ${name}  4 s  over slow_test_s 2  (no slow_reason)`;
  const t1 = "FAKE-T1 slow with reason";
  const t2 = "FAKE-T2 slow with no reason";
  const noId = "slow with no id";

  /** Entries at the base commit and in the workspace's own checkout: `base reason` and no reason. The run's branch changes them. */
  const entryFixture = () => {
    const fixture = buildFixture({ entries: baseEntries });
    fixture.commitMarker();
    fixture.commit(".", {
      "test/cases/FAKE-T1.md": entry("FAKE-T1", ["slow_reason: head reason"]),
      "test/cases/FAKE-T3.md": entry("FAKE-T3", ["slow_reason: not over the limit"]),
    });
    fixture.keys({ e2e: { slow_test_s: 2, on_over: "fail" } });
    return fixture;
  };

  describe("one repo", () => {
    let fixture: Fixture;
    beforeAll(() => {
      fixture = entryFixture();
    });
    const t1Entry = (...extra: string[]) => ({ "test/cases/FAKE-T1.md": entry("FAKE-T1", extra) });
    // Every test below starts in fail mode: a test that sets another mode must not leak it into the next.
    beforeEach(() => fixture.keys({ e2e: { slow_test_s: 2, on_over: "fail" } }));

    test("ARK-T743 step 1: the excused test is listed with the reason of the run's branch and the run passes in fail mode", () => {
      fixture.commit(".", t1Entry("slow_reason: head reason"));
      fixture.report("e2e", onlyFirstSlow);
      const result = fixture.run();

      expect(result.code).toBe(0);
      expect(result.event.passed).toBe(true);
      expect(timeLines(result.out)).toEqual([suiteTime("6 s"), excused(t1, "head reason")]);
      expect(result.out).not.toContain("base reason");
      expect(result.err).not.toContain("test case entry");
    });

    test("ARK-T743 step 2: a slow test with no entry, no reason or no case id fails the run; the excused one is not named as a reason", () => {
      fixture.commit(".", t1Entry("slow_reason: head reason"));
      fixture.report("e2e", allSlow);
      const result = fixture.run();

      expect(result.code).toBe(1);
      expect(result.event.passed).toBe(false);
      expect(timeLines(result.out)).toEqual([
        suiteTime("6 s"),
        excused(t1, "head reason"),
        unexcused("failure", t2),
        unexcused("failure", noId),
      ]);
      expect(result.out).not.toContain("FAKE-T3 fast  ");
    });

    test("ARK-T743 step 3: with on_over warn the same three slow tests are listed and the run passes", () => {
      fixture.commit(".", t1Entry("slow_reason: head reason"));
      fixture.keys({ e2e: { slow_test_s: 2, on_over: "warn" } });
      fixture.report("e2e", allSlow);
      const result = fixture.run();

      expect(result.code).toBe(0);
      expect(result.event.passed).toBe(true);
      expect(timeLines(result.out)).toEqual([
        suiteTime("6 s"),
        excused(t1, "head reason"),
        unexcused("warning", t2),
        unexcused("warning", noId),
      ]);
    });

    test("ARK-T743 step 4: the reason of a retired entry is not applied, and the retired entry reads without an error", () => {
      fixture.commit(".", {
        "test/cases/FAKE-T1.md": entry("FAKE-T1", [
          "slow_reason: head reason",
          "retired_reason: replaced",
        ]).replace("status: active", "status: retired"),
      });
      fixture.report("e2e", onlyFirstSlow);
      const result = fixture.run();

      expect(result.code).toBe(1);
      expect(timeLines(result.out)).toEqual([suiteTime("6 s"), unexcused("failure", t1)]);
      expect(result.err).not.toContain("test case entry");
    });

    const unexcusedVariants: [string, Record<string, string | null>][] = [
      ["an empty slow_reason", t1Entry('slow_reason: ""')],
      ["no slow_reason field", t1Entry()],
      ["a deleted entry file", { "test/cases/FAKE-T1.md": null }],
    ];
    for (const [title, files] of unexcusedVariants)
      test(`ARK-T743 step 5: ${title} leaves the test unexcused, though the base entry still gives a reason`, () => {
        fixture.commit(".", files);
        fixture.report("e2e", onlyFirstSlow);
        const result = fixture.run();

        expect(result.code).toBe(1);
        expect(timeLines(result.out)).toEqual([suiteTime("6 s"), unexcused("failure", t1)]);
        expect(result.out).not.toContain("base reason");
        expect(result.err).not.toContain("test case entry");
      });

    test("ARK-T743 step 6: a title with two ids is excused only when every id gives a reason", () => {
      const both = "FAKE-T1 FAKE-T2 both";
      fixture.commit(".", {
        ...t1Entry("slow_reason: head reason"),
        "test/cases/FAKE-T2.md": entry("FAKE-T2"),
      });
      fixture.report("e2e", junit([slowTest(both)], 4));
      const onlyOne = fixture.run();
      fixture.commit(".", {
        "test/cases/FAKE-T2.md": entry("FAKE-T2", ["slow_reason: second reason"]),
      });
      const everyId = fixture.run();

      expect(onlyOne.code).toBe(1);
      expect(timeLines(onlyOne.out)).toEqual([suiteTime("4 s"), unexcused("failure", both)]);
      expect(everyId.code).toBe(0);
      expect(timeLines(everyId.out)).toEqual([
        suiteTime("4 s"),
        excused(both, "FAKE-T1: head reason; FAKE-T2: second reason"),
      ]);
    });
  });

  describe("two repos", () => {
    let fixture: Fixture;
    beforeAll(() => {
      fixture = buildFixture({ nested: true });
      fixture.commitMarker("repos/b");
      fixture.keys({ e2e: { slow_test_s: 2, on_over: "fail" } });
      fixture.report("e2e", onlyFirstSlow);
    });

    test("ARK-T743 step 7a: the reason in the entry of the suite's own repo excuses the test", () => {
      fixture.commit("repos/b", {
        "test/cases/FAKE-T1.md": entry("FAKE-T1", ["slow_reason: b reason"]),
      });
      const result = fixture.run();

      expect(result.code).toBe(0);
      expect(timeLines(result.out)).toEqual([suiteTime("6 s"), excused(t1, "b reason")]);
    });

    test("ARK-T743 step 7b: a reason in another repo's entry does not excuse the test", () => {
      fixture.commit("repos/b", { "test/cases/FAKE-T1.md": entry("FAKE-T1") });
      fixture.commit("repos/a", {
        "test/cases/FAKE-T1.md": entry("FAKE-T1", ["slow_reason: a reason"]),
      });
      const result = fixture.run();

      expect(result.code).toBe(1);
      expect(timeLines(result.out)).toEqual([suiteTime("6 s"), unexcused("failure", t1)]);
      expect(result.out).not.toContain("a reason");
    });
  });
});
