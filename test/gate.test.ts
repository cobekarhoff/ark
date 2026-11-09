import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent } from "../cli/events.ts";
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

const criteria = [
  { id: "ARK-901-AC1", text: "first" },
  { id: "ARK-901-AC2", text: "second" },
];

const plan = {
  design: { interfaces: [{ name: "fixture plan", callers: ["ark gate record"] }] },
  summary: {
    why: "Track the work for each criterion.",
    changes: criteria.map(({ id }) => ({
      criterion: id,
      where: "cli",
      now: "Plan approval needs a valid plan.",
      fix: "Keep the plan valid.",
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
      criteria: ["ARK-901-AC1", "ARK-901-AC2"],
    },
  ],
  test_cases: criteria.map(({ id }) => ({
    id: `t-${id}`,
    criterion: id,
    level: "integration",
    given: [],
    when: ["act"],
    // oxlint-disable-next-line unicorn/no-thenable -- plan test-case field `then: string[]`, not a Promise-like
    then: ["ok"],
    expected: "ok",
  })),
};

let projectDirectory: string;

beforeEach(() => {
  tempArkHome();
  projectDirectory = writeProject("demo", {
    workspace: tempGitRepo(),
    ticket_source: "local",
    suites: [{ name: "e2e", level: "e2e", repo: ".", command: "true", parser: "bun" }],
    roles: {
      implementer: { harness: "claude", model: "claude-sonnet" },
      validator: { harness: "codex", model: "gpt-codex" },
      reviewer: { harness: "codex", model: "gpt-codex" },
    },
  });
});

// Starts a run for ticket ARK-901 with the given criteria and returns its id and folder.
function startRun(ticketCriteria: { id: string; text: string; manual?: boolean }[]) {
  expect(ark("run", "start", writeTicket("demo", "ARK-901", ticketCriteria)).code).toBe(0);
  const runId = readdirSync(join(projectDirectory, "runs"))[0];
  const directory = join(projectDirectory, "runs", runId);
  recordEvaluation(directory);
  return { runId, directory };
}

const eventsOf = (directory: string) =>
  readFileSync(join(directory, "events.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const stateOf = (directory: string) =>
  JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));

describe("gate record", () => {
  test("ARK-153-AC5 refuses an unknown gate and lists the legal ones", () => {
    const { runId, directory } = startRun(criteria);
    const before = eventsOf(directory).length;
    const result = ark("gate", "record", runId, "setup", "accept");
    expect(result.code).toBe(1);
    expect(result.err).toContain("criteria, strategy, plan, escalation");
    expect(eventsOf(directory).length).toBe(before);
  });

  test("ARK-153-AC5 refuses an unknown answer and lists the legal ones", () => {
    const { runId, directory } = startRun(criteria);
    const before = eventsOf(directory).length;
    const result = ark("gate", "record", runId, "plan", "accept");
    expect(result.code).toBe(1);
    expect(result.err).toContain("approve, change, abort");
    expect(eventsOf(directory).length).toBe(before);
  });

  test("ARK-153-AC5 criteria accept re-reads the ticket, needs one criterion, and moves to planning", () => {
    const { runId, directory } = startRun([]);
    expect(stateOf(directory).phase).toBe("awaiting_criteria");

    const refused = ark("gate", "record", runId, "criteria", "accept");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("at least one");
    expect(stateOf(directory).phase).toBe("awaiting_criteria");

    writeTicket("demo", "ARK-901", criteria);
    const accepted = ark("gate", "record", runId, "criteria", "accept", "--note", "looks right");
    expect(accepted.code).toBe(0);
    expect(readFileSync(join(directory, "ticket.md"), "utf8")).toContain("ARK-901-AC2");
    const events = eventsOf(directory);
    expect(events.findLast((event) => event.type === "criteria.updated").data.criteria).toEqual([
      "ARK-901/AC1",
      "ARK-901/AC2",
    ]);
    expect(events.at(-1).type).toBe("gate.answered");
    expect(events.at(-1).data).toEqual({
      gate: "criteria",
      answer: "accept",
      by: "human",
      note: "looks right",
    });
    const state = stateOf(directory);
    expect(state.phase).toBe("planning");
    expect(state.gates.criteria).toBe("accept");
    expect(state.criteria.map((criterion: { id: string }) => criterion.id)).toEqual([
      "ARK-901/AC1",
      "ARK-901/AC2",
    ]);
  });

  test("ARK-153-AC5 criteria edit keeps waiting and criteria abort closes the run", () => {
    const { runId, directory } = startRun([]);
    expect(ark("gate", "record", runId, "criteria", "edit").code).toBe(0);
    expect(stateOf(directory).phase).toBe("awaiting_criteria");
    expect(ark("gate", "record", runId, "criteria", "abort").code).toBe(0);
    expect(stateOf(directory).phase).toBe("closed");
    expect(stateOf(directory).outcome).toBe("aborted");
  });

  test("ARK-153-AC5 refuses a criteria answer once the run has left awaiting_criteria", () => {
    const { runId, directory } = startRun(criteria);
    const before = eventsOf(directory).length;
    expect(ark("gate", "record", runId, "criteria", "accept").code).toBe(1);
    expect(eventsOf(directory).length).toBe(before);
  });

  test("ARK-153-AC5 refuses an escalation answer while the round budget is not spent", () => {
    const { runId, directory } = startRun(criteria);
    const before = eventsOf(directory).length;
    expect(ark("gate", "record", runId, "escalation", "one_more_round").code).toBe(1);
    expect(eventsOf(directory).length).toBe(before);
  });

  test("ARK-153-AC6 plan approve after a valid check starts the first build step", () => {
    const { runId, directory } = startRun(criteria);
    writeFileSync(join(directory, "plan.yml"), JSON.stringify(plan));

    const early = ark("run", "step", runId, "build", "start");
    expect(early.code).toBe(1);
    expect(early.err).toContain("gate.answered plan approve");

    expect(ark("plan", "check", runId).code).toBe(0);
    expect(ark("gate", "record", runId, "plan", "approve").code).toBe(0);
    expect(eventsOf(directory).at(-1).data).toEqual({
      gate: "plan",
      answer: "approve",
      by: "human",
    });
    expect(stateOf(directory).phase).toBe("building");
    expect(ark("run", "step", runId, "build", "start").code).toBe(0);
    expect(stateOf(directory).current_step).toBe("build");
  });

  test("ARK-153-AC6 plan approve is refused before any plan check", () => {
    const { runId, directory } = startRun(criteria);
    writeFileSync(join(directory, "plan.yml"), JSON.stringify(plan));
    const result = ark("gate", "record", runId, "plan", "approve");
    expect(result.code).toBe(1);
    expect(stateOf(directory).phase).toBe("planning");
  });

  test("ARK-153-AC6 plan approve is refused when the last check was invalid", () => {
    const { runId, directory } = startRun(criteria);
    writeFileSync(join(directory, "plan.yml"), JSON.stringify({ ...plan, test_cases: [] }));
    expect(ark("plan", "check", runId).code).toBe(1);
    expect(ark("gate", "record", runId, "plan", "approve").code).toBe(1);
    expect(stateOf(directory).phase).toBe("planning");
  });

  test("ARK-153-AC6 plan approve is refused when plan.yml changed since the check", () => {
    const { runId, directory } = startRun(criteria);
    writeFileSync(join(directory, "plan.yml"), JSON.stringify(plan));
    expect(ark("plan", "check", runId).code).toBe(0);
    writeFileSync(
      join(directory, "plan.yml"),
      JSON.stringify({ ...plan, steps: [{ ...plan.steps[0], model: "other" }] }),
    );
    const before = eventsOf(directory).length;
    const result = ark("gate", "record", runId, "plan", "approve");
    expect(result.code).toBe(1);
    expect(eventsOf(directory).length).toBe(before);
    expect(stateOf(directory).phase).toBe("planning");
  });

  test("ARK-153-AC6 plan change stays in planning and plan abort closes the run", () => {
    const { runId, directory } = startRun(criteria);
    expect(ark("gate", "record", runId, "plan", "change").code).toBe(0);
    expect(stateOf(directory).phase).toBe("planning");
    expect(ark("gate", "record", runId, "plan", "abort").code).toBe(0);
    expect(stateOf(directory).phase).toBe("closed");
    expect(stateOf(directory).outcome).toBe("aborted");
  });
});

describe("plan approval survives only an unchanged valid recheck", () => {
  // Approves a valid plan, rechecks it, and returns the run.
  function approvedRun() {
    const { runId, directory } = startRun(criteria);
    writeFileSync(join(directory, "plan.yml"), JSON.stringify(plan));
    expect(ark("plan", "check", runId).code).toBe(0);
    expect(ark("gate", "record", runId, "plan", "approve").code).toBe(0);
    return { runId, directory };
  }

  test("ARK-187-AC1 a recheck of an unchanged plan keeps approval and the step starts", () => {
    const { runId, directory } = approvedRun();
    expect(ark("plan", "check", runId).code).toBe(0);
    const started = ark("run", "step", runId, "build", "start");
    expect(started.code).toBe(0);
    expect(stateOf(directory).current_step).toBe("build");
  });

  test("ARK-187-AC2 a recheck of an edited plan clears approval and step start names the plan gate", () => {
    const { runId, directory } = approvedRun();
    // Pretty-printing keeps the plan valid but changes its bytes, so only the hash compare can clear approval.
    writeFileSync(join(directory, "plan.yml"), JSON.stringify(plan, null, 2));
    expect(ark("plan", "check", runId).code).toBe(0);
    const before = eventsOf(directory).length;
    const refused = ark("run", "step", runId, "build", "start");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("gate.answered plan approve");
    expect(eventsOf(directory).length).toBe(before);
  });

  test("ARK-187-AC2 an invalid recheck with the same plan hash clears approval", () => {
    const { runId, directory } = approvedRun();
    // Same plan.yml bytes, but the role's model no longer exists in the project config.
    writeProject("demo", {
      workspace: tempGitRepo(),
      ticket_source: "local",
      suites: [{ name: "e2e", level: "e2e", repo: ".", command: "true", parser: "bun" }],
      roles: {
        implementer: { harness: "omp", model: "other" },
        validator: { harness: "codex", model: "gpt-codex" },
        reviewer: { harness: "codex", model: "gpt-codex" },
      },
    });
    const checked = ark("plan", "check", runId);
    expect(checked.code).toBe(1);
    const before = eventsOf(directory).length;
    const refused = ark("run", "step", runId, "build", "start");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("gate.answered plan approve");
    expect(eventsOf(directory).length).toBe(before);
  });
});

describe("manual gate", () => {
  const manualCriteria = [
    { id: "ARK-901-AC1", text: "first", manual: true },
    { id: "ARK-901-AC2", text: "second" },
    { id: "ARK-901-AC3", text: "third", manual: true },
  ];
  const planFor = {
    ...plan,
    summary: {
      ...plan.summary,
      changes: manualCriteria.map(({ id }) => ({ ...plan.summary.changes[0], criterion: id })),
    },
    steps: [{ ...plan.steps[0], criteria: manualCriteria.map(({ id }) => id) }],
  };
  const buildingRun = () => {
    const { runId, directory } = startRun(manualCriteria);
    // Two manual criteria have no test case; only AC2 has one: plan check needs none for a manual criterion.
    writeFileSync(
      join(directory, "plan.yml"),
      JSON.stringify({
        ...planFor,
        test_cases: [{ ...plan.test_cases[0], criterion: "ARK-901-AC2" }],
      }),
    );
    expect(ark("plan", "check", runId).code).toBe(0);
    expect(ark("gate", "record", runId, "plan", "approve").code).toBe(0);
    return { runId, directory };
  };
  const manualEvents = (directory: string) =>
    eventsOf(directory).filter((event) => event.data?.gate === "manual");

  test("ARK-283-AC2 records gate manual with the field criterion for ok and for problem with a note", () => {
    const { runId, directory } = buildingRun();
    expect(ark("gate", "record", runId, "manual", "ARK-901-AC1", "ok").code).toBe(0);
    const second = ark(
      "gate",
      "record",
      runId,
      "manual",
      "ARK-901/AC1",
      "problem",
      "--note",
      "button is gray",
    );
    expect(second.code).toBe(0);
    expect(manualEvents(directory).map((event) => event.data)).toEqual([
      { gate: "manual", criterion: "ARK-901/AC1", answer: "ok", by: "human" },
      {
        gate: "manual",
        criterion: "ARK-901/AC1",
        answer: "problem",
        by: "human",
        note: "button is gray",
      },
    ]);
    // The run stays in building: a manual answer moves no phase.
    expect(stateOf(directory).phase).toBe("building");
  });

  test("ARK-283-AC2 refuses an unknown id and a criterion that is not manual, and names the id", () => {
    const { runId, directory } = buildingRun();
    const before = eventsOf(directory).length;
    const unknown = ark("gate", "record", runId, "manual", "ARK-901-AC9", "ok");
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("ARK-901/AC9");
    const normal = ark("gate", "record", runId, "manual", "ARK-901-AC2", "ok");
    expect(normal.code).toBe(1);
    expect(normal.err).toContain("ARK-901/AC2");
    expect(normal.err).toContain("manual");
    expect(eventsOf(directory).length).toBe(before);
  });

  test("ARK-283-AC2 refuses an answer that is not ok or problem, and a missing criterion id", () => {
    const { runId, directory } = buildingRun();
    const before = eventsOf(directory).length;
    const wrong = ark("gate", "record", runId, "manual", "ARK-901-AC1", "accept");
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain("ok, problem");
    const missing = ark("gate", "record", runId, "manual", "ok");
    expect(missing.code).toBe(1);
    expect(eventsOf(directory).length).toBe(before);
  });

  test("ARK-283-AC2 refuses a manual answer while the run is still planning", () => {
    const { runId, directory } = startRun(manualCriteria);
    const result = ark("gate", "record", runId, "manual", "ARK-901-AC1", "ok");
    expect(result.code).toBe(1);
    expect(result.err).toContain("phase planning");
    expect(manualEvents(directory)).toEqual([]);
  });

  test("ARK-283-AC2 two manual criteria keep separate answers", () => {
    const { runId, directory } = buildingRun();
    expect(ark("gate", "record", runId, "manual", "ARK-901-AC1", "ok").code).toBe(0);
    expect(ark("gate", "record", runId, "manual", "ARK-901-AC3", "problem").code).toBe(0);
    expect(stateOf(directory).gates).toMatchObject({
      "manual:ARK-901/AC1": "ok",
      "manual:ARK-901/AC3": "problem",
    });
    expect(ark("gate", "record", runId, "manual", "ARK-901-AC3", "ok").code).toBe(0);
    expect(stateOf(directory).gates).toMatchObject({
      "manual:ARK-901/AC1": "ok",
      "manual:ARK-901/AC3": "ok",
    });
  });

  test("ARK-283-AC2 ark status lists the manual criteria that are not ok", () => {
    const { runId } = buildingRun();
    expect(ark("status", runId).out).toContain("manual pending: ARK-901/AC1, ARK-901/AC3");
    expect(ark("gate", "record", runId, "manual", "ARK-901/AC1", "ok").code).toBe(0);
    expect(ark("status", runId).out).toContain("manual pending: ARK-901/AC3");
  });

  test("ARK-283-AC2 gates.manual in ark.yml stays an error: the manual gate is never automatic", () => {
    writeProject("demo", {
      workspace: tempGitRepo(),
      ticket_source: "local",
      suites: [{ name: "e2e", level: "e2e", repo: ".", command: "true", parser: "bun" }],
      roles: {
        implementer: { harness: "claude", model: "claude-sonnet" },
        validator: { harness: "codex", model: "gpt-codex" },
        reviewer: { harness: "codex", model: "gpt-codex" },
      },
      gates: { manual: "auto" },
    });
    const result = ark("status");
    expect(result.code).toBe(1);
    expect(result.out).toContain("gates.manual");
  });
});

describe("criteria gate on every run", () => {
  /** Starts ARK-901 with the given ACs and records an evaluation without accepting the criteria. */
  function startUnaccepted(
    ticketCriteria: Parameters<typeof writeTicket>[2],
    blockers: string[] = [],
  ) {
    expect(ark("run", "start", writeTicket("demo", "ARK-901", ticketCriteria)).code).toBe(0);
    const runId = readdirSync(join(projectDirectory, "runs"))[0];
    const directory = join(projectDirectory, "runs", runId);
    appendEvent(directory, "evaluation.recorded", { blockers, risks: [], surfaces: ["none"] });
    return { runId, directory };
  }

  test("ARK-311-AC5 a ticket with ACs and no blockers waits in awaiting_criteria until the human accepts", () => {
    const { runId, directory } = startUnaccepted([
      { id: "AC1", text: "first", verified_by: ["ARK-T1"] },
      { id: "AC2", text: "second", method: "demonstration" },
    ]);
    expect(stateOf(directory).phase).toBe("awaiting_criteria");
    expect(ark("status", runId).out).toContain("awaiting_criteria");
    const early = ark("run", "step", runId, "build", "start");
    expect(early.code).toBe(1);

    const accepted = ark("gate", "record", runId, "criteria", "accept");
    expect(accepted.code).toBe(0);
    expect(stateOf(directory).phase).toBe("planning");
    expect(eventsOf(directory).findLast((event) => event.type === "criteria.updated").data).toEqual(
      { criteria: ["ARK-901/AC1", "ARK-901/AC2"] },
    );
  });

  test("ARK-311-AC5 a ticket with a blocker waits in awaiting_criteria too, and accept still ends the wait", () => {
    const { runId, directory } = startUnaccepted(
      [{ id: "AC1", text: "first", verified_by: ["ARK-T1"] }],
      ["ARK-901/AC1: no test can prove it"],
    );
    expect(stateOf(directory).phase).toBe("awaiting_criteria");
    expect(ark("gate", "record", runId, "criteria", "accept").code).toBe(0);
    expect(stateOf(directory).phase).not.toBe("awaiting_criteria");
  });

  test("ARK-311-AC5 accept refuses a new-scheme method test AC with an empty verified_by, names the AC id, and takes the fixed ticket", () => {
    const { runId, directory } = startUnaccepted([
      { id: "AC1", text: "first", verified_by: ["ARK-T1"] },
      { id: "AC2", text: "second", verified_by: [] },
      { id: "AC3", text: "third", method: "inspection", verified_by: [] },
    ]);
    const before = eventsOf(directory).length;
    const refused = ark("gate", "record", runId, "criteria", "accept");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("ARK-901/AC2");
    expect(refused.err).not.toContain("ARK-901/AC1");
    expect(refused.err).not.toContain("ARK-901/AC3");
    expect(eventsOf(directory).length).toBe(before);
    expect(stateOf(directory).phase).toBe("awaiting_criteria");

    writeTicket("demo", "ARK-901", [
      { id: "AC1", text: "first", verified_by: ["ARK-T1"] },
      { id: "AC2", text: "second", verified_by: ["ARK-T2"] },
    ]);
    expect(ark("gate", "record", runId, "criteria", "accept").code).toBe(0);
    expect(stateOf(directory).phase).toBe("planning");
  });
});

test("ARK-T102 ARK-334/AC2 a spent round budget names ark escalate in building and ark gate record in escalation", () => {
  const { runId, directory } = startRun(criteria);
  writeFileSync(join(directory, "plan.yml"), JSON.stringify(plan));
  expect(ark("plan", "check", runId).code).toBe(0);
  expect(ark("gate", "record", runId, "plan", "approve").code).toBe(0);
  const build = (action: string) => ark("run", "step", runId, "build", action);
  expect(build("start").code).toBe(0); // round 1
  expect(build("finish").code).toBe(0);
  expect(build("start").code).toBe(0); // round 2
  expect(build("finish").code).toBe(0);
  expect(stateOf(directory).phase).toBe("building");

  const building = build("start");
  expect(building.code).toBe(1);
  expect(building.err).toContain("round budget spent");
  expect(building.err).toMatch(/ark escalate .*--reason.*ask.*escalation gate/);
  expect(building.err).toContain(runId);
  expect(building.err).not.toContain("ark gate record");

  expect(ark("escalate", runId, "--reason", "budget spent").code).toBe(0);
  expect(stateOf(directory).phase).toBe("escalation");
  const escalation = build("start");
  expect(escalation.code).toBe(1);
  expect(escalation.err).toContain("round budget spent");
  expect(escalation.err).toContain("ark gate record");
});
