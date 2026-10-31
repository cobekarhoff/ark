import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ark, tempArkHome, tempGitRepo, writeProject, writeTicket } from "./helpers.ts";

const criteria = [
  { id: "ARK-900-AC1", text: "first" },
  { id: "ARK-900-AC2", text: "second" },
];

const step = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  role: "implementer",
  repo: ".",
  harness: "claude",
  model: "claude-sonnet",
  needs: [],
  criteria: ["ARK-900-AC1"],
  ...overrides,
});

const testCase = (id: string, criterion: string, level = "integration") => ({
  id,
  criterion,
  level,
  given: [],
  when: ["do the thing"],
  then: ["the task completes"],
  expected: "the system shall complete the task",
});

type PlanDocument = {
  summary: { why: string; changes: { criterion: string; where: string; now: string; fix: string }[] };
  steps: Record<string, any>[];
  test_cases: Record<string, any>[];
};

const validPlan = (): PlanDocument => ({
  summary: {
    why: "Make the plan readable.",
    changes: [
      { criterion: "ARK-900-AC1", where: "cli/plan.ts", now: "Writes plan.yml.", fix: "Write plan.md." },
      { criterion: "ARK-900-AC2", where: "cli/plan.ts", now: "No summary.", fix: "Require summary." },
    ],
  },
  steps: [step("build"), step("check", { role: "validator", needs: ["build"] })],
  test_cases: [testCase("t1", "ARK-900-AC1"), testCase("t2", "ARK-900-AC2", "e2e")],
});

let runDirectory: string;
let runId: string;

beforeEach(() => {
  tempArkHome();
  const projectDirectory = writeProject("demo", {
    workspace: tempGitRepo(),
    ticket_source: "local",
    suites: [{ name: "e2e", level: "e2e", repo: ".", command: "true", parser: "bun" }],
    roles: {
      implementer: { harness: "claude", model: "claude-sonnet" },
      validator: { harness: "codex", model: "gpt-codex" },
      reviewer: { harness: "codex", model: "gpt-codex" },
    },
  });
  const ticket = writeTicket("demo", "ARK-900", criteria);
  expect(ark("run", "start", ticket).code).toBe(0);
  runId = readdirSync(join(projectDirectory, "runs"))[0];
  runDirectory = join(projectDirectory, "runs", runId);
});

const writePlan = (plan: unknown) => writeFileSync(join(runDirectory, "plan.yml"), JSON.stringify(plan));
const events = () =>
  readFileSync(join(runDirectory, "events.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));

describe("plan check", () => {
  test("ARK-153-AC1 exits 0 for a valid plan and appends plan.checked", () => {
    writePlan(validPlan());
    const result = ark("plan", "check", runId);
    expect(result.code).toBe(0);
    const checked = events().findLast((event) => event.type === "plan.checked");
    expect(checked.data.valid).toBe(true);
    expect(checked.data.problems).toEqual([]);
    expect(checked.data.plan_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(checked.data.steps).toEqual([
      { id: "build", role: "implementer", repo: ".", needs: [], criteria: ["ARK-900-AC1"] },
      { id: "check", role: "validator", repo: ".", needs: ["build"], criteria: ["ARK-900-AC1"] },
    ]);
  });

  test("ARK-153-AC1 refuses a missing or unparsable plan.yml and appends nothing", () => {
    const before = events().length;
    expect(ark("plan", "check", runId).code).toBe(1);
    writeFileSync(join(runDirectory, "plan.yml"), "steps: [unclosed");
    const result = ark("plan", "check", runId);
    expect(result.code).toBe(1);
    expect(result.err).toContain("plan.yml");
    expect(events().length).toBe(before);
  });

  test("ARK-153-AC1 refuses an unknown run", () => {
    const result = ark("plan", "check", "2000-01-01-NOPE-1");
    expect(result.code).toBe(1);
  });

  // Each row is one refusal class: the plan edit, and the text the message must contain.
  const refusals: [string, (plan: PlanDocument) => void, string][] = [
    ["a cycle in needs, naming the steps", (plan) => { plan.steps[0].needs = ["check"]; }, "build -> check -> build"],
    ["a needs entry that is not a step", (plan) => { plan.steps[1].needs = ["ghost"]; }, 'step check needs "ghost"'],
    ["a duplicate step id", (plan) => { plan.steps[1].id = "build"; }, "duplicate step id: build"],
    ["a step with no repo", (plan) => { delete plan.steps[1].repo; }, "step check has no repo"],
    ["a step with no role", (plan) => { delete plan.steps[1].role; }, "step check has no role"],
    ["an unknown role", (plan) => { plan.steps[1].role = "wizard"; }, 'unknown role "wizard"'],
    ["a step with no harness", (plan) => { delete plan.steps[0].harness; }, "step build has no harness"],
    ["a step with no model", (plan) => { delete plan.steps[0].model; }, "step build has no model"],
    ["a test case level that is not integration or e2e", (plan) => { plan.test_cases[0].level = "unit"; }, 'test case t1 has level "unit"'],
    ["a test case for an unknown criterion", (plan) => { plan.test_cases[1].criterion = "ARK-900-AC9"; }, "ARK-900-AC9"],
  ];
  for (const [name, edit, expected] of refusals) {
    test(`ARK-153-AC2 refuses ${name}`, () => {
      const plan = validPlan();
      edit(plan);
      writePlan(plan);
      const result = ark("plan", "check", runId);
      expect(result.code).toBe(1);
      expect(result.out).toContain(expected);
      const checked = events().findLast((event) => event.type === "plan.checked");
      expect(checked.data.valid).toBe(false);
      expect(checked.data.problems.join("\n")).toContain(expected);
      expect(existsSync(join(runDirectory, "plan.md"))).toBe(false);
    });
  }

  test("ARK-153-AC2 reports every problem on its own line", () => {
    const plan = validPlan();
    plan.steps[0].needs = ["ghost"];
    delete plan.steps[1].repo;
    plan.test_cases[0].level = "unit";
    writePlan(plan);
    const lines = ark("plan", "check", runId).out.trim().split("\n");
    expect(lines.some((line) => line.includes('"ghost"'))).toBe(true);
    expect(lines.some((line) => line.includes("has no repo"))).toBe(true);
    expect(lines.some((line) => line.includes('level "unit"'))).toBe(true);
    // the unit-level test case no longer proves AC1
    expect(lines.some((line) => line.includes("ARK-900-AC1 has no integration or e2e"))).toBe(true);
  });

  test("ARK-153-AC3 refuses a criterion with no integration or e2e test case and names it", () => {
    const plan = validPlan();
    plan.test_cases = [plan.test_cases[0]];
    writePlan(plan);
    const result = ark("plan", "check", runId);
    expect(result.code).toBe(1);
    expect(result.out).toContain("ARK-900-AC2 has no integration or e2e test case");
    expect(result.out).not.toContain("ARK-900-AC1 has no");
  });
  test("ARK-166-AC2 rejects a plan without summary", () => {
    const plan = validPlan();
    delete (plan as Partial<PlanDocument>).summary;
    writePlan(plan);
    const result = ark("plan", "check", runId);
    expect(result.code).toBe(1);
    expect(result.out).toContain("plan.yml has no summary.why");
  });

  test("ARK-166-AC2 rejects a summary change without fix", () => {
    const plan = validPlan();
    delete (plan.summary.changes[0] as Partial<PlanDocument["summary"]["changes"][number]>).fix;
    writePlan(plan);
    const result = ark("plan", "check", runId);
    expect(result.code).toBe(1);
    expect(result.out).toContain("summary change #1 has no fix");
  });

  test("ARK-166-AC2 rejects a ticket criterion with no summary row", () => {
    const plan = validPlan();
    plan.summary.changes.pop();
    writePlan(plan);
    const result = ark("plan", "check", runId);
    expect(result.code).toBe(1);
    expect(result.out).toContain("criterion ARK-900-AC2 has no row in summary.changes");
  });

  test("ARK-166-AC2 rejects a summary row for a criterion not in the ticket", () => {
    const plan = validPlan();
    plan.summary.changes[1].criterion = "ARK-900-AC9";
    writePlan(plan);
    const result = ark("plan", "check", runId);
    expect(result.code).toBe(1);
    expect(result.out).toContain('criterion "ARK-900-AC9", which is not in the ticket');
  });

  test("ARK-166-AC1 renders plan.md with summary, change table, Mermaid steps and Gherkin cases", () => {
    writePlan(validPlan());
    expect(ark("plan", "check", runId).code).toBe(0);
    const first = readFileSync(join(runDirectory, "plan.md"), "utf8");
    expect(first).toContain("# Plan\n\n## Summary\n\nMake the plan readable.");
    expect(first).toContain("| Criterion | Where | Now | Fix |");
    expect(first).toContain("| ARK-900-AC1 | cli/plan.ts | Writes plan.yml. | Write plan.md. |");
    expect(first).toContain("```mermaid\nflowchart LR\n");
    expect(existsSync(join(runDirectory, "plan.mmd"))).toBe(false);
    expect(ark("plan", "check", runId).code).toBe(0);
    expect(readFileSync(join(runDirectory, "plan.md"), "utf8")).toBe(first);
  });
});
