import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ark, tempArkHome, tempGitRepo, writeProject, writeTicket } from "./helpers.ts";

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
  e2e?: string[];
  unit?: string[];
  compose?: string;
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
    suites: [
      { name: "unit", level: "unit", repo: ".", command: junit("unit.test.ts"), parser: "bun" },
      { name: "e2e", level: "e2e", repo: ".", command: junit("e2e.test.ts"), parser: "bun" },
    ],
    roles,
  });
  const ticket = writeTicket(
    "demo",
    "FAKE-1",
    options.criteria.map((id) => ({ id, text: `criterion ${id}` })),
  );
  const runId = ark("run", "start", ticket, "--project", "demo").out.match(
    /\d{4}-\d{2}-\d{2}-FAKE-1-\d+/,
  )![0];
  const runDirectory = join(arkHome, "projects", "demo", "runs", runId);
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
    test_cases: options.criteria.map((criterion) => ({
      id: `proves-${criterion}`,
      criterion,
      level: "e2e",
      given: [],
      when: ["run it"],
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
    expect(result.out).toContain("FAKE-1-AC1  passing");
    expect(result.out).toContain("FAKE-1-AC2  failing");
    expect(result.out).toContain("FAKE-1-AC3  missing");
    expect(result.out).toContain("FAKE-1-AC4  missing");
    expect(result.err).toContain("FAKE-1-AC2");
    expect(result.err).toContain("FAKE-1-AC4");
    expect(result.err).not.toContain("FAKE-1-AC1");
    expect(testCompleted(runDirectory)[0].criteria).toEqual({
      "FAKE-1-AC1": "passing",
      "FAKE-1-AC2": "failing",
      "FAKE-1-AC3": "missing",
      "FAKE-1-AC4": "missing",
    });
  });

  test("ARK-154-AC7 a passing unit suite never marks an AC as passed", () => {
    const { runId, runDirectory } = buildingRun({
      criteria: ["FAKE-1-AC1"],
      unit: [passing("FAKE-1-AC1 only a unit test covers this")],
    });
    const result = ark("test", runId);

    expect(result.code).toBe(1);
    expect(result.out).toContain("FAKE-1-AC1  missing");
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
      criteria: { "FAKE-1-AC1": "passing", "FAKE-1-AC2": "passing" },
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
    expect(event.criteria).toEqual({ "FAKE-1-AC1": "passing" });
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
    expect(testCompleted(runDirectory)[0].criteria).toEqual({ "FAKE-1-AC1": "passing" });
  });

  test("ARK-154-AC3 runs compose up on the mirror before the suites and compose down afterwards, even when a suite fails", () => {
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
    ]);
  });
});
