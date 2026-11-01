import { beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent } from "../cli/events.ts";
import { planHash } from "../cli/plan.ts";
import {
  ark,
  recordEvaluation,
  tempArkHome,
  tempGitRepo,
  writeProject,
  writeTicket,
} from "./helpers.ts";

const workspaceSteps = [
  { id: "build", role: "implementer", repo: ".", needs: [], criteria: ["ARK-900-AC1"] },
  { id: "review", role: "reviewer", repo: ".", needs: ["build"], criteria: ["ARK-900-AC1"] },
];

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspace: tempGitRepo(),
    ticket_source: "local",
    suites: [{ name: "e2e", level: "e2e", repo: ".", command: "bun test", parser: "bun" }],
    roles: {
      implementer: { harness: "claude", model: "claude-sonnet" },
      validator: { harness: "codex", model: "gpt-codex" },
      reviewer: { harness: "codex", model: "gpt-codex" },
    },
    ...overrides,
  };
}

function startRun(project = "demo", ticketId = "ARK-900"): { runId: string; directory: string } {
  const ticketFile = writeTicket(
    project,
    ticketId,
    [{ id: `${ticketId}-AC1`, text: "It works" }],
    "Demo ticket",
  );
  const started = ark("run", "start", ticketFile, "--project", project);
  expect(started.err).toBe("");
  const runId = started.out.trim();
  return {
    runId,
    directory: join(process.env.ARK_HOME as string, "projects", project, "runs", runId),
  };
}

/** Puts a run into phase building the way the plan commands do: a valid plan.checked, then an approving gate.answered. */
function approvePlan(directory: string): void {
  writeFileSync(join(directory, "plan.yml"), "steps: []\n");
  recordEvaluation(directory);
  appendEvent(directory, "plan.checked", {
    valid: true,
    problems: [],
    plan_hash: planHash(directory),
    steps: workspaceSteps,
  });
  appendEvent(directory, "gate.answered", { gate: "plan", answer: "approve" });
}

const eventLines = (directory: string): string[] =>
  readFileSync(join(directory, "events.ndjson"), "utf8").trim().split("\n");

beforeEach(() => {
  tempArkHome();
  delete process.env.ARK_PROJECT;
  writeProject("demo", validConfig());
});

test("ARK-152-AC1 run start creates the run folder, copies the ticket, logs run.started and numbers same-day runs", () => {
  const { runId, directory } = startRun();
  expect(runId).toMatch(/^\d{4}-\d{2}-\d{2}-ARK-900-1$/);
  const ticketFile = join(
    process.env.ARK_HOME as string,
    "projects",
    "demo",
    "tickets",
    "ARK-900.md",
  );
  expect(readFileSync(join(directory, "ticket.md"), "utf8")).toBe(readFileSync(ticketFile, "utf8"));
  const lines = eventLines(directory);
  expect(lines).toHaveLength(1);
  const first = JSON.parse(lines[0]);
  expect(first).toMatchObject({
    seq: 1,
    type: "run.started",
    data: {
      project: "demo",
      ticket: { id: "ARK-900", title: "Demo ticket" },
      criteria: ["ARK-900-AC1"],
      round_budget: 2,
    },
  });

  expect(ark("run", "close", runId, "aborted").code).toBe(0);
  const second = ark("run", "start", ticketFile, "--project", "demo");
  expect(second.out.trim()).toBe(runId.replace(/-1$/, "-2"));
});

test("ARK-152-AC1 run start refuses a ticket that already has an open run and names it", () => {
  const { runId } = startRun();
  const ticketFile = join(
    process.env.ARK_HOME as string,
    "projects",
    "demo",
    "tickets",
    "ARK-900.md",
  );
  const again = ark("run", "start", ticketFile, "--project", "demo");
  expect(again.code).toBe(1);
  expect(again.err).toContain(runId);
});

test("ARK-152-AC1 run start finds the project from the ticket path when no flag is given", () => {
  const ticketFile = writeTicket("demo", "ARK-901", [{ id: "ARK-901-AC1", text: "It works" }]);
  const started = ark("run", "start", ticketFile);
  expect(started.code).toBe(0);
  expect(started.out.trim()).toMatch(/-ARK-901-1$/);
});

const invalidConfigs: [string, (config: Record<string, unknown>) => void, string][] = [
  ["missing workspace", (config) => delete config.workspace, "workspace"],
  [
    "workspace that does not exist",
    (config) => (config.workspace = "/nonexistent/ark-test"),
    "workspace",
  ],
  [
    "unknown ticket source",
    (config) => (config.ticket_source = "trello"),
    "ticket_source must be one of local, github, jira",
  ],
  [
    "suite with unknown parser",
    (config) =>
      (config.suites as Record<string, unknown>[]).push({
        name: "api",
        level: "integration",
        repo: ".",
        command: "x",
        parser: "junit",
      }),
    "suites[1].parser must be one of bun, pytest, behave",
  ],
  ["empty suites", (config) => (config.suites = []), "suites"],
  [
    "missing reviewer role",
    (config) => delete (config.roles as Record<string, unknown>).reviewer,
    "roles.reviewer",
  ],
  ["negative round budget", (config) => (config.round_budget = -1), "round_budget"],
];

for (const [name, mutate, expected] of invalidConfigs) {
  test(`ARK-152-AC2 run start refuses ${name} and names the field`, () => {
    const config = validConfig();
    mutate(config);
    writeProject("broken", config);
    const ticketFile = writeTicket("broken", "ARK-902", [{ id: "ARK-902-AC1", text: "It works" }]);
    const result = ark("run", "start", ticketFile, "--project", "broken");
    expect(result.code).toBe(1);
    expect(result.err).toContain(expected);
    expect(existsSync(join(process.env.ARK_HOME as string, "projects", "broken", "runs"))).toBe(
      false,
    );
  });
}

test("ARK-152-AC2 run start refuses a project with no ark.yml", () => {
  const ticketFile = writeTicket("ghost", "ARK-903", []);
  const result = ark("run", "start", ticketFile, "--project", "ghost");
  expect(result.code).toBe(1);
  expect(result.err).toContain("ark.yml");
});

test("ARK-152-AC2 a valid ark.yml gives the run its round budget, defaulting to 2", () => {
  writeProject("tight", validConfig({ round_budget: 1 }));
  const ticketFile = writeTicket("tight", "ARK-904", [{ id: "ARK-904-AC1", text: "It works" }]);
  const runId = ark("run", "start", ticketFile, "--project", "tight").out.trim();
  const state = JSON.parse(
    readFileSync(
      join(process.env.ARK_HOME as string, "projects", "tight", "runs", runId, "state.json"),
      "utf8",
    ),
  );
  expect(state.round_budget).toBe(1);
});

test("ARK-152-AC3 events are append-only and a deleted state.json is rebuilt byte for byte", () => {
  const { runId, directory } = startRun();
  approvePlan(directory);
  expect(ark("run", "step", runId, "build", "start").code).toBe(0);
  const before = readFileSync(join(directory, "events.ndjson"), "utf8");
  const stateBefore = readFileSync(join(directory, "state.json"), "utf8");

  expect(ark("run", "step", runId, "build", "finish").code).toBe(0);
  expect(readFileSync(join(directory, "events.ndjson"), "utf8").startsWith(before)).toBe(true);

  const stateAfter = readFileSync(join(directory, "state.json"), "utf8");
  expect(stateAfter).not.toBe(stateBefore);
  rmSync(join(directory, "state.json"));
  expect(ark("status", runId).code).toBe(0);
  expect(readFileSync(join(directory, "state.json"), "utf8")).toBe(stateAfter);
});

test("ARK-152-AC4 a step cannot start before plan approval, exits non-zero and names the missing event", () => {
  const { runId, directory } = startRun();
  writeFileSync(join(directory, "plan.yml"), "steps: []\n");
  recordEvaluation(directory);
  appendEvent(directory, "plan.checked", {
    valid: true,
    problems: [],
    plan_hash: planHash(directory),
    steps: workspaceSteps,
  });
  const eventsBefore = eventLines(directory);

  const refused = ark("run", "step", runId, "build", "start");
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("gate.answered plan approve");
  expect(eventLines(directory)).toEqual(eventsBefore);
});

test("ARK-152-AC4 a plan edited after the check cannot be approved", () => {
  const { directory } = startRun();
  writeFileSync(join(directory, "plan.yml"), "steps: []\n");
  recordEvaluation(directory);
  appendEvent(directory, "plan.checked", {
    valid: true,
    problems: [],
    plan_hash: planHash(directory),
    steps: workspaceSteps,
  });
  writeFileSync(join(directory, "plan.yml"), "steps: [edited]\n");
  expect(() =>
    appendEvent(directory, "gate.answered", { gate: "plan", answer: "approve" }),
  ).toThrow("plan.yml changed");
});

test("ARK-152-AC5 step start and finish are events and status shows the first unfinished step", () => {
  const { runId, directory } = startRun();
  approvePlan(directory);

  expect(ark("run", "step", runId, "nonexistent", "start").err).toContain("unknown step");
  expect(ark("run", "step", runId, "build", "start").code).toBe(0);
  expect(ark("status", runId).out).toContain("current step: build (running)");

  expect(ark("run", "step", runId, "build", "finish").code).toBe(0);
  const types = eventLines(directory).map((line) => JSON.parse(line).type);
  expect(types.slice(-2)).toEqual(["step.started", "step.finished"]);
  expect(JSON.parse(eventLines(directory).at(-2) as string).data).toMatchObject({
    step: "build",
    role: "implementer",
    repo: ".",
    round: 1,
  });
  expect(ark("status", runId).out).toContain("current step: review (pending)");
});

test("ARK-152-AC5 a failed step stays the current step", () => {
  const { runId } = startRun();
  approvePlan(join(process.env.ARK_HOME as string, "projects", "demo", "runs", runId));
  ark("run", "step", runId, "build", "start");
  expect(ark("run", "step", runId, "build", "finish", "--failed").code).toBe(0);
  expect(ark("status", runId).out).toContain("current step: build (failed)");
});

test("ARK-152-AC6 status without a run lists every open run with phase and current step, across projects", () => {
  const first = startRun("demo", "ARK-900");
  approvePlan(first.directory);
  ark("run", "step", first.runId, "build", "start");
  writeProject("other", validConfig());
  const second = startRun("other", "ARK-910");
  const closed = startRun("demo", "ARK-920");
  ark("run", "close", closed.runId, "aborted");

  const listing = ark("status");
  expect(listing.code).toBe(0);
  const lines = listing.out.trim().split("\n");
  expect(lines).toContain(`${first.runId}  building  build`);
  expect(lines).toContain(`${second.runId}  planning  -`);
  expect(listing.out).not.toContain(closed.runId);
});

test("ARK-152-AC2 status passes when every project config is valid", () => {
  const result = ark("status");
  expect(result.code).toBe(0);
  expect(result.out).not.toContain("config error");
});

test("ARK-152-AC2 status exits 1 and names the bad field and project of an invalid config", () => {
  writeProject("broken", validConfig({ ticket_source: "trello" }));
  const result = ark("status");
  expect(result.code).toBe(1);
  expect(result.out).toContain("config error: broken:");
  expect(result.out).toContain("ticket_source must be one of local, github, jira");
  expect(result.out).not.toContain("config error: demo");
  expect(result.err).toContain("1 project config(s) invalid");
});

test("ARK-152-AC2 ARK_PROJECT limits the status config check to one project", () => {
  writeProject("broken", validConfig({ ticket_source: "trello" }));
  try {
    process.env.ARK_PROJECT = "demo";
    expect(ark("status").code).toBe(0);
    process.env.ARK_PROJECT = "broken";
    expect(ark("status").code).toBe(1);
    process.env.ARK_PROJECT = "ghost";
    const missing = ark("status");
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("ghost");
  } finally {
    delete process.env.ARK_PROJECT;
  }
});
test("ARK-164-AC2 status accepts --project for config checks and run state", () => {
  writeProject("broken", validConfig({ ticket_source: "trello" }));

  const configCheck = ark("status", "--project", "demo");
  expect(configCheck.code).toBe(0);
  expect(configCheck.out).not.toContain("config error");

  const { runId } = startRun();
  const runStatus = ark("status", runId, "--project", "demo");
  expect(runStatus.code).toBe(0);
  expect(runStatus.out).toContain("phase: planning");

  const missingProject = ark("status", "--project", "missing");
  expect(missingProject.code).toBe(1);
  expect(missingProject.err).toContain("missing");
});

test("ARK-152-AC6 status for one run shows phase, round, waiting gate and cost", () => {
  const { runId } = startRun();
  const result = ark("status", runId);
  expect(result.code).toBe(0);
  expect(result.out).toContain("phase: planning");
  expect(result.out).toContain("round: 1/2");
  expect(result.out).toContain("cost:");
});

test("ARK-152-AC7 run close records each valid outcome and refuses any other", () => {
  const { runId, directory } = startRun();
  const unknown = ark("run", "close", runId, "finished");
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain("merged, abandoned, aborted, handed_off");
  expect(eventLines(directory)).toHaveLength(1);

  expect(ark("run", "close", runId, "aborted").code).toBe(0);
  expect(JSON.parse(eventLines(directory).at(-1) as string)).toMatchObject({
    type: "run.closed",
    data: { outcome: "aborted" },
  });
  expect(JSON.parse(readFileSync(join(directory, "state.json"), "utf8"))).toMatchObject({
    phase: "closed",
    outcome: "aborted",
  });
});

test("ARK-152-AC7 merged, abandoned and handed_off need what the outcome says", () => {
  const { runId, directory } = startRun();
  approvePlan(directory);
  for (const outcome of ["merged", "abandoned"]) {
    const refused = ark("run", "close", runId, outcome);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("merge_request.opened");
  }
  expect(ark("run", "close", runId, "handed_off").err).toContain("test.completed");

  appendEvent(directory, "test.completed", {
    passed: true,
    heads: {},
    suites: [],
    criteria: { "ARK-900-AC1": "passing" },
  });
  expect(ark("run", "close", runId, "handed_off").code).toBe(0);
});

test("ARK-152-AC7 merged is accepted once a merge request is open", () => {
  const { runId, directory } = startRun();
  approvePlan(directory);
  appendEvent(directory, "merge_request.opened", {
    repo: ".",
    url: "https://example.com/mr/1",
    number: 1,
  });
  expect(ark("run", "close", runId, "merged").code).toBe(0);
});

test("ARK-152-AC7 nothing can be recorded after a run is closed", () => {
  const { runId, directory } = startRun();
  ark("run", "close", runId, "aborted");
  const again = ark("run", "close", runId, "aborted");
  expect(again.code).toBe(1);
  expect(again.err).toContain("closed");
  expect(() =>
    appendEvent(directory, "plan.checked", {
      valid: true,
      problems: [],
      plan_hash: "x",
      steps: [],
    }),
  ).toThrow("closed");
});

test("ARK-152-AC4 a restart past the round budget is refused until an escalation answer", () => {
  const { runId, directory } = startRun();
  approvePlan(directory);
  for (const round of [1, 2]) {
    expect(ark("run", "step", runId, "build", "start").code).toBe(0);
    expect(JSON.parse(eventLines(directory).at(-1) as string).data.round).toBe(round);
    ark("run", "step", runId, "build", "finish", "--failed");
  }
  const eventsBefore = eventLines(directory);
  const refused = ark("run", "step", runId, "build", "start");
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("round budget spent");
  expect(eventLines(directory)).toEqual(eventsBefore);

  appendEvent(directory, "test.completed", {
    passed: false,
    heads: {},
    suites: [],
    criteria: { "ARK-900-AC1": "failing" },
  });
  expect(ark("status", runId).out).toContain("phase: escalation");
  appendEvent(directory, "gate.answered", { gate: "escalation", answer: "one_more_round" });
  expect(ark("run", "step", runId, "build", "start").code).toBe(0);
});

test("ark --help prints usage and an unknown command exits 1", () => {
  const help = ark("--help");
  expect(help.code).toBe(0);
  expect(help.out.trim().split("\n")[0]).toBe("Usage: ark <command>");
  expect(ark("run", "start", "--help").out).toContain(
    "ark run start <ticket-file> [--project <name>]",
  );
  const unknown = ark("frobnicate");
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain("Usage: ark <command>");
});
