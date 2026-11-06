import { describe, expect, setDefaultTimeout, test } from "bun:test";
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

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

const fakeCompose = join(import.meta.dir, "fixtures/worktree/fake-compose.sh");
const roles = {
  implementer: { harness: "claude", model: "claude-sonnet" },
  validator: { harness: "codex", model: "gpt-codex" },
  reviewer: { harness: "codex", model: "gpt-codex" },
};
const junit = (file: string) => `bun test --reporter=junit --reporter-outfile={report} ./${file}`;
const suiteTests = (lines: string[]) =>
  `import { expect, test } from "bun:test";\n${lines.join("\n")}\n`;
const passing = (name: string) =>
  `test(${JSON.stringify(name)}, () => { console.log(${JSON.stringify(`ark-log-marker ${name}`)}); });`;
const failing = (name: string) => `test(${JSON.stringify(name)}, () => { expect(1).toBe(2); });`;

/** Starts a run at the building phase in a single-repo workspace whose suites are real `bun test` files. */
function buildingRun(options: {
  criteria: string[];
  /** The ACs as the ticket writes them (new scheme: local id, `verified_by`). Default: `criteria` as plain ACs. */
  ticketCriteria?: { id: string; verified_by?: string[] }[];
  /** Plan test cases. Default: one old-shape e2e case for each non-manual criterion. */
  testCases?: Record<string, unknown>[];
  e2e?: string[];
  unit?: string[];
  compose?: string;
  manual?: string[];
  roundBudget?: number;
  kind?: string;
  checks?: { name: string; repo: string; command: string }[];
}): { runId: string; runDirectory: string; workspace: string; arkHome: string } {
  const arkHome = tempArkHome();
  const workspace = tempGitRepo({
    "e2e.test.ts": suiteTests(options.e2e ?? []),
    "unit.test.ts": suiteTests(options.unit ?? []),
  });
  writeProject("demo", {
    workspace,
    ticket_source: "local",
    compose: options.compose,
    ...(options.checks === undefined ? {} : { checks: options.checks }),
    ...(options.roundBudget === undefined ? {} : { round_budget: options.roundBudget }),
    suites: [
      { name: "unit", level: "unit", repo: ".", command: junit("unit.test.ts"), parser: "bun" },
      { name: "e2e", level: "e2e", repo: ".", command: junit("e2e.test.ts"), parser: "bun" },
    ],
    roles,
  });
  const ticket = writeTicket(
    "demo",
    "FAKE-1",
    (options.ticketCriteria ?? options.criteria.map((id) => ({ id }))).map((criterion) => ({
      ...criterion,
      text: `criterion ${criterion.id}`,
      ...(options.manual?.includes(criterion.id) ? { manual: true } : {}),
    })),
    "Ticket FAKE-1",
    options.kind,
  );
  const runId = ark("run", "start", ticket, "--project", "demo").out.match(
    /\d{4}-\d{2}-\d{2}-FAKE-1-\d+/,
  )![0];
  const runDirectory = join(arkHome, "projects", "demo", "runs", runId);
  recordEvaluation(runDirectory);
  const plan = {
    design: { interfaces: [{ name: "fixture plan", callers: ["ark test"] }] },
    summary: {
      why: "Test the run against each criterion.",
      changes: options.criteria.map((criterion) => ({
        criterion,
        where: "tests",
        now: "Suites run against the plan.",
        fix: "Suites prove each criterion.",
      })),
    },
    steps: [
      {
        id: "build",
        role: "implementer",
        repo: ".",
        harness: "claude",
        model: "claude-sonnet",
        needs: [],
        criteria: options.criteria,
      },
    ],
    // A manual criterion needs no test case: `ark plan check` below must accept the plan without one.
    test_cases:
      options.testCases ??
      options.criteria
        .filter((criterion) => !options.manual?.includes(criterion))
        .map((criterion) => ({
          id: `proves-${criterion}`,
          criterion,
          level: "e2e",
          given: [],
          when: ["run it"],
          // oxlint-disable-next-line unicorn/no-thenable -- plan test-case field `then: string[]`, not a Promise-like
          then: ["it works"],
          expected: "it works",
        })),
  };
  writeFileSync(join(runDirectory, "plan.yml"), JSON.stringify(plan));
  for (const args of [
    ["plan", "check", runId],
    ["gate", "record", runId, "plan", "approve"],
    ["worktree", "create", runId, "."],
  ]) {
    const result = ark(...args);
    if (result.code !== 0) throw new Error(`${args.join(" ")} failed: ${result.err}`);
  }
  return { runId, runDirectory, workspace, arkHome };
}

function testCompleted(runDirectory: string) {
  const events = readFileSync(join(runDirectory, "events.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return events.filter((event) => event.type === "test.completed").map((event) => event.data);
}

function head(directory: string): string {
  return Bun.spawnSync(["git", "-C", directory, "rev-parse", "HEAD"]).stdout.toString().trim();
}

describe("ark test", () => {
  test("ARK-154-AC5 untagged tests never prove an AC and each AC gets passing, failing or missing", () => {
    const { runId, runDirectory } = buildingRun({
      criteria: ["FAKE-1-AC1", "FAKE-1-AC2", "FAKE-1-AC3", "FAKE-1-AC4"],
      e2e: [
        passing("FAKE-1-AC1 works"),
        failing("FAKE-1-AC2 breaks"),
        passing("an untagged test that passes"),
      ],
      unit: [passing("FAKE-1-AC3 unit test passes")],
    });
    const result = ark("test", runId);

    expect(result.code).toBe(1);
    expect(result.out).toContain("FAKE-1/AC1  passing");
    expect(result.out).toContain("FAKE-1/AC2  failing");
    expect(result.out).toContain("FAKE-1/AC3  missing");
    expect(result.out).toContain("FAKE-1/AC4  missing");
    expect(result.err).toContain("FAKE-1/AC2");
    expect(result.err).toContain("FAKE-1/AC4");
    expect(result.err).not.toContain("FAKE-1/AC1");
    expect(testCompleted(runDirectory)[0].criteria).toEqual({
      "FAKE-1/AC1": "passing",
      "FAKE-1/AC2": "failing",
      "FAKE-1/AC3": "missing",
      "FAKE-1/AC4": "missing",
    });
  });

  test("ARK-154-AC7 a passing unit suite never marks an AC as passed", () => {
    const { runId, runDirectory } = buildingRun({
      criteria: ["FAKE-1-AC1"],
      unit: [passing("FAKE-1-AC1 only a unit test covers this")],
    });
    const result = ark("test", runId);

    expect(result.code).toBe(1);
    expect(result.out).toContain("FAKE-1/AC1  missing");
    const [event] = testCompleted(runDirectory);
    expect(event.suites).toEqual([
      { name: "unit", level: "unit", passed: true },
      { name: "e2e", level: "e2e", passed: true },
    ]);
    expect(event.passed).toBe(false);
  });

  test("ARK-154-AC6 records suites and the head of each worktree, and exits 0 when every AC passes", () => {
    const { runId, runDirectory, workspace } = buildingRun({
      criteria: ["FAKE-1-AC1", "FAKE-1-AC2"],
      e2e: [passing("FAKE-1-AC1 works"), passing("FAKE-1-AC2 works")],
      unit: [passing("a plain unit test")],
    });
    const mirror = join(runDirectory, "workspace");
    Bun.spawnSync(["git", "-C", mirror, "commit", "--allow-empty", "-m", "work on the run branch"]);
    const result = ark("test", runId);

    expect(result.code).toBe(0);
    const [event] = testCompleted(runDirectory);
    expect(event).toEqual({
      passed: true,
      heads: { ".": head(mirror) },
      suites: [
        { name: "unit", level: "unit", passed: true },
        { name: "e2e", level: "e2e", passed: true },
      ],
      criteria: { "FAKE-1/AC1": "passing", "FAKE-1/AC2": "passing" },
    });
    expect(event.heads["."]).not.toBe(head(workspace));
    expect(readFileSync(join(runDirectory, "results/e2e.report"), "utf8")).toContain(
      "FAKE-1-AC1 works",
    );
    expect(readFileSync(join(runDirectory, "results/e2e.log"), "utf8")).toContain(
      "ark-log-marker FAKE-1-AC2 works",
    );
  });

  test("ARK-154-AC6 exits non-zero when a unit suite fails even though every AC passes", () => {
    const { runId, runDirectory } = buildingRun({
      criteria: ["FAKE-1-AC1"],
      e2e: [passing("FAKE-1-AC1 works")],
      unit: [failing("a broken unit test")],
    });
    const result = ark("test", runId);

    expect(result.code).toBe(1);
    expect(result.err).toContain("unit");
    const [event] = testCompleted(runDirectory);
    expect(event.criteria).toEqual({ "FAKE-1/AC1": "passing" });
    expect(event.passed).toBe(false);
  });

  test("ARK-154-AC3 runs suites in the mirror and skips compose when ark.yml has none", () => {
    const { runId, runDirectory } = buildingRun({
      criteria: ["FAKE-1-AC1"],
      e2e: [
        `test("FAKE-1-AC1 suite runs in the run's workspace mirror", () => { expect(process.cwd().endsWith("/workspace")).toBe(true); });`,
      ],
    });
    expect(ark("test", runId).code).toBe(0);
    expect(testCompleted(runDirectory)[0].criteria).toEqual({ "FAKE-1/AC1": "passing" });
  });

  test("ARK-T11 ark test runs compose up and down on the mirror and again for the base run", () => {
    const { runId, runDirectory, arkHome } = buildingRun({
      criteria: ["FAKE-1-AC1"],
      e2e: [failing("FAKE-1-AC1 breaks")],
      compose: `sh ${fakeCompose}`,
    });
    const composeLog = join(arkHome, "compose.log");
    process.env.COMPOSE_LOG = composeLog;
    try {
      expect(ark("test", runId).code).toBe(1);
    } finally {
      delete process.env.COMPOSE_LOG;
    }

    const mirror = join(runDirectory, "workspace");
    expect(existsSync(composeLog)).toBe(true);
    expect(readFileSync(composeLog, "utf8").trim().split("\n")).toEqual([
      `--project-directory ${mirror} -p ${runId.toLowerCase()} up -d --wait`,
      `--project-directory ${mirror} -p ${runId.toLowerCase()} down`,
      expect.stringMatching(
        new RegExp(`ark-base-\\w+ -p ${runId.toLowerCase()}-base up -d --wait$`),
      ),
      expect.stringMatching(new RegExp(`ark-base-\\w+ -p ${runId.toLowerCase()}-base down$`)),
    ]);
  });
});

describe("ark test with manual criteria", () => {
  const manualRun = (extra: { roundBudget?: number; e2e?: string[] } = {}) =>
    buildingRun({
      criteria: ["FAKE-1-AC1", "FAKE-1-AC2", "FAKE-1-AC3"],
      manual: ["FAKE-1-AC3"],
      e2e: [passing("FAKE-1-AC1 works"), passing("FAKE-1-AC2 works"), ...(extra.e2e ?? [])],
      roundBudget: extra.roundBudget,
    });
  const answer = (runId: string, value: string) =>
    ark("gate", "record", runId, "manual", "FAKE-1-AC3", value);
  const phaseOf = (runDirectory: string) =>
    JSON.parse(readFileSync(join(runDirectory, "state.json"), "utf8")).phase;

  test("ARK-283-AC1 a criterion with manual: true shows manual pending, manual ok or manual problem and only manual ok exits 0", () => {
    const { runId, runDirectory } = manualRun();

    const pending = ark("test", runId);
    expect(pending.code).toBe(1);
    expect(pending.out).toContain("FAKE-1/AC1  passing");
    expect(pending.out).toContain("FAKE-1/AC3  manual pending");
    expect(pending.err).toContain("FAKE-1/AC3 is manual pending");

    expect(answer(runId, "ok").code).toBe(0);
    const ok = ark("test", runId);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("FAKE-1/AC3  manual ok");

    expect(answer(runId, "problem").code).toBe(0);
    const problem = ark("test", runId);
    expect(problem.code).toBe(1);
    expect(problem.out).toContain("FAKE-1/AC3  manual problem");
    expect(problem.err).toContain("FAKE-1/AC3 is manual problem");

    expect(testCompleted(runDirectory).map((event) => event.criteria["FAKE-1/AC3"])).toEqual([
      "manual pending",
      "manual ok",
      "manual problem",
    ]);
  });

  test("ARK-283-AC1 a problem answer followed by ok reads manual ok", () => {
    const { runId } = manualRun();
    expect(answer(runId, "problem").code).toBe(0);
    expect(ark("test", runId).out).toContain("FAKE-1/AC3  manual problem");
    expect(answer(runId, "ok").code).toBe(0);
    const result = ark("test", runId);
    expect(result.out).toContain("FAKE-1/AC3  manual ok");
    expect(result.code).toBe(0);
  });

  test("ARK-283-AC1 manual pending on the last round keeps passed true and does not open the escalation gate", () => {
    const { runId, runDirectory } = manualRun({ roundBudget: 1 });
    const result = ark("test", runId);
    expect(result.code).toBe(1);
    expect(testCompleted(runDirectory)[0].passed).toBe(true);
    expect(phaseOf(runDirectory)).not.toBe("escalation");
    // The human can still answer the manual gate.
    expect(answer(runId, "ok").code).toBe(0);
  });

  test("ARK-283-AC1 a failing automated criterion still makes passed false next to a manual ok", () => {
    const { runId, runDirectory } = buildingRun({
      criteria: ["FAKE-1-AC1", "FAKE-1-AC2"],
      manual: ["FAKE-1-AC2"],
      e2e: [failing("FAKE-1-AC1 breaks")],
    });
    expect(ark("gate", "record", runId, "manual", "FAKE-1/AC2", "ok").code).toBe(0);
    expect(ark("test", runId).code).toBe(1);
    expect(testCompleted(runDirectory)[0].passed).toBe(false);
  });

  test("ARK-283-AC1 a manual criterion with a passing tagged test is still decided by the manual gate", () => {
    const { runId, runDirectory } = manualRun({ e2e: [passing("FAKE-1-AC3 tagged test passes")] });
    const result = ark("test", runId);
    expect(result.code).toBe(1);
    expect(result.out).toContain("FAKE-1/AC3  manual pending");
    expect(testCompleted(runDirectory)[0].criteria["FAKE-1/AC3"]).toBe("manual pending");
  });

  test("ARK-283-AC1 plan check accepted a plan with no test case for the manual criterion", () => {
    const { runDirectory } = manualRun();
    const plan = JSON.parse(readFileSync(join(runDirectory, "plan.yml"), "utf8"));
    expect(plan.test_cases.map((testCase: { criterion: string }) => testCase.criterion)).toEqual([
      "FAKE-1-AC1",
      "FAKE-1-AC2",
    ]);
    const events = readFileSync(join(runDirectory, "events.ndjson"), "utf8");
    expect(events).toContain('"type":"plan.checked"');
    expect(events).toContain('"valid":true');
  });
});

const checkFixtures = {
  passing: {
    name: "in-worktree",
    repo: ".",
    command: 'case "$PWD" in */workspace) ;; *) echo "ran in $PWD"; exit 1 ;; esac',
  },
  failing: {
    name: "lint-fail",
    repo: ".",
    command: 'i=1; while [ $i -le 25 ]; do echo "out-$i"; i=$((i + 1)); done; exit 1',
  },
};

describe("ark test checks", () => {
  test("ARK-302-AC1 a passing check in the repo worktree keeps passed true and prints nothing about it", () => {
    const { runId, runDirectory } = buildingRun({
      criteria: ["FAKE-1-AC1"],
      e2e: [passing("FAKE-1-AC1 works")],
      checks: [checkFixtures.passing],
    });
    const result = ark("test", runId);

    expect(result.code).toBe(0);
    expect(result.out).not.toContain("check in-worktree failed");
    expect(testCompleted(runDirectory)[0].passed).toBe(true);
  });

  test("ARK-302-AC1 a failing check records passed false, prints check <name> failed and the last 20 lines before the suites", () => {
    const { runId, runDirectory } = buildingRun({
      criteria: ["FAKE-1-AC1"],
      e2e: [passing("FAKE-1-AC1 works")],
      checks: [checkFixtures.passing, checkFixtures.failing],
    });
    const result = ark("test", runId);

    expect(result.code).toBe(1);
    expect(result.err).toContain("check lint-fail failed");
    expect(result.out).toContain("check lint-fail failed");
    expect(result.out).not.toContain("check in-worktree failed");
    const lines = result.out.split("\n");
    expect(lines).not.toContain("out-5");
    for (const line of ["out-6", "out-25"]) expect(lines).toContain(line);
    expect(result.out.indexOf("check lint-fail failed")).toBeLessThan(result.out.indexOf("suite "));
    // The suites still ran and the AC passes: only the check fails the run.
    expect(result.out).toContain("FAKE-1/AC1  passing");
    const [event] = testCompleted(runDirectory);
    expect(event.passed).toBe(false);
    expect(event.criteria).toEqual({ "FAKE-1/AC1": "passing" });
  });
});

describe("ark test on a refactor run", () => {
  const fixHead = (runDirectory: string) => {
    const mirror = join(runDirectory, "workspace");
    writeFileSync(join(mirror, "e2e.test.ts"), suiteTests([passing("FAKE-1-AC1 works")]));
    Bun.spawnSync(["git", "-C", mirror, "add", "-A"]);
    Bun.spawnSync(["git", "-C", mirror, "commit", "-q", "-m", "fix"]);
  };

  test("ARK-T12 a refactor run whose base fails exits 1, reruns the base on each ark test and merge-request open refuses", () => {
    const { runId, runDirectory } = buildingRun({
      kind: "refactor",
      criteria: ["FAKE-1-AC1"],
      e2e: [failing("FAKE-1-AC1 works")],
    });
    fixHead(runDirectory);

    const first = ark("test", runId);
    expect(first.code).toBe(1);
    expect(first.out).toContain("base      failed");
    const [event] = testCompleted(runDirectory);
    expect(event.base_passed).toBe(false);
    expect(event.passed).toBe(true);
    const baseLog = join(runDirectory, "results/base-e2e.log");
    expect(existsSync(baseLog)).toBe(true);

    // Second run: the base suites run again, so the log is written again.
    rmSync(baseLog);
    const second = ark("test", runId);
    expect(second.code).toBe(1);
    expect(testCompleted(runDirectory)[1].base_passed).toBe(false);
    expect(existsSync(baseLog)).toBe(true);

    const refused = ark("merge-request", "open", runId);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("base commit");
  });

  test("ARK-302-AC7 a base that passes records base_passed true and merge-request open no longer refuses on the base", () => {
    const { runId, runDirectory } = buildingRun({
      kind: "refactor",
      criteria: ["FAKE-1-AC1"],
      e2e: [passing("FAKE-1-AC1 works")],
    });

    const result = ark("test", runId);
    expect(result.code).toBe(0);
    expect(result.out).toContain("base      passed");
    expect(testCompleted(runDirectory)[0].base_passed).toBe(true);
    expect(ark("merge-request", "open", runId).err).not.toContain("base commit");
  });

  test("ARK-302-AC7 the base suites of a touched repo can read an untouched sibling repo", () => {
    const arkHome = tempArkHome();
    const workspace = mkdtempSync(join(tmpdir(), "ark-workspace-"));
    mkdirSync(join(workspace, "repos"));
    renameSync(
      tempGitRepo({
        "e2e.test.ts": suiteTests([
          `test("FAKE-1-AC1 reads the sibling", () => { expect(require("node:fs").readFileSync("../b/data.txt", "utf8")).toBe("sibling"); });`,
        ]),
      }),
      join(workspace, "repos/a"),
    );
    renameSync(tempGitRepo({ "data.txt": "sibling" }), join(workspace, "repos/b"));
    writeProject("demo", {
      workspace,
      ticket_source: "local",
      suites: [
        {
          name: "e2e",
          level: "e2e",
          repo: "repos/a",
          command: junit("e2e.test.ts"),
          parser: "bun",
        },
      ],
      roles,
    });
    const runId = ark(
      "run",
      "start",
      writeTicket("demo", "FAKE-1", [{ id: "FAKE-1-AC1", text: "reads" }], "Ticket", "refactor"),
      "--project",
      "demo",
    ).out.match(/\d{4}-\d{2}-\d{2}-FAKE-1-\d+/)![0];
    const runDirectory = join(arkHome, "projects", "demo", "runs", runId);
    recordEvaluation(runDirectory);
    writeFileSync(
      join(runDirectory, "plan.yml"),
      JSON.stringify({
        design: { interfaces: [{ name: "fixture plan", callers: ["ark test"] }] },
        summary: {
          why: "Test the base.",
          changes: [{ criterion: "FAKE-1-AC1", where: "a", now: "x", fix: "y" }],
        },
        steps: [
          {
            id: "build",
            role: "implementer",
            repo: "repos/a",
            harness: "claude",
            model: "claude-sonnet",
            needs: [],
            criteria: ["FAKE-1-AC1"],
          },
        ],
        test_cases: [
          {
            id: "proves",
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
      ["worktree", "create", runId, "repos/a"],
    ])
      expect(ark(...args).code).toBe(0);

    const result = ark("test", runId);
    expect(result.code).toBe(0);
    expect(result.out).toContain("base      passed");
    expect(testCompleted(runDirectory)[0].base_passed).toBe(true);
  });
});

describe("ark test verified_by join", () => {
  const addCase = (id: string, level: string) => ({
    id,
    action: "add",
    level,
    given: [],
    when: ["run it"],
    // oxlint-disable-next-line unicorn/no-thenable -- plan test-case field `then: string[]`, not a Promise-like
    then: ["it works"],
    expected: "it works",
  });

  test("ARK-311-AC2 decides an AC through its verified_by cases at every level and keeps the tag path for old ACs", () => {
    const { runId, runDirectory } = buildingRun({
      // AC1 needs two cases; AC2 shares one of them. AC3 has a failing case, AC4 a case with no result.
      // AC5 is served by a unit case and an e2e case. AC6 and AC7 are old-scheme ACs with no verified_by.
      criteria: [1, 2, 3, 4, 5].map((k) => `FAKE-1/AC${k}`).concat(["FAKE-1-AC6", "FAKE-1-AC7"]),
      ticketCriteria: [
        { id: "AC1", verified_by: ["FAKE-T1", "FAKE-T2"] },
        { id: "AC2", verified_by: ["FAKE-T1"] },
        { id: "AC3", verified_by: ["FAKE-T3"] },
        { id: "AC4", verified_by: ["FAKE-T4"] },
        { id: "AC5", verified_by: ["FAKE-T5", "FAKE-T6"] },
        { id: "FAKE-1-AC6" },
        { id: "FAKE-1-AC7" },
      ],
      testCases: [
        addCase("FAKE-T1", "e2e"),
        addCase("FAKE-T2", "e2e"),
        addCase("FAKE-T3", "e2e"),
        addCase("FAKE-T4", "e2e"),
        addCase("FAKE-T5", "unit"),
        addCase("FAKE-T6", "e2e"),
        { ...addCase("proves-AC6", "e2e"), action: "", criterion: "FAKE-1-AC6" },
        { ...addCase("proves-AC7", "e2e"), action: "", criterion: "FAKE-1-AC7" },
      ],
      e2e: [
        passing("FAKE-T1 serves two ACs"),
        passing("FAKE-T2 second case of AC1"),
        failing("FAKE-T3 breaks"),
        passing("FAKE-T6 e2e half of AC5"),
        passing("FAKE-1-AC6 old tag in an e2e suite"),
      ],
      unit: [
        passing("FAKE-T5 unit case counts for verified_by"),
        passing("FAKE-1-AC7 old tag in a unit suite"),
      ],
    });
    const result = ark("test", runId);

    expect(result.code).toBe(1);
    expect(testCompleted(runDirectory)[0].criteria).toEqual({
      "FAKE-1/AC1": "passing",
      "FAKE-1/AC2": "passing",
      "FAKE-1/AC3": "failing",
      "FAKE-1/AC4": "missing",
      "FAKE-1/AC5": "passing",
      "FAKE-1/AC6": "passing",
      "FAKE-1/AC7": "missing",
    });
    expect(result.out).toContain("FAKE-1/AC4  missing");
    expect(result.out).toContain("via FAKE-T4 missing");
    expect(result.err).toContain("FAKE-1/AC3 is failing");
    expect(result.err).toContain("FAKE-1/AC4 is missing");
    expect(result.err).toContain("FAKE-1/AC7 is missing");
  });
});
