import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deriveState, readEvents } from "../cli/events.ts";
import {
  ark,
  recordEvaluation,
  tempArkHome,
  tempGitRepo,
  writeEvidenceFile,
  writeFakeCommand,
  writeProject,
  writeTicket,
} from "./helpers.ts";
import {
  expectHookEndedOnlyItsRuns,
  holdRunners,
  macOnly,
  recordStartedRun,
  proveFixtureSkipsMemoryWait,
  stopHeld,
  stopStartedRuns,
} from "./orphan-runners.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

// ARK-419: no test-runner of a run this file started outlives its test.
afterEach(stopStartedRuns);

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
  ticketCriteria?: { id: string; method?: string; verified_by?: string[] }[];
  /** Plan test cases. Default: one old-shape e2e case for each non-manual criterion. */
  testCases?: Record<string, unknown>[];
  e2e?: string[];
  unit?: string[];
  /** Replaces the command of the e2e suite (default: `bun test` on e2e.test.ts through the JUnit reporter). */
  e2eCommand?: string;
  compose?: string;
  manual?: string[];
  roundBudget?: number;
  kind?: string;
  /** Gives each suite `base_files` that match no test file, so only a refactor run (the whole base) runs it at the base. */
  selectiveBase?: boolean;
  /** Extra fields for one suite, by suite name (for example `base_files` on the e2e suite only). */
  suiteOverrides?: Record<string, Record<string, unknown>>;
  checks?: { name: string; repo: string; command: string }[];
  /** Give the repo a GitHub origin whose pushes go to a local bare repo, so `merge-request open` can run against the fake `gh`. */
  forge?: boolean;
}): { runId: string; runDirectory: string; workspace: string; arkHome: string } {
  const arkHome = tempArkHome();
  const workspace = tempGitRepo({
    "e2e.test.ts": suiteTests(options.e2e ?? []),
    "unit.test.ts": suiteTests(options.unit ?? []),
  });
  if (options.forge) {
    const bare = join(mkdtempSync(join(tmpdir(), "ark-origin-")), "github.com", "org", "core.git");
    mkdirSync(bare, { recursive: true });
    for (const args of [
      ["-C", bare, "init", "--bare", "-q"],
      ["-C", workspace, "remote", "add", "origin", bare],
      ["-C", workspace, "push", "origin", "HEAD:refs/heads/main"],
      ["-C", workspace, "remote", "set-head", "origin", "main"],
    ])
      Bun.spawnSync(["git", ...args]);
  }
  writeProject("demo", {
    workspace,
    ticket_source: "local",
    test_min_free_memory_percent: 0,
    test_max_swap_gb: 1000,
    compose: options.compose,
    ...(options.checks === undefined ? {} : { checks: options.checks }),
    ...(options.roundBudget === undefined ? {} : { round_budget: options.roundBudget }),
    suites: [
      { name: "unit", level: "unit", repo: ".", command: junit("unit.test.ts"), parser: "bun" },
      {
        name: "e2e",
        level: "e2e",
        repo: ".",
        command: options.e2eCommand ?? junit("e2e.test.ts"),
        parser: "bun",
      },
    ].map((suite) =>
      options.selectiveBase
        ? { ...suite, base_files: "nomatch/*.test.ts", base_command: `${suite.command} # {files}` }
        : { ...suite, ...options.suiteOverrides?.[suite.name] },
    ),
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
  recordStartedRun({ runId, runDirectory });
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

  test("ARK-T135 records suites and the head of each worktree, and exits 0 when every AC passes", () => {
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
      checks: [
        { name: "old-id unit", passed: true },
        { name: "old-id e2e", passed: true },
        { name: "plan-membership unit", passed: true },
        { name: "plan-membership e2e", passed: true },
      ],
      criteria: { "FAKE-1/AC1": "passing", "FAKE-1/AC2": "passing" },
      mode: "full",
      duration: expect.any(Number),
      passed_count: 3,
      skipped: 0,
      base_skipped: 0,
      deleted: [],
    });
    expect(event.heads["."]).not.toBe(head(workspace));
    expect(readFileSync(join(runDirectory, "results/e2e.report"), "utf8")).toContain(
      "FAKE-1-AC1 works",
    );
    expect(readFileSync(join(runDirectory, "results/e2e.log"), "utf8")).toContain(
      "ark-log-marker FAKE-1-AC2 works",
    );
    expect(event).not.toHaveProperty("reused");
    expect(event).not.toHaveProperty("flaky");

    // An identical second call reuses the passed suites and records which ones.
    expect(ark("test", runId).code).toBe(0);
    const second = testCompleted(runDirectory).at(-1);
    expect(second.reused).toEqual(["head:unit", "head:e2e", "base:unit", "base:e2e"]);
    expect({ ...second, reused: undefined, duration: undefined }).toEqual({
      ...event,
      suites: [
        { name: "unit", level: "unit", passed: true, reused: true },
        { name: "e2e", level: "e2e", passed: true, reused: true },
      ],
      reused: undefined,
      duration: undefined,
    });
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

  // Real processes: the base suite holds until SIGTERM, and the wall clock is the only signal to poll.
  test("ARK-T171 an ark test killed during the base run leaves no worktree in the source repo", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "ark-marker-")), "at-base");
    const { runId, workspace } = buildingRun({
      criteria: ["FAKE-1-AC1"],
      e2e: [
        `test("FAKE-1-AC1 holds at base", async () => {
          if (!process.cwd().includes("/ark-base-")) return;
          require("node:fs").writeFileSync(${JSON.stringify(marker)}, "");
          await Bun.sleep(60_000);
        }, 120_000);`,
      ],
    });
    const child = Bun.spawn(["bun", join(import.meta.dir, "..", "cli", "ark.ts"), "test", runId], {
      env: process.env,
      stdout: "ignore",
      stderr: "ignore",
    });
    for (let waited = 0; !existsSync(marker); waited += 50) {
      if (waited > 25_000) throw new Error("the base run never started");
      await Bun.sleep(50);
    }
    // The runner outlives its caller: ark test --stop ends it and its suites.
    child.kill("SIGKILL");
    await child.exited;
    expect(ark("test", runId, "--stop").out).toContain("stopped the ark test");

    const worktrees = Bun.spawnSync(["git", "-C", workspace, "worktree", "list", "--porcelain"]);
    expect(worktrees.stdout.toString()).not.toContain("ark-base-");
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

describe("ark test on a failed suite", () => {
  test("ARK-T387 ark test prints the exit code, the log path and the last 20 log lines of a failed suite", () => {
    // The e2e command prints 40 marker lines to stderr, after the bun test output, and exits 3 (bun test exits 1).
    // The suite has no base_command, so no retry appends to the log after the command.
    const { runId, runDirectory } = buildingRun({
      criteria: ["FAKE-1-AC1"],
      e2e: [failing("FAKE-1-AC1 breaks")],
      unit: [passing("FAKE-1-AC1 unit works")],
      e2eCommand: `${junit("e2e.test.ts")}; for i in $(seq 1 40); do echo out-$i >&2; done; exit 3`,
    });
    const result = ark("test", runId);

    // The expected tail comes from the log on disk; check first that the log is the fixture this case describes.
    const logLines = readFileSync(join(runDirectory, "results/e2e.log"), "utf8")
      .trimEnd()
      .split("\n");
    const markers = Array.from({ length: 40 }, (_, index) => `out-${index + 1}`);
    expect(logLines.length).toBeGreaterThan(40);
    expect(logLines.slice(-40)).toEqual(markers);
    expect(logLines.filter((line) => line === "out-20" || line === "out-21")).toHaveLength(2);
    const tail = logLines.slice(-20);
    const boundary = logLines.at(-21)!;
    expect(tail[0]).toBe("out-21");
    expect(boundary).toBe("out-20");

    expect(result.code).not.toBe(0);
    expect(result.err).toContain("suite e2e failed");
    const lines = result.out.split("\n").map((line) => line.trim());
    const failedAt = lines.indexOf("suite      e2e (e2e)  failed");
    expect(failedAt).toBeGreaterThanOrEqual(0);

    // The tail is exactly the last 20 lines of the log: contiguous, in order, one line more or less fails.
    const tailStart = lines.indexOf(tail[0]!, failedAt);
    expect(lines.slice(tailStart, tailStart + 20)).toEqual(tail);
    expect(lines).not.toContain(boundary);
    expect(lines).not.toContain("out-1");
    expect(lines).toContain("out-40");

    // The exit code of the suite (3, not the 1 of bun test) and the run-relative log path come next to the failed line.
    expect(tailStart - failedAt).toBeLessThanOrEqual(5);
    const between = lines.slice(failedAt + 1, tailStart);
    expect(between.some((line) => /exit code/.test(line) && /\b3\b/.test(line))).toBe(true);
    expect(between.some((line) => line.includes("results/e2e.log"))).toBe(true);

    // A passed suite prints none of the three parts.
    expect(result.out).not.toContain("results/unit.log");
    expect(lines.filter((line) => line.includes("unit")).some((line) => /\b3\b/.test(line))).toBe(
      false,
    );
  });
});

describe("ark test on a refactor run", () => {
  const fixHead = (runDirectory: string, title = "FAKE-1-AC1 works") => {
    const mirror = join(runDirectory, "workspace");
    writeFileSync(join(mirror, "e2e.test.ts"), suiteTests([passing(title)]));
    Bun.spawnSync(["git", "-C", mirror, "add", "-A"]);
    Bun.spawnSync(["git", "-C", mirror, "commit", "-q", "-m", "fix"]);
  };

  test("ARK-T12 a refactor run whose base fails exits 1, reruns the base on each ark test and merge-request open refuses", () => {
    const { runId, runDirectory } = buildingRun({
      kind: "refactor",
      selectiveBase: true,
      criteria: ["FAKE-1-AC1"],
      ticketCriteria: [{ id: "FAKE-1-AC1", method: "test" }],
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

  test("ARK-T63 a refactor run with no method test AC is not refused for a failing or unrecorded base", () => {
    // The fake `gh` records its calls here.
    const fixtures = join(import.meta.dir, "fixtures/merge-request");
    let log = "";
    process.env.PATH = `${fixtures}:${(process.env.PATH ?? "")
      .split(":")
      .filter((entry) => entry !== fixtures)
      .join(":")}`;
    const created = () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter(Boolean)
            .filter((line) => JSON.parse(line).argv.includes("create")).length
        : 0;
    const openedCount = (runDirectory: string) =>
      readFileSync(join(runDirectory, "events.ndjson"), "utf8")
        .split("\n")
        .filter((line) => line.includes('"merge_request.opened"')).length;

    // Two states of a run with no method test AC: the base failed, and no base result was recorded.
    for (const unrecorded of [false, true]) {
      log = join(mkdtempSync(join(tmpdir(), "ark-fake-log-")), "calls.ndjson");
      process.env.FAKE_LOG = log;
      const { runId, runDirectory } = buildingRun({
        kind: "refactor",
        forge: true,
        criteria: ["FAKE-1-AC1"],
        ticketCriteria: [{ id: "FAKE-1-AC1", method: "inspection" }],
        testCases: [
          {
            id: "ARK-T1",
            criterion: "FAKE-1-AC1",
            level: "e2e",
            given: [],
            when: ["run it"],
            // oxlint-disable-next-line unicorn/no-thenable -- plan test-case field `then: string[]`, not a Promise-like
            then: ["it works"],
            expected: "it works",
          },
        ],
        e2e: [failing("ARK-T1 works")],
      });
      // A case-id title: touching an old-id test title fails `ark test`.
      fixHead(runDirectory, "ARK-T1 works");
      writeEvidenceFile(runDirectory, "FAKE-1-AC1", "inspection");
      expect(ark("gate", "record", runId, "manual", "FAKE-1-AC1", "ok").code).toBe(0);

      // The suites fail at base and pass at head.
      const result = ark("test", runId);
      expect(result.code, result.err + result.out).toBe(0);
      expect(result.out).toContain("base      failed");
      expect(result.err).not.toContain("the suites fail at the base commit");
      const [event] = testCompleted(runDirectory);
      expect(event.base_passed).toBe(false);
      if (unrecorded) {
        // An old log predates base_passed: drop it from the only test.completed event.
        const eventsFile = join(runDirectory, "events.ndjson");
        const lines = readFileSync(eventsFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const logged = JSON.parse(line);
            if (logged.type === "test.completed") delete logged.data.base_passed;
            return JSON.stringify(logged);
          });
        writeFileSync(eventsFile, `${lines.join("\n")}\n`);
        expect(testCompleted(runDirectory)).toHaveLength(1);
        expect(deriveState(readEvents(runDirectory)).base_passed).toBeUndefined();
      }

      const opened = ark("merge-request", "open", runId);
      expect(opened.code, opened.err + opened.out).toBe(0);
      expect(created()).toBe(1);
      expect(openedCount(runDirectory)).toBe(1);
    }
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

  /** The multi-repo refactor fixture: a run over repos/a whose base suites read repos/b. `extraTests` are more test lines of repos/a. */
  function siblingRun(extraTests: string[] = []) {
    const arkHome = tempArkHome();
    const workspace = mkdtempSync(join(tmpdir(), "ark-workspace-"));
    mkdirSync(join(workspace, "repos"));
    renameSync(
      tempGitRepo({
        "e2e.test.ts": suiteTests([
          `test("FAKE-1-AC1 reads the sibling", () => { expect(require("node:fs").readFileSync("../b/data.txt", "utf8")).toBe("sibling"); });`,
          ...extraTests,
        ]),
      }),
      join(workspace, "repos/a"),
    );
    renameSync(tempGitRepo({ "data.txt": "sibling" }), join(workspace, "repos/b"));
    writeProject("demo", {
      workspace,
      ticket_source: "local",
      test_min_free_memory_percent: 0,
      test_max_swap_gb: 1000,
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
    recordStartedRun({ runId, runDirectory });
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

    return { runId, runDirectory };
  }

  test("ARK-T244 the base suites of a touched repo can read an untouched sibling repo", () => {
    const { runId, runDirectory } = siblingRun();
    const result = ark("test", runId);
    expect(result.code).toBe(0);
    expect(result.out).toContain("base      passed");
    expect(testCompleted(runDirectory)[0].base_passed).toBe(true);
  });

  macOnly(
    "ARK-T235 the multi-repo demo fixture of test-run.test.ts finishes with free memory and swap past the default limits",
    async () => {
      await proveFixtureSkipsMemoryWait({
        start: (markerBody) => siblingRun([`test("FAKE-1-AC1 marks", () => { ${markerBody} });`]),
      });
    },
    120_000,
  );
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

  /** The hint lines that follow the `criterion  <id>` line, up to the next criterion, evidence or mode line. */
  const hintsAfter = (output: string, criterion: string): string[] => {
    const lines = output.split("\n");
    const start = lines.findIndex((line) => line.startsWith(`criterion  ${criterion} `));
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => /^(criterion|evidence|mode)\b/.test(line));
    return rest.slice(0, end === -1 ? undefined : end).map((line) => line.trim());
  };
  const hint = (id: string) => `no test title starts with ${id}`;

  test("ARK-T388 ark test says no test title starts with the id after the criterion line of a test case that reads missing", () => {
    // AC1: T1 passes, T2 and T3 have no test. AC2: T4 fails. AC3: matched by tag, no test.
    const fixture = (selectiveBase: boolean) =>
      buildingRun({
        selectiveBase,
        criteria: ["FAKE-1/AC1", "FAKE-1/AC2", "FAKE-1-AC3"],
        ticketCriteria: [
          { id: "AC1", verified_by: ["FAKE-T1", "FAKE-T2", "FAKE-T3"] },
          { id: "AC2", verified_by: ["FAKE-T4"] },
          { id: "FAKE-1-AC3" },
        ],
        testCases: [
          addCase("FAKE-T1", "e2e"),
          addCase("FAKE-T2", "e2e"),
          addCase("FAKE-T3", "e2e"),
          addCase("FAKE-T4", "e2e"),
          { ...addCase("proves-AC3", "e2e"), action: "", criterion: "FAKE-1-AC3" },
        ],
        e2e: [passing("FAKE-T1 passes"), failing("FAKE-T4 breaks")],
      });

    // Full run: one hint for each missing case, none for the passed or failed case or the tag criterion.
    const full = ark("test", fixture(false).runId);
    expect(full.out).toContain("via FAKE-T1 passed, FAKE-T2 missing, FAKE-T3 missing");
    expect(hintsAfter(full.out, "FAKE-1/AC1")).toEqual([hint("FAKE-T2"), hint("FAKE-T3")]);
    expect(hintsAfter(full.out, "FAKE-1/AC2")).toEqual([]);
    expect(full.out).toMatch(/criterion {2}FAKE-1\/AC3 {2}missing +via tag/);
    expect(hintsAfter(full.out, "FAKE-1/AC3")).toEqual([]);

    // Quick run, whole suites: the criterion reads `not run`, the cases still read `missing`, so the hint stays.
    const quick = ark("test", fixture(false).runId, "--quick");
    expect(quick.out).toMatch(
      /criterion {2}FAKE-1\/AC1 {2}not run .*FAKE-T2 missing, FAKE-T3 missing/,
    );
    expect(hintsAfter(quick.out, "FAKE-1/AC1")).toEqual([hint("FAKE-T2"), hint("FAKE-T3")]);
    expect(hintsAfter(quick.out, "FAKE-1/AC2")).toEqual([]);

    // Quick run with every suite skipped: the cases read `not run`, so no hint at all.
    const skipped = ark("test", fixture(true).runId, "--quick");
    expect(skipped.out).toMatch(/criterion {2}FAKE-1\/AC1 {2}not run .*FAKE-T2 not run/);
    expect(skipped.out).not.toContain("no test title starts with");
  });

  test("ARK-T388 ark test --quick prints no missing hint when the suite ran only the own-commit files", () => {
    // The e2e suite has base_files: a quick run runs only the own-commit file e2e.test.ts. FAKE-T1 passes in other.test.ts, a file of the same suite that the quick run does not select.
    const suiteCommand = "bun test --reporter=junit --reporter-outfile={report}";
    const { runId, runDirectory } = buildingRun({
      criteria: ["FAKE-1/AC1"],
      ticketCriteria: [{ id: "AC1", verified_by: ["FAKE-T1"] }],
      testCases: [addCase("FAKE-T1", "e2e")],
      e2e: [passing("unrelated test")],
      e2eCommand: `${suiteCommand} ./e2e.test.ts ./other.test.ts`,
      suiteOverrides: {
        e2e: { base_files: "e2e.test.ts", base_command: `${suiteCommand} {files}` },
      },
    });
    const mirror = join(runDirectory, "workspace");
    writeFileSync(join(mirror, "other.test.ts"), suiteTests([passing("FAKE-T1 passes")]));
    writeFileSync(
      join(mirror, "e2e.test.ts"),
      suiteTests([passing("unrelated test"), passing("changed own-commit test")]),
    );
    Bun.spawnSync(["git", "-C", mirror, "add", "-A"]);
    Bun.spawnSync(["git", "-C", mirror, "commit", "-q", "-m", "own test files"]);

    const quick = ark("test", runId, "--quick");
    expect(quick.out).toMatch(/criterion {2}FAKE-1\/AC1 {2}not run .*via FAKE-T1 missing/);
    expect(quick.out).not.toContain("no test title starts with");

    const full = ark("test", runId);
    expect(full.out).toMatch(/criterion {2}FAKE-1\/AC1 {2}passing .*via FAKE-T1 passed/);
  });
});

// --- ARK-404: owner file of every ark test temp root, and the missing-base message ---

/** Probe suite file: records, per side, the owner file of each temp root it can see, and the ancestor processes. */
const ownerProbe = (resultFile: string) =>
  suiteTests([
    `test("FAKE-1-AC1 probe", () => {
      const { readFileSync, writeFileSync, existsSync } = require("node:fs");
      const { spawnSync } = require("node:child_process");
      const { basename, dirname, join } = require("node:path");
      const ps = (field, pid) => spawnSync("ps", ["-o", field + "=", "-p", String(pid)]).stdout.toString().trim();
      const ancestors = [];
      for (let pid = process.pid; ; ) {
        const parent = Number(ps("ppid", pid));
        if (!(parent > 1)) break;
        ancestors.push({ pid: parent, command: ps("command", parent) });
        pid = parent;
      }
      const owner = (root) => {
        const file = join(root, "ark-owner.pid");
        return existsSync(file) ? readFileSync(file, "utf8") : null;
      };
      let base = null;
      for (let directory = process.cwd(); directory !== dirname(directory); directory = dirname(directory))
        if (basename(directory).startsWith("ark-base-")) base = directory;
      const roots = { suite: process.env.TMPDIR, evidence: process.env.ARK_EVIDENCE_DIR };
      if (base) roots.base = base;
      const found = {};
      for (const [kind, root] of Object.entries(roots)) found[kind] = { root, owner: owner(root) };
      writeFileSync(${JSON.stringify(resultFile)} + "." + (base ? "base" : "head"), JSON.stringify({ found, ancestors }));
    });`,
  ]);

describe("ark test temp roots (ARK-404)", () => {
  test("ARK-T189 ark-base, ark-evidence and ark-suite roots of ark test hold ark-owner.pid with the pid of the ark test runner", () => {
    const resultFile = join(mkdtempSync(join(tmpdir(), "ark-probe-")), "probe");
    const { runId } = buildingRun({ criteria: ["FAKE-1-AC1"], e2e: [ownerProbe(resultFile)] });
    const result = ark("test", runId);
    expect(result.code, result.err + result.out).toBe(0);

    for (const side of ["head", "base"]) {
      const { found, ancestors } = JSON.parse(readFileSync(`${resultFile}.${side}`, "utf8"));
      const runner = ancestors.find((entry: { command: string }) =>
        entry.command.includes("test-runner"),
      );
      expect(
        runner,
        `${side}: no test-runner ancestor in ${JSON.stringify(ancestors)}`,
      ).toBeDefined();
      const kinds = side === "base" ? ["base", "evidence", "suite"] : ["evidence", "suite"];
      expect(Object.keys(found).sort()).toEqual(kinds);
      for (const kind of kinds)
        expect(found[kind].owner, `${side} ${kind} ${found[kind].root}`).toBe(`${runner.pid}\n`);
    }
  });

  /** Runs `ark test` with a suite that deletes its own base checkout. `where` is the suite file that does it. */
  function runWithVanishingBase(where: "unit" | "e2e", compose?: string) {
    const marker = join(mkdtempSync(join(tmpdir(), "ark-marker-")), "base-root");
    const deleter = suiteTests([
      `test("FAKE-1-AC1 deletes the base checkout", () => {
        if (!process.cwd().includes("/ark-base-")) return;
        require("node:fs").writeFileSync(${JSON.stringify(marker)}, process.cwd());
        require("node:fs").rmSync(process.cwd(), { recursive: true, force: true });
      });`,
    ]);
    const built = buildingRun({
      criteria: ["FAKE-1-AC1"],
      unit: where === "unit" ? [deleter] : [passing("FAKE-1-AC1 unit")],
      e2e: where === "e2e" ? [deleter] : [passing("FAKE-1-AC1 e2e")],
      compose,
    });
    const result = ark("test", built.runId);
    return { ...built, result, marker };
  }

  function expectBaseMissing(run: ReturnType<typeof runWithVanishingBase>) {
    const output = run.result.out + run.result.err;
    const root = readFileSync(run.marker, "utf8");
    expect(output).toMatch(new RegExp(`base checkout missing: \\S*${root.split("/").pop()}`));
    expect(run.result.code, output).toBe(1);
    expect(output).not.toContain("ENOENT");
    expect(output).not.toContain("posix_spawn");
    // the head side ran and its evidence stays
    expect(existsSync(join(run.runDirectory, "results", "e2e.log"))).toBe(true);
  }

  test("ARK-T191 ark test exits 1 with base checkout missing when the first of two base suites deletes the base folder", () => {
    expectBaseMissing(runWithVanishingBase("unit"));
  }, 120_000);

  test("ARK-T191 ark test exits 1 with base checkout missing when the last base suite deletes the base folder", () => {
    expectBaseMissing(runWithVanishingBase("e2e"));
  }, 120_000);

  test("ARK-T191 ark test keeps the base checkout missing message when compose down runs with the folder gone", () => {
    const composeLog = join(mkdtempSync(join(tmpdir(), "ark-compose-")), "compose.log");
    process.env.COMPOSE_LOG = composeLog;
    try {
      expectBaseMissing(runWithVanishingBase("e2e", `sh ${fakeCompose}`));
    } finally {
      delete process.env.COMPOSE_LOG;
    }
  }, 120_000);

  test("ARK-T191 ark test with the base folder intact prints no base checkout missing and exits 0", () => {
    const { runId, runDirectory } = buildingRun({
      criteria: ["FAKE-1-AC1"],
      e2e: [passing("FAKE-1-AC1 intact")],
    });
    const result = ark("test", runId);
    expect(result.code, result.err + result.out).toBe(0);
    expect(result.out + result.err).not.toContain("base checkout missing");
    expect(existsSync(join(runDirectory, "results", "base-e2e.log"))).toBe(true);
  }, 120_000);

  test("ARK-T194 the owner file of the evidence scratch folder is in neither the test cache nor the evidence, and a cache hit gives the same statuses", () => {
    const { runId, runDirectory, arkHome } = buildingRun({
      criteria: ["FAKE-1-AC1"],
      e2e: [passing("FAKE-1-AC1 caches")],
    });
    const stray = (directory: string) =>
      existsSync(directory)
        ? (readdirSync(directory, { recursive: true }) as string[]).filter((entry) =>
            entry.endsWith("ark-owner.pid"),
          )
        : [];
    for (const attempt of [1, 2]) {
      const result = ark("test", runId);
      expect(result.code, result.err + result.out).toBe(0);
      expect(stray(join(runDirectory, "results", "evidence")), `evidence, run ${attempt}`).toEqual(
        [],
      );
      expect(
        stray(join(arkHome, "projects", "demo", "test-cache")),
        `cache, run ${attempt}`,
      ).toEqual([]);
    }
    expect(existsSync(join(arkHome, "projects", "demo", "test-cache"))).toBe(true);
    const [first, second] = testCompleted(runDirectory);
    expect(second.criteria).toEqual(first.criteria);
  }, 120_000);
});

// ARK-419: the demo fixture of this suite ends no suite on a memory wait and leaves no runner behind.
const orphanFixture = {
  start: (body: string) =>
    buildingRun({
      criteria: ["FAKE-1-AC1"],
      e2e: [`test("FAKE-1-AC1 holds", async () => { ${body} }, 400_000);`],
    }),
};

// The file-level afterEach of this suite stops the runs it started; the first test leaves two runners for it.
describe("ARK-T236 runners after the suite hook", () => {
  afterAll(stopHeld);
  macOnly(
    "ARK-T236 a runner that ignores SIGTERM runs beside a runner the test started",
    () => holdRunners(orphanFixture),
    120_000,
  );
  macOnly(
    "ARK-T236 after the suite hook ends, no test-runner process of a run the suite started remains and the runner of another run lives",
    expectHookEndedOnlyItsRuns,
    60_000,
  );
});

macOnly(
  "ARK-T235 the demo fixture of this suite finishes with free memory and swap past the default limits",
  () => proveFixtureSkipsMemoryWait(orphanFixture),
  120_000,
);

// ARK-423: a git process of a suite starts background maintenance in a repo (maintenance.lock, gc.pid), and a later
// cpSync of the template or a git call races it. The config is read where git runs, through a shim on PATH, at every
// entry point: this process, the `ark` CLI children, `ark test` and a Playwright launch that starts from a clean environment.
describe("git automatic maintenance in the suites (ARK-423)", () => {
  const realGit = "/usr/bin/git";
  const repositoryRoot = join(import.meta.dir, "..");
  const settings = "maintenance.auto=false gc.auto=0";
  const shimScript = [
    `m=$(${realGit} config --get maintenance.auto || echo unset)`,
    `g=$(${realGit} config --get gc.auto || echo unset)`,
    `echo "$* maintenance.auto=$m gc.auto=$g" >> "\${ARK_T261_LOG:-/dev/null}"`,
    `exec ${realGit} "$@"`,
  ].join("\n");
  const linesOf = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean);
  const gitDirectories = (directory: string) =>
    ["--git-dir", "--git-common-dir"].map((flag) =>
      resolve(
        directory,
        Bun.spawnSync([realGit, "-C", directory, "rev-parse", flag]).stdout.toString().trim(),
      ),
    );

  test("ARK-T261 every git process of the suites, including those started by `ark worktree create`, `ark test` and Playwright, runs with automatic maintenance and gc off", () => {
    const savedPath = process.env.PATH;
    const savedLog = process.env.ARK_T261_LOG;
    const logs = mkdtempSync(join(tmpdir(), "ark-t261-"));
    const logFor = (entry: string) => {
      const file = join(logs, entry);
      writeFileSync(file, "");
      process.env.ARK_T261_LOG = file;
      return file;
    };
    try {
      const shim = writeFakeCommand("git", shimScript);

      // Entry point `bun test`: a fresh file set forces a template build; then a commit in the copy.
      const bunLog = logFor("bun");
      const repo = tempGitRepo({ "README.md": `unique ${logs}\n` });
      expect(
        Bun.spawnSync(["git", "-C", repo, "commit", "--allow-empty", "-q", "-m", "more"]).exitCode,
      ).toBe(0);

      // Entry points `ark worktree create` (inside buildingRun) and a commit in the worktree it made.
      const worktreeLog = logFor("worktree");
      const { runId, runDirectory } = buildingRun({
        criteria: ["FAKE-1-AC1"],
        unit: [`test("git runs", () => { Bun.spawnSync(["git", "status"]); });`],
      });
      const mirror = join(runDirectory, "workspace");
      expect(
        Bun.spawnSync(["git", "-C", mirror, "commit", "--allow-empty", "-q", "-m", "work"])
          .exitCode,
      ).toBe(0);

      // Entry point `ark test`: its suite starts git.
      const testLog = logFor("ark-test");
      ark("test", runId);

      // Entry point Playwright: its own process, from a clean environment, with the project's config.
      const scratch = mkdtempSync(join(logs, "pw-"));
      const playwright = join(repositoryRoot, "node_modules", "@playwright", "test");
      writeFileSync(
        join(scratch, "playwright.config.ts"),
        [
          `import { defineConfig } from ${JSON.stringify(playwright)};`,
          `import base from ${JSON.stringify(join(repositoryRoot, "playwright.config.ts"))};`,
          `export default defineConfig({ ...base, testDir: ${JSON.stringify(scratch)}, globalTeardown: undefined, outputDir: ${JSON.stringify(join(scratch, "out"))}, reporter: "line" });`,
        ].join("\n"),
      );
      writeFileSync(
        join(scratch, "git.pw.ts"),
        [
          `import { test } from ${JSON.stringify(playwright)};`,
          `import { execFileSync } from "node:child_process";`,
          `test("git runs", () => { execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.env.ARK_T261_REPO }); });`,
        ].join("\n"),
      );
      const playwrightLog = logFor("playwright");
      const launched = Bun.spawnSync(
        ["bunx", "playwright", "test", "--config", join(scratch, "playwright.config.ts")],
        {
          cwd: repositoryRoot,
          env: {
            PATH: `${shim}:${savedPath}`,
            HOME: process.env.HOME as string,
            ARK_T261_LOG: playwrightLog,
            ARK_T261_REPO: repo,
          },
        },
      );
      expect(launched.exitCode, launched.stdout.toString() + launched.stderr.toString()).toBe(0);

      // Every entry point ran git, and every git call saw both settings.
      const observed = {
        bun: linesOf(bunLog),
        worktree: linesOf(worktreeLog),
        arkTest: linesOf(testLog),
        playwright: linesOf(playwrightLog),
      };
      expect(observed.bun.some((line) => line.includes(" commit "))).toBe(true);
      expect(observed.worktree.some((line) => line.includes("worktree add"))).toBe(true);
      expect(observed.worktree.some((line) => line.includes(" commit "))).toBe(true);
      expect(observed.arkTest.some((line) => line.startsWith("status "))).toBe(true);
      expect(observed.playwright.some((line) => line.startsWith("rev-parse HEAD "))).toBe(true);
      expect(
        Object.fromEntries(
          Object.entries(observed).map(([entry, lines]) => [
            entry,
            lines.filter((line) => !line.endsWith(settings)),
          ]),
        ),
      ).toEqual({ bun: [], worktree: [], arkTest: [], playwright: [] });

      // No maintenance or gc process left its lock in either repo.
      for (const directory of [repo, mirror].flatMap(gitDirectories))
        for (const lock of ["maintenance.lock", "objects/maintenance.lock", "gc.pid"])
          expect(existsSync(join(directory, lock))).toBe(false);
    } finally {
      process.env.PATH = savedPath;
      if (savedLog === undefined) delete process.env.ARK_T261_LOG;
      else process.env.ARK_T261_LOG = savedLog;
    }
  }, 180_000);
});

describe("ark test runs only the suites of the repos in the run (ARK-416)", () => {
  /** A workspace of repos/a and repos/b with a suite for each and one for `.`; the suites touch markers in `markers`. */
  function repoFilterRun(options: { worktrees: string[]; kind?: string; bCommand: string }) {
    const arkHome = tempArkHome();
    const markers = mkdtempSync(join(tmpdir(), "ark-markers-"));
    // The workspace is itself a repo (`.`) with the two repos nested in it.
    const workspace = tempGitRepo({ "dot.txt": "dot" });
    mkdirSync(join(workspace, "repos"));
    const files = { "e2e.test.ts": suiteTests([passing("FAKE-T0 runs in a")]) };
    renameSync(tempGitRepo(files), join(workspace, "repos/a"));
    renameSync(
      tempGitRepo({ "e2e.test.ts": suiteTests([passing("FAKE-T1 runs in b")]) }),
      join(workspace, "repos/b"),
    );
    const report = "--reporter=junit --reporter-outfile={report} ./e2e.test.ts";
    writeProject("demo", {
      workspace,
      ticket_source: "local",
      test_min_free_memory_percent: 0,
      test_max_swap_gb: 1000,
      suites: [
        {
          name: "suite-a",
          level: "e2e",
          repo: "repos/a",
          command: `sh -c 'touch ${markers}/a.marker; bun test ${report}'`,
          parser: "bun",
        },
        {
          name: "suite-b",
          level: "e2e",
          repo: "repos/b",
          command: options.bCommand.replaceAll("MARKERS", markers).replaceAll("REPORT", report),
          parser: "bun",
        },
        {
          name: "suite-dot",
          level: "e2e",
          repo: ".",
          command: `sh -c 'touch ${markers}/dot.marker; echo "<testsuites/>" > {report}'`,
          parser: "bun",
        },
      ],
      roles,
    });
    const ticket = writeTicket(
      "demo",
      "FAKE-1",
      [{ id: "AC1", text: "b is proved", method: "test", verified_by: ["FAKE-T1"] }],
      "Ticket",
      options.kind,
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
          why: "Test the repo filter.",
          changes: [{ criterion: "FAKE-1/AC1", where: "a", now: "x", fix: "y" }],
        },
        steps: [
          {
            id: "build",
            role: "implementer",
            repo: "repos/a",
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
      ...[".", ...options.worktrees].map((repo) => ["worktree", "create", runId, repo]),
    ])
      expect(ark(...args).code).toBe(0);
    return { runId, runDirectory, markers };
  }
  const bFails = "sh -c 'touch MARKERS/b.marker; exit 1'";
  const bPasses = "sh -c 'touch MARKERS/b.marker; bun test REPORT'";

  test("ARK-T323 the head pass of ark test skips the suite of a repo the run has no worktree for, prints the skipped line, and runs nothing there", () => {
    const { runId, runDirectory, markers } = repoFilterRun({
      worktrees: ["repos/a"],
      bCommand: bPasses,
    });
    const result = ark("test", runId);

    expect(result.out).toContain("skipped suite-b (repo repos/b not in run)");
    expect(result.out).not.toContain("suite suite-b head");
    expect(result.out).toContain("via FAKE-T1 missing");
    expect(existsSync(join(markers, "a.marker"))).toBe(true);
    expect(existsSync(join(markers, "dot.marker"))).toBe(true);
    expect(existsSync(join(markers, "b.marker"))).toBe(false);
    const [event] = testCompleted(runDirectory);
    expect(event.suites.map((suite: { name: string }) => suite.name).toSorted()).toEqual([
      "suite-a",
      "suite-dot",
    ]);
    for (const log of ["suite-b.log", "base-suite-b.log"])
      expect(existsSync(join(runDirectory, "results", log))).toBe(false);
    expect(existsSync(join(runDirectory, "results/suite-a.log"))).toBe(true);
    expect(existsSync(join(runDirectory, "results/suite-dot.log"))).toBe(true);
  });

  test("ARK-T324 the base pass of ark test passes when only an untouched repo has a failing suite, and does not run that suite", () => {
    const { runId, runDirectory, markers } = repoFilterRun({
      worktrees: ["repos/a"],
      kind: "refactor",
      bCommand: bFails,
    });
    const result = ark("test", runId);

    expect(result.out).toContain("base      passed");
    expect(result.out).toContain("skipped suite-b (repo repos/b not in run)");
    expect(existsSync(join(markers, "b.marker"))).toBe(false);
    const [event] = testCompleted(runDirectory);
    expect(event.base_passed).toBe(true);
    expect(event.suites.some((suite: { name: string }) => suite.name === "suite-b")).toBe(false);
    for (const log of ["suite-b.log", "base-suite-b.log"])
      expect(existsSync(join(runDirectory, "results", log))).toBe(false);

    // Control: with a worktree for b, the same suite runs and fails the base.
    const control = repoFilterRun({
      worktrees: ["repos/a", "repos/b"],
      kind: "refactor",
      bCommand: bFails,
    });
    const failed = ark("test", control.runId);
    expect(existsSync(join(control.markers, "b.marker"))).toBe(true);
    expect(failed.out).toContain("base      failed");
    expect(testCompleted(control.runDirectory)[0].base_passed).toBe(false);
    expect(failed.err).toContain("refactor run: the suites fail at the base commit");
  });
});
