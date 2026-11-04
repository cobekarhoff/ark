import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent, deriveState, readEvents } from "../cli/events.ts";
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

const criteria = [{ id: "ARK-902-AC1", text: "first" }];

const baseConfig = () => ({
  workspace: tempGitRepo(),
  ticket_source: "local",
  suites: [{ name: "cli", level: "integration", repo: ".", command: "true", parser: "bun" }],
  roles: {
    implementer: { harness: "omp", model: "pi/task" },
    validator: { harness: "omp", model: "pi/validate" },
    reviewer: { harness: "omp", model: "pi/validate" },
    evaluator: { harness: "omp", model: "pi/validate" },
    designer: { harness: "omp", model: "pi/design" },
  },
});

const planWith = (decisions: unknown[] = []) => ({
  design: { interfaces: [{ name: "fixture plan", callers: ["ark plan check"] }] },
  summary: {
    why: "Track the work for each criterion.",
    changes: criteria.map(({ id }) => ({
      criterion: id,
      where: "cli",
      now: "Nothing.",
      fix: "Something.",
    })),
  },
  decisions,
  steps: [
    {
      id: "build",
      role: "implementer",
      repo: ".",
      harness: "omp",
      model: "pi/task",
      needs: [],
      criteria: criteria.map(({ id }) => id),
    },
  ],
  test_cases: criteria.map(({ id }) => ({
    id: `case-${id}`,
    criterion: id,
    level: "integration",
    given: [],
    when: ["act"],
    // oxlint-disable-next-line unicorn/no-thenable -- plan test-case field `then: string[]`, not a Promise-like
    then: ["ok"],
    expected: "ok",
  })),
});

const card = (id: string, recommended: "yes" | "no") =>
  `## ${id} ${id} approach\nApproach: Keep the change small.\nInterfaces: cli/strategy.ts.\nTradeoffs: Small change.\nSteps: Implement.\nRecommended: ${recommended}\n`;

let projectDirectory: string;

beforeEach(() => {
  tempArkHome();
});

/** Writes the project with the given gates and starts a run; the evaluation is not recorded yet. */
function startRun(gates?: Record<string, unknown>) {
  projectDirectory = writeProject("demo", { ...baseConfig(), ...(gates ? { gates } : {}) });
  expect(ark("run", "start", writeTicket("demo", "ARK-902", criteria)).code).toBe(0);
  const runId = readdirSync(join(projectDirectory, "runs"))[0];
  const directory = join(projectDirectory, "runs", runId);
  return { runId, directory };
}

const eventsOf = (directory: string) => readEvents(directory);
const answers = (directory: string, gate: string) =>
  eventsOf(directory).filter((event) => event.type === "gate.answered" && event.data.gate === gate);

function checkPlan(runId: string, directory: string, decisions: unknown[] = []) {
  writeFileSync(join(directory, "plan.yml"), JSON.stringify(planWith(decisions)));
  return ark("plan", "check", runId);
}

test("ARK-234-AC1 a gates value other than human or auto exits 1 and names the field", () => {
  writeProject("demo", { ...baseConfig(), gates: { plan: "maybe" } });
  const result = ark("status");
  expect(result.code).toBe(1);
  expect(result.out).toContain("gates.plan");
});

test("ARK-234-AC1 an unknown gates key exits 1 and names the field", () => {
  writeProject("demo", { ...baseConfig(), gates: { setup: "auto" } });
  const result = ark("status");
  expect(result.code).toBe(1);
  expect(result.out).toContain("gates.setup");
});

test("ARK-234-AC1 a gates map with only plan set loads, and the other keys stay human", () => {
  const { runId, directory } = startRun({ plan: "auto" });
  expect(ark("status").code).toBe(0);
  // gates.strategy is missing, so two cards must still wait for the human.
  expect(recordTwoCards(runId, directory, "yes", "no").code).toBe(0);
  expect(deriveState(eventsOf(directory)).phase).toBe("awaiting_strategy");
});

test("ARK-234-AC2 gates.plan auto approves a valid plan with no open decision by auto", () => {
  const { runId, directory } = startRun({ plan: "auto" });
  recordEvaluation(directory);
  const result = checkPlan(runId, directory);
  expect(result.code).toBe(0);
  const plan = answers(directory, "plan");
  expect(plan).toHaveLength(1);
  expect(plan[0].data).toEqual({ gate: "plan", answer: "approve", by: "auto" });
  expect(deriveState(eventsOf(directory)).phase).toBe("building");
  expect(ark("run", "step", runId, "build", "start").code).toBe(0);
});

test("ARK-234-AC2 gates.plan auto leaves the plan gate open while a decision is open", () => {
  const { runId, directory } = startRun({ plan: "auto" });
  recordEvaluation(directory);
  const result = checkPlan(runId, directory, [
    {
      id: "storage",
      question: "Which storage?",
      options: ["File", "Database"],
      recommended: "File",
      chosen: "",
    },
  ]);
  expect(result.code).toBe(0);
  expect(answers(directory, "plan")).toHaveLength(0);
  expect(deriveState(eventsOf(directory)).phase).toBe("planning");
});

test("ARK-234-AC2 gates.plan auto does not answer an invalid plan", () => {
  const { runId, directory } = startRun({ plan: "auto" });
  recordEvaluation(directory);
  writeFileSync(join(directory, "plan.yml"), JSON.stringify({ ...planWith(), test_cases: [] }));
  expect(ark("plan", "check", runId).code).toBe(1);
  expect(answers(directory, "plan")).toHaveLength(0);
});

function recordTwoCards(
  runId: string,
  directory: string,
  firstRecommended: "yes" | "no",
  secondRecommended: "yes" | "no",
) {
  writeFileSync(
    join(directory, "evaluation.md"),
    "## Blockers\n\n## Risks\n\n## Surfaces\n\n- none\n",
  );
  expect(ark("evaluation", "record", runId).code).toBe(0);
  writeFileSync(
    join(directory, "strategies.md"),
    [card("S1", firstRecommended), card("S2", secondRecommended)].join("\n"),
  );
  return ark("strategy", "record", runId);
}

test("ARK-234-AC3 gates.strategy auto answers with the recommended card by auto", () => {
  const { runId, directory } = startRun({ strategy: "auto" });
  expect(recordTwoCards(runId, directory, "no", "yes").code).toBe(0);
  const strategy = answers(directory, "strategy");
  expect(strategy).toHaveLength(1);
  expect(strategy[0].data).toEqual({ gate: "strategy", answer: "S2", by: "auto" });
  expect(deriveState(eventsOf(directory)).phase).toBe("planning");
});

test("ARK-234-AC3 a strategy with no valid recommended card is refused and the gate stays open", () => {
  const { runId, directory } = startRun({ strategy: "auto" });
  const result = recordTwoCards(runId, directory, "no", "no");
  expect(result.code).toBe(1);
  expect(answers(directory, "strategy")).toHaveLength(0);
  expect(eventsOf(directory).some((event) => event.type === "strategy.recorded")).toBe(false);
  expect(checkPlan(runId, directory).code).toBe(1);
});

test("ARK-234-AC3 a human strategy gate stays open after strategy record", () => {
  const { runId, directory } = startRun();
  expect(recordTwoCards(runId, directory, "yes", "no").code).toBe(0);
  expect(answers(directory, "strategy")).toHaveLength(0);
  expect(deriveState(eventsOf(directory)).phase).toBe("awaiting_strategy");
});

test("ARK-234-AC4 with no gates key plan check answers nothing and gate record writes by human", () => {
  const { runId, directory } = startRun();
  recordEvaluation(directory);
  expect(checkPlan(runId, directory).code).toBe(0);
  expect(answers(directory, "plan")).toHaveLength(0);
  expect(ark("gate", "record", runId, "plan", "approve").code).toBe(0);
  expect(answers(directory, "plan")[0].data).toEqual({
    gate: "plan",
    answer: "approve",
    by: "human",
  });
});

test("ARK-234-AC5 status and metrics.json separate auto answers from human answers", () => {
  const { runId, directory } = startRun({ plan: "auto" });
  expect(recordTwoCards(runId, directory, "yes", "no").code).toBe(0);
  expect(ark("gate", "record", runId, "strategy", "S2").code).toBe(0);
  expect(checkPlan(runId, directory).code).toBe(0);

  const status = ark("status", runId);
  expect(status.code).toBe(0);
  expect(status.out).toContain("plan approve by auto");
  expect(status.out).toContain("strategy S2 by human");

  expect(ark("retro", runId).code).toBe(0);
  const metrics = JSON.parse(readFileSync(join(directory, "metrics.json"), "utf8"));
  expect(metrics.gates).toEqual({ auto_answers: 1, human_answers: 1 });
});

test("ARK-234-AC5 an answer from before the by field reads as human", () => {
  const { runId, directory } = startRun();
  recordEvaluation(directory);
  expect(checkPlan(runId, directory).code).toBe(0);
  appendEvent(directory, "gate.answered", { gate: "plan", answer: "approve" });
  expect(ark("status", runId).out).toContain("plan approve by human");
});

test("ARK-234-AC6 run-lead and chief playbooks say an auto gate needs no Plannotator review and no relay", () => {
  const directory = join(import.meta.dir, "../skills/ark/playbooks");
  for (const name of ["run-lead.md", "chief.md"]) {
    const text = readFileSync(join(directory, name), "utf8").replace(/\s+/g, " ");
    expect(text).toMatch(/`auto`.*needs no Plannotator review and no relay/);
  }
});

// ARK-288: gates.escalation auto answers a spent budget or a post-MR implementer start, at most twice.

/** A building run whose plan has one implementer step `build` (the plan gate is auto). */
function buildingRun(gates: Record<string, unknown>) {
  const run = startRun({ plan: "auto", ...gates });
  recordEvaluation(run.directory);
  expect(checkPlan(run.runId, run.directory).code).toBe(0);
  expect(deriveState(eventsOf(run.directory)).phase).toBe("building");
  return run;
}

const start = (runId: string, ...flags: string[]) =>
  ark("run", "step", runId, "build", "start", ...flags);
const finish = (runId: string, ...flags: string[]) =>
  ark("run", "step", runId, "build", "finish", ...flags);
const autoAnswers = (directory: string) =>
  answers(directory, "escalation").filter((event) => event.data.by === "auto");
const types = (directory: string) => eventsOf(directory).map((event) => event.type);

function failTest(directory: string) {
  appendEvent(directory, "test.completed", {
    passed: false,
    heads: {},
    suites: [],
    criteria: { "ARK-902-AC1": "failing" },
  });
}

/**
 * Starts and finishes `build` twice: the default budget of 2 is then spent. A failing `ark test`
 * follows, so the phase is escalation as in a real run; `failing: false` leaves the phase building.
 */
function spendRounds(runId: string, directory: string, failing = true) {
  for (let index = 0; index < 2; index++) {
    expect(start(runId).code).toBe(0);
    expect(finish(runId).code).toBe(0);
  }
  if (failing) failTest(directory);
}

function openMergeRequest(directory: string) {
  appendEvent(directory, "merge_request.opened", { repo: ".", url: "https://x/mr/1", number: 1 });
}

const conflictSync = (directory: string) =>
  appendEvent(directory, "worktree.synced", { repo: ".", conflict: true });

test("ARK-288-AC1 a spent budget with gates.escalation auto records the answer by auto before step.started and starts the step", () => {
  const { runId, directory } = buildingRun({ escalation: "auto" });
  spendRounds(runId, directory);
  const before = eventsOf(directory).length;
  const result = start(runId);
  expect(result.code).toBe(0);
  expect(result.out).toContain("escalation one_more_round by auto (1 of 2)");
  const added = eventsOf(directory).slice(before);
  expect(added.map((event) => event.type)).toEqual(["gate.answered", "step.started"]);
  expect(added[0].data).toEqual({ gate: "escalation", answer: "one_more_round", by: "auto" });
  expect(deriveState(eventsOf(directory)).steps[0].status).toBe("running");
});

test("ARK-288-AC1 a spent budget in phase building with no test or a passing test is answered by auto", () => {
  for (const passing of [false, true]) {
    const { runId, directory } = buildingRun({ escalation: "auto" });
    spendRounds(runId, directory, false);
    if (passing) {
      appendEvent(directory, "test.completed", {
        passed: true,
        heads: {},
        suites: [],
        criteria: {},
      });
    }
    expect(deriveState(eventsOf(directory)).phase).toBe("building");
    const result = start(runId);
    expect(result.code).toBe(0);
    expect(result.out).toContain("escalation one_more_round by auto (1 of 2)");
    expect(autoAnswers(directory)).toHaveLength(1);
    expect(deriveState(eventsOf(directory)).steps[0].status).toBe("running");
  }
});

test("ARK-288-AC1 a start refused for a running step or a --merge with no failed sync leaves no gate.answered", () => {
  const { runId, directory } = buildingRun({ escalation: "auto" });
  spendRounds(runId, directory);
  expect(start(runId).code).toBe(0); // round 3, auto answer 1
  const running = eventsOf(directory).length;
  const again = start(runId);
  expect(again.code).toBe(1);
  expect(again.err).toContain("already running");
  expect(eventsOf(directory)).toHaveLength(running);

  expect(finish(runId).code).toBe(0);
  failTest(directory);
  const merge = eventsOf(directory).length;
  const refusedMerge = start(runId, "--merge");
  expect(refusedMerge.code).toBe(1);
  expect(refusedMerge.err).toContain("--merge needs a failed ark worktree sync");
  expect(eventsOf(directory)).toHaveLength(merge);
  expect(autoAnswers(directory)).toHaveLength(1);
});

test("ARK-288-AC2 the third spent budget is refused and the phase is escalation", () => {
  const { runId, directory } = buildingRun({ escalation: "auto" });
  spendRounds(runId, directory);
  for (const count of [1, 2]) {
    const result = start(runId);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`escalation one_more_round by auto (${count} of 2)`);
    expect(finish(runId).code).toBe(0);
    failTest(directory);
  }
  const before = eventsOf(directory).length;
  const refused = start(runId);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("round budget spent");
  expect(autoAnswers(directory)).toHaveLength(2);
  expect(eventsOf(directory)).toHaveLength(before);
  expect(ark("status", runId).out).toContain("phase: escalation");
});

test("ARK-288-AC3 after the MRs open, 3 merge starts are answered and not counted, 2 repair starts are counted and the next is refused", () => {
  const { runId, directory } = buildingRun({ escalation: "auto" });
  expect(start(runId).code).toBe(0);
  expect(finish(runId).code).toBe(0);
  openMergeRequest(directory);

  for (let index = 0; index < 3; index++) {
    conflictSync(directory);
    const merge = start(runId, "--merge");
    expect(merge.code).toBe(0);
    expect(merge.out).toContain("escalation one_more_round by auto (merge, not counted)");
    expect(finish(runId).code).toBe(0);
  }
  expect(autoAnswers(directory)).toHaveLength(3);
  expect(autoAnswers(directory).every((event) => event.data.merge === true)).toBe(true);

  for (const count of [1, 2]) {
    const repair = start(runId);
    expect(repair.code).toBe(0);
    expect(repair.out).toContain(`escalation one_more_round by auto (${count} of 2)`);
    expect(finish(runId).code).toBe(0);
  }
  expect(autoAnswers(directory).filter((event) => !event.data.merge)).toHaveLength(2);

  const before = eventsOf(directory).length;
  const refused = start(runId);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("record gate escalation");
  expect(eventsOf(directory)).toHaveLength(before);
  expect(autoAnswers(directory)).toHaveLength(5);
});

test("ARK-288-AC4 a requested escalation is never answered by auto and the phase stays escalation", () => {
  const { runId, directory } = buildingRun({ escalation: "auto" });
  spendRounds(runId, directory, false);
  expect(ark("escalate", runId, "--reason", "Review P1 open").code).toBe(0);
  expect(autoAnswers(directory)).toHaveLength(0); // both automatic answers are still left
  const before = eventsOf(directory).length;
  const refused = start(runId);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("round budget spent");
  expect(eventsOf(directory)).toHaveLength(before);
  expect(autoAnswers(directory)).toHaveLength(0);
  expect(ark("status", runId).out).toContain("phase: escalation");

  expect(ark("gate", "record", runId, "escalation", "one_more_round").code).toBe(0);
  expect(start(runId).code).toBe(0);
});

for (const [label, gates] of [
  ["human", { escalation: "human" }],
  ["no setting", {}],
] as const) {
  test(`ARK-288-AC5 gates.escalation ${label} refuses a spent budget as before`, () => {
    const { runId, directory } = buildingRun(gates);
    spendRounds(runId, directory);
    const spent = start(runId);
    expect(spent.code).toBe(1);
    expect(spent.err).toContain("round budget spent");
    expect(spent.out).not.toContain("by auto");
    expect(answers(directory, "escalation")).toHaveLength(0);
    expect(types(directory).filter((type) => type === "step.started")).toHaveLength(2);
  });

  test(`ARK-288-AC5 gates.escalation ${label} refuses a post-MR repair start and merge start as before`, () => {
    const { runId, directory } = buildingRun(gates);
    expect(start(runId).code).toBe(0);
    expect(finish(runId).code).toBe(0);
    openMergeRequest(directory);
    const repair = start(runId);
    expect(repair.code).toBe(1);
    expect(repair.err).toContain("record gate escalation");
    conflictSync(directory);
    const merge = start(runId, "--merge");
    expect(merge.code).toBe(1);
    expect(merge.err).toContain("record gate escalation");
    expect(answers(directory, "escalation")).toHaveLength(0);
    expect(types(directory).filter((type) => type === "step.started")).toHaveLength(1);
  });
}

test("ARK-288-AC8 docs/reference/cli.md equals the generator output and the gates reference documents escalation auto", () => {
  const root = join(import.meta.dir, "..");
  const path = join(root, "docs/reference/cli.md");
  const committed = readFileSync(path, "utf8");
  // The script rewrites cli.md in place, so a stale file shows as a changed file; put it back.
  const run = Bun.spawnSync(["bun", "scripts/cli-reference.ts"], { cwd: root });
  const reference = readFileSync(path, "utf8");
  writeFileSync(path, committed);
  expect(run.exitCode).toBe(0);
  expect(committed).toBe(reference);
  const gatesRow = reference.split("\n").find((line) => line.startsWith("| `gates`")) ?? "";
  expect(gatesRow).toContain("`escalation: auto`");
  expect(gatesRow).toContain("escalation one_more_round by auto (<n> of 2)");
  expect(gatesRow).toContain("at most 2 times");
});
