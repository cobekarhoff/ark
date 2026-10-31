import { beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ark, tempArkHome, tempGitRepo, writeProject, writeTicket } from "./helpers.ts";

const criteria = [
  { id: "ARK-901-AC1", text: "first" },
  { id: "ARK-901-AC2", text: "second" },
];

const plan = {
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
function startRun(ticketCriteria: { id: string; text: string }[]) {
  expect(ark("run", "start", writeTicket("demo", "ARK-901", ticketCriteria)).code).toBe(0);
  const runId = readdirSync(join(projectDirectory, "runs"))[0];
  return { runId, directory: join(projectDirectory, "runs", runId) };
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
    expect(result.err).toContain("criteria, plan, escalation");
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
      "ARK-901-AC1",
      "ARK-901-AC2",
    ]);
    expect(events.at(-1).type).toBe("gate.answered");
    expect(events.at(-1).data).toEqual({ gate: "criteria", answer: "accept", note: "looks right" });
    const state = stateOf(directory);
    expect(state.phase).toBe("planning");
    expect(state.gates.criteria).toBe("accept");
    expect(state.criteria.map((criterion: { id: string }) => criterion.id)).toEqual([
      "ARK-901-AC1",
      "ARK-901-AC2",
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
    expect(eventsOf(directory).at(-1).data).toEqual({ gate: "plan", answer: "approve" });
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
