import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../cli/config.ts";
import { appendEvent } from "../cli/events.ts";
import { planHash } from "../cli/plan.ts";
import { timelineOf } from "../hub/run-detail.ts";
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
  expect(readFileSync(join(directory, "ticket.md"), "utf8")).toBe(
    readFileSync(ticketFile, "utf8").replace("status: in_progress", "status: ready"),
  );
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

test("ARK-295-AC1 loadConfig returns merge_requests open, none, and open when the key is absent", () => {
  writeProject("opened", validConfig({ merge_requests: "open" }));
  writeProject("local", validConfig({ merge_requests: "none" }));
  writeProject("plain", validConfig());
  expect(loadConfig("opened").merge_requests).toBe("open");
  expect(loadConfig("local").merge_requests).toBe("none");
  expect(loadConfig("plain").merge_requests).toBe("open");
});

test("ARK-295-AC1 any other merge_requests value is refused and the run start names the rule", () => {
  writeProject("broken", validConfig({ merge_requests: "maybe" }));
  expect(() => loadConfig("broken")).toThrow("merge_requests must be one of open, none");
  const ticketFile = writeTicket("broken", "ARK-902", [{ id: "ARK-902-AC1", text: "It works" }]);
  const result = ark("run", "start", ticketFile, "--project", "broken");
  expect(result.code).toBe(1);
  expect(result.err).toContain("merge_requests must be one of open, none");
});

for (const [name, value] of [
  ["null", null],
  ["blank", ""],
] as const) {
  test(`ARK-295-AC1 a ${name} merge_requests value is refused, not read as open`, () => {
    writeProject("broken", validConfig({ merge_requests: value }));
    expect(() => loadConfig("broken")).toThrow("merge_requests must be one of open, none");
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
  expect(lines).toContain(`${first.runId}  building  build  0m`);
  expect(lines).toContain(`${second.runId}  planning  -  0m`);
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

/** A building run with both rounds spent; the last ark test result is `passed`. */
function spentBudgetRun(passed: boolean): { runId: string; directory: string } {
  const { runId, directory } = startRun();
  approvePlan(directory);
  for (let round = 1; round <= 2; round++) {
    expect(ark("run", "step", runId, "build", "start").code).toBe(0);
    expect(ark("run", "step", runId, "build", "finish").code).toBe(0);
  }
  appendEvent(directory, "test.completed", {
    passed,
    heads: {},
    suites: [],
    criteria: { "ARK-900-AC1": passed ? "passing" : "failing" },
  });
  return { runId, directory };
}

const eventTypes = (directory: string): string[] =>
  eventLines(directory).map((line) => JSON.parse(line).type);

test("ARK-210-AC1 ark escalate opens escalation at the spent budget although the last test passed", () => {
  const { runId, directory } = spentBudgetRun(true);
  expect(ark("status", runId).out).toContain("phase: building");
  const result = ark("escalate", runId, "--reason", "review P1 unresolved, tests pass");
  expect(result.code).toBe(0);
  expect(result.out).toContain("round 2 of 2");
  expect(JSON.parse(eventLines(directory).at(-1) as string)).toMatchObject({
    type: "escalation.requested",
    data: { reason: "review P1 unresolved, tests pass" },
  });
  expect(ark("status", runId).out).toContain("phase: escalation");
});

test("ARK-210-AC1 an open escalation request survives a passing ark test", () => {
  const { runId, directory } = spentBudgetRun(true);
  expect(ark("escalate", runId, "--reason", "P1 open").code).toBe(0);
  appendEvent(directory, "test.completed", {
    passed: true,
    heads: {},
    suites: [],
    criteria: { "ARK-900-AC1": "passing" },
  });
  expect(ark("status", runId).out).toContain("phase: escalation");
});

test("ARK-210-AC2 ark escalate below the round budget exits 1, names the budget and logs nothing", () => {
  const { runId, directory } = startRun();
  approvePlan(directory);
  expect(ark("run", "step", runId, "build", "start").code).toBe(0);
  expect(ark("run", "step", runId, "build", "finish").code).toBe(0);
  const before = eventLines(directory);
  const result = ark("escalate", runId, "--reason", "too early");
  expect(result.code).toBe(1);
  expect(result.err).toContain("round budget");
  expect(eventLines(directory)).toEqual(before);
  expect(eventTypes(directory)).not.toContain("escalation.requested");
});

test("ARK-210-AC2 ark escalate outside phase building exits 1 and names the phase", () => {
  // a run that has not approved its plan is not building
  const early = startRun("demo", "ARK-901");
  const planningRefusal = ark("escalate", early.runId, "--reason", "x");
  expect(planningRefusal.code).toBe(1);
  expect(planningRefusal.err).toContain("planning");

  const open = spentBudgetRun(false);
  expect(ark("status", open.runId).out).toContain("phase: escalation");
  const escalationRefusal = ark("escalate", open.runId, "--reason", "x");
  expect(escalationRefusal.code).toBe(1);
  expect(escalationRefusal.err).toContain("escalation");
  expect(eventTypes(open.directory)).not.toContain("escalation.requested");
});

test("ARK-210-AC2 ark escalate in merge_requests_open exits 1 and names the phase", () => {
  const { runId, directory } = startRun();
  approvePlan(directory);
  expect(ark("run", "step", runId, "build", "start").code).toBe(0);
  expect(ark("run", "step", runId, "build", "finish").code).toBe(0);
  appendEvent(directory, "merge_request.opened", { repo: ".", url: "https://x/pull/1", number: 1 });
  expect(ark("status", runId).out).toContain("phase: merge_requests_open");
  const result = ark("escalate", runId, "--reason", "x");
  expect(result.code).toBe(1);
  expect(result.err).toContain("merge_requests_open");
});

test("ARK-210-AC3 one_more_round after ark escalate returns to building and starts round 3", () => {
  const { runId, directory } = spentBudgetRun(true);
  expect(ark("escalate", runId, "--reason", "P1 open").code).toBe(0);
  expect(ark("gate", "record", runId, "escalation", "one_more_round").code).toBe(0);
  expect(ark("status", runId).out).toContain("phase: building");
  expect(ark("run", "step", runId, "build", "start").code).toBe(0);
  expect(JSON.parse(eventLines(directory).at(-1) as string)).toMatchObject({
    type: "step.started",
    data: { round: 3 },
  });
});

test("ARK-210-AC3 take_over answer after ark escalate is recorded", () => {
  const takeOver = spentBudgetRun(true);
  expect(ark("escalate", takeOver.runId, "--reason", "P1 open").code).toBe(0);
  expect(ark("gate", "record", takeOver.runId, "escalation", "take_over").code).toBe(0);
  expect(JSON.parse(eventLines(takeOver.directory).at(-1) as string)).toMatchObject({
    type: "gate.answered",
    data: { gate: "escalation", answer: "take_over" },
  });
});

test("ARK-210-AC3 abort answer after ark escalate is recorded", () => {
  const aborted = spentBudgetRun(true);
  expect(ark("escalate", aborted.runId, "--reason", "P1 open").code).toBe(0);
  expect(ark("gate", "record", aborted.runId, "escalation", "abort").code).toBe(0);
  expect(ark("status", aborted.runId).out).toContain("phase: closed");
  expect(ark("status", aborted.runId).out).toContain("aborted");
});

test("ARK-228-AC1 ark escalate after an answered one_more_round opens the escalation gate again", () => {
  const { runId } = spentBudgetRun(true);
  expect(ark("escalate", runId, "--reason", "P1 open").code).toBe(0);
  expect(ark("gate", "record", runId, "escalation", "one_more_round").code).toBe(0);
  expect(ark("run", "step", runId, "build", "start").code).toBe(0);
  expect(ark("run", "step", runId, "build", "finish").code).toBe(0);
  expect(ark("escalate", runId, "--reason", "P1 still open").code).toBe(0);
  expect(ark("status", runId).out).toContain("phase: escalation");
});

test("ARK-228-AC2 ark escalate stores the reason without outer whitespace", () => {
  const { runId, directory } = spentBudgetRun(true);
  expect(ark("escalate", runId, "--reason", "  P1 unresolved \n").code).toBe(0);
  expect(JSON.parse(eventLines(directory).at(-1) as string)).toMatchObject({
    type: "escalation.requested",
    data: { reason: "P1 unresolved" },
  });
});

// Fake `orca`: a bun script over $FAKE_ORCA_DIR/state.json. It logs each call to calls.log, pages lists
// by `pageSize`, turns a released worker into terminalState "released", and sleeps when `hang` is set.
const fakeOrca = `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const dir = process.env.FAKE_ORCA_DIR;
const args = process.argv.slice(2);
appendFileSync(dir + "/calls.log", args.join(" ") + "\\n");
const state = JSON.parse(readFileSync(dir + "/state.json", "utf8"));
if (state.delayMs) await Bun.sleep(state.delayMs);
if (state.hang) await Bun.sleep(30000);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const page = (rows, key) => {
  const start = Number(flag("--cursor") ?? 0), size = state.pageSize ?? 100;
  const nextCursor = start + size < rows.length ? String(start + size) : null;
  console.log(JSON.stringify({ ok: true, result: { [key]: rows.slice(start, start + size), nextCursor } }));
};
if (args[1] === "run-list") page(state.runs, "runs");
else if (args[1] === "worker-list") page(state.workers[flag("--run")] ?? [], "workers");
else if (args[1] === "worker-release") {
  if ((state.failRelease ?? []).includes(flag("--dispatch"))) process.exit(1);
  for (const rows of Object.values(state.workers))
    for (const row of rows) if (row.dispatchId === flag("--dispatch")) row.terminalState = "released";
  writeFileSync(dir + "/state.json", JSON.stringify(state));
  console.log(JSON.stringify({ ok: true, result: {} }));
} else process.exit(2);
`;

type FakeWorker = { dispatchId: string; state: string; terminalState: string };
type FakeState = {
  runs: { id: string; objective: string }[];
  workers: Record<string, FakeWorker[]>;
  pageSize?: number;
  hang?: boolean;
  delayMs?: number;
  failRelease?: string[];
};

const originalPath = process.env.PATH;
let fakeDirectory = "";

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.FAKE_ORCA_DIR;
  delete process.env.ARK_ORCA_TIMEOUT_MS;
});

function useFakeOrca(state: FakeState): void {
  fakeDirectory = mkdtempSync(join(tmpdir(), "ark-fake-orca-"));
  mkdirSync(join(fakeDirectory, "bin"));
  writeFileSync(join(fakeDirectory, "bin/orca"), fakeOrca);
  chmodSync(join(fakeDirectory, "bin/orca"), 0o755);
  writeFileSync(join(fakeDirectory, "state.json"), JSON.stringify(state));
  process.env.PATH = `${join(fakeDirectory, "bin")}:${originalPath}`;
  process.env.FAKE_ORCA_DIR = fakeDirectory;
}

const orcaCalls = (verb: string): string[] =>
  existsSync(join(fakeDirectory, "calls.log"))
    ? readFileSync(join(fakeDirectory, "calls.log"), "utf8")
        .split("\n")
        .filter((call) => call.startsWith(`orchestration ${verb} `))
    : [];

const worker = (dispatchId: string, state: string, terminalState: string): FakeWorker => ({
  dispatchId,
  state,
  terminalState,
});

test("ARK-278-AC1 run close releases each settled unreleased dispatch over paged lists and prints one line each", () => {
  const { runId } = startRun();
  useFakeOrca({
    pageSize: 2,
    runs: [
      { id: "orca_other", objective: "Ark run something-else" },
      { id: "orca_a", objective: "Ark run something-else-2" },
      { id: "orca_run", objective: `Ark run ${runId}` },
    ],
    workers: {
      orca_run: [
        worker("ctx_1", "succeeded", "reclaimable"),
        worker("ctx_2", "failed", "release_pending"),
        worker("ctx_3", "stopped", "release_unknown"),
        worker("ctx_4", "succeeded", "released"),
        worker("ctx_5", "succeeded", "retained"),
      ],
    },
  });
  const closed = ark("run", "close", runId, "aborted");
  expect(closed.code).toBe(0);
  expect(closed.out).toContain(
    `${runId} closed: aborted\nctx_1 released (succeeded)\nctx_2 released (failed)\n`,
  );
  expect(closed.out).not.toContain("ctx_3");
  expect(closed.out).not.toContain("ctx_4");
  expect(closed.out).not.toContain("ctx_5");
  expect(orcaCalls("worker-release")).toHaveLength(2);
});

test("ARK-278-AC2 run close keeps an active dispatch and says so", () => {
  const { runId } = startRun();
  useFakeOrca({
    runs: [{ id: "orca_run", objective: `Ark run ${runId}` }],
    workers: {
      orca_run: [
        worker("ctx_live", "ready", "active"),
        worker("ctx_done", "succeeded", "reclaimable"),
      ],
    },
  });
  const closed = ark("run", "close", runId, "aborted");
  expect(closed.code).toBe(0);
  expect(closed.out).toContain("ctx_live still active, not released");
  expect(closed.out).toContain("ctx_done released (succeeded)");
  expect(orcaCalls("worker-release")).toEqual([
    "orchestration worker-release --dispatch ctx_done --json",
  ]);
});

test("ARK-278-AC3 an Orca failure prints one orca line and the close still records and exits 0", () => {
  const closedEvent = (directory: string) =>
    JSON.parse(eventLines(directory).at(-1) as string).type === "run.closed";

  // no orca on PATH
  const missing = startRun();
  const bare = mkdtempSync(join(tmpdir(), "ark-no-orca-"));
  symlinkBun(bare);
  process.env.PATH = `${bare}:/usr/bin:/bin`;
  const noOrca = ark("run", "close", missing.runId, "aborted");
  expect(noOrca.code).toBe(0);
  expect(noOrca.out).toContain("orca: workers not released: orca not found on PATH");
  expect(closedEvent(missing.directory)).toBe(true);

  // orca hangs past the timeout
  const hung = runHangingClose();
  expect(hung.output.code).toBe(0);
  expect(hung.output.out).toMatch(/orca: workers not released: .*timed out$/m);
  expect(hung.output.out.match(/orca:/g)).toHaveLength(1);
  expect(closedEvent(hung.directory)).toBe(true);

  // one failing dispatch: later dispatches of the run are still released, one orca line
  const partial = startRun("demo", "ARK-903");
  useFakeOrca({
    runs: [{ id: "orca_p", objective: `Ark run ${partial.runId}` }],
    workers: {
      orca_p: [
        worker("ctx_bad", "failed", "reclaimable"),
        worker("ctx_bad2", "failed", "reclaimable"),
        worker("ctx_good", "succeeded", "reclaimable"),
      ],
    },
    failRelease: ["ctx_bad", "ctx_bad2"],
  });
  const part = ark("run", "close", partial.runId, "aborted");
  expect(part.code).toBe(0);
  expect(part.out).toBe(
    `${partial.runId} closed: aborted\nctx_good released (succeeded)\norca: workers not released: orca orchestration worker-release failed or timed out\n`,
  );
  expect(orcaCalls("worker-release")).toHaveLength(3);

  // no Orca Run for the objective
  const none = startRun("demo", "ARK-902");
  useFakeOrca({ runs: [{ id: "orca_x", objective: "Ark run other" }], workers: {} });
  const nothing = ark("run", "close", none.runId, "aborted");
  expect(nothing.code).toBe(0);
  expect(nothing.out).toBe(`${none.runId} closed: aborted\n`);
});

test("ARK-292-AC1 the 300 ms ARK-278-AC3 timeout does not leak into a later close against a slow orca", () => {
  runHangingClose();

  // real wall-clock delay: the fake orca subprocess must outlast the leaked 300 ms to prove the override is gone
  const slow = startRun("demo", "ARK-904");
  useFakeOrca({
    delayMs: 700,
    runs: [{ id: "orca_slow", objective: `Ark run ${slow.runId}` }],
    workers: { orca_slow: [worker("ctx_slow", "succeeded", "reclaimable")] },
  });
  const closed = ark("run", "close", slow.runId, "aborted");
  expect(closed.out).toContain("ctx_slow released (succeeded)");
  expect(closed.out).not.toContain("orca:");
});

// Shared by ARK-278-AC3 and ARK-292-AC1: the hang case sets a short timeout and must clean it up itself.
function runHangingClose() {
  const hung = startRun("demo", "ARK-901");
  useFakeOrca({ runs: [], workers: {}, hang: true });
  process.env.ARK_ORCA_TIMEOUT_MS = "300";
  try {
    return { directory: hung.directory, output: ark("run", "close", hung.runId, "aborted") };
  } finally {
    delete process.env.ARK_ORCA_TIMEOUT_MS;
  }
}

function symlinkBun(directory: string): void {
  Bun.spawnSync(["ln", "-s", process.execPath, join(directory, "bun")]);
}

test("ARK-278-AC4 run close --sweep releases closed runs once, records no event, and refuses a run argument", () => {
  const first = startRun("demo", "ARK-901");
  const second = startRun("demo", "ARK-902");
  const open = startRun("demo", "ARK-903");
  for (const run of [first, second])
    appendEvent(run.directory, "run.closed", { outcome: "aborted" });
  const eventCounts = [first, second, open].map((run) => eventLines(run.directory).length);
  useFakeOrca({
    runs: [first, second, open].map((run) => ({
      id: `orca_${run.runId}`,
      objective: `Ark run ${run.runId}`,
    })),
    workers: Object.fromEntries(
      [first, second, open].map((run) => [
        `orca_${run.runId}`,
        [
          worker(`ctx_${run.runId}`, "succeeded", "reclaimable"),
          // real Orca keeps a retained row retained after a release, so a sweep must not retry it
          worker(`ctx_kept_${run.runId}`, "stopped", "retained"),
          // a release of an unresolved terminal fails and keeps the row, so a sweep must not make it
          worker(`ctx_unknown_${run.runId}`, "failed", "release_unknown"),
        ],
      ]),
    ),
  });

  const swept = ark("run", "close", "--sweep", "--project", "demo");
  expect(swept.code).toBe(0);
  expect(swept.out).toBe(
    [first, second]
      .map((run) => `${run.runId}:\n  ctx_${run.runId} released (succeeded)\n`)
      .join(""),
  );
  expect(orcaCalls("worker-release")).toHaveLength(2);
  expect([first, second, open].map((run) => eventLines(run.directory).length)).toEqual(eventCounts);

  const again = ark("run", "close", "--sweep");
  expect(again.code).toBe(0);
  expect(again.out).toBe("");
  expect(orcaCalls("worker-release")).toHaveLength(2);

  const refused = ark("run", "close", open.runId, "aborted", "--sweep");
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("--sweep takes no run argument");
  expect(eventLines(open.directory)).toHaveLength(eventCounts[2]);
  expect(ark("run", "close", open.runId).code).toBe(1);
});

test("ARK-278-AC7 a released worker that stays listed is never released again and the sweep stays silent", () => {
  const closed = startRun("demo", "ARK-911");
  appendEvent(closed.directory, "run.closed", { outcome: "aborted" });
  useFakeOrca({
    runs: [{ id: "orca_closed", objective: `Ark run ${closed.runId}` }],
    workers: {
      orca_closed: [
        worker("ctx_old", "succeeded", "released"),
        worker("ctx_new", "failed", "reclaimable"),
      ],
    },
  });

  const first = ark("run", "close", "--sweep", "--project", "demo");
  expect(first.code).toBe(0);
  expect(first.out).toBe(`${closed.runId}:\n  ctx_new released (failed)\n`);
  expect(orcaCalls("worker-release")).toEqual([
    "orchestration worker-release --dispatch ctx_new --json",
  ]);

  const second = ark("run", "close", "--sweep", "--project", "demo");
  expect(second.code).toBe(0);
  expect(second.out).toBe("");
  expect(orcaCalls("worker-release")).toHaveLength(1);
  // both rows are still listed after the sweeps
  expect(orcaCalls("worker-list").length).toBeGreaterThanOrEqual(2);
});

const statusOf = (runId: string) => {
  const out = ark("status", runId).out;
  return { round: out.match(/^round:.*$/m)?.[0], phase: out.match(/^phase:.*$/m)?.[0] };
};
const lastRound = (directory: string) =>
  JSON.parse(eventLines(directory).at(-1) as string).data.round;

for (const startedRounds of [0, 1]) {
  test(`ARK-282-AC2 finish --failed --not-started restores the round after ${startedRounds} failed rounds of 2`, () => {
    const { runId, directory } = startRun();
    approvePlan(directory);
    for (let round = 1; round <= startedRounds; round++) {
      expect(ark("run", "step", runId, "build", "start").code).toBe(0);
      ark("run", "step", runId, "build", "finish", "--failed");
    }
    const before = statusOf(runId);
    expect(ark("run", "step", runId, "build", "start").code).toBe(0);
    const failedStartRound = lastRound(directory);
    expect(failedStartRound).toBe(startedRounds + 1);

    const finished = ark("run", "step", runId, "build", "finish", "--failed", "--not-started");
    expect(finished.code).toBe(0);
    expect(JSON.parse(eventLines(directory).at(-1) as string).data).toEqual({
      step: "build",
      outcome: "failed",
      not_started: true,
    });
    expect(statusOf(runId)).toEqual(before);

    expect(ark("run", "step", runId, "build", "start").code).toBe(0);
    expect(lastRound(directory)).toBe(failedStartRound);
  });
}

test("ARK-282-AC2 --not-started is a usage error without --failed, with start and with --merge", () => {
  const { runId, directory } = startRun();
  approvePlan(directory);
  expect(ark("run", "step", runId, "build", "start").code).toBe(0);
  const before = eventLines(directory);
  const attempts = [
    ["build", "finish", "--not-started"],
    ["build", "start", "--not-started"],
    ["build", "finish", "--failed", "--not-started", "--merge"],
  ];
  for (const args of attempts) {
    const result = ark("run", "step", runId, ...args);
    expect(result.code).toBe(1);
    if (!args.includes("--merge")) expect(result.err).toContain("--not-started");
  }
  expect(eventLines(directory)).toEqual(before);
});

test("ARK-282-AC2 --not-started is refused unless the step has a running start", () => {
  const { runId, directory } = startRun();
  approvePlan(directory);
  const attempt = () => ark("run", "step", runId, "build", "finish", "--failed", "--not-started");
  expect(attempt().code).toBe(1);
  expect(ark("run", "step", runId, "build", "start").code).toBe(0);
  ark("run", "step", runId, "build", "finish", "--failed");
  const before = eventLines(directory);
  const result = attempt();
  expect(result.code).toBe(1);
  expect(result.err).toContain("--not-started");
  expect(eventLines(directory)).toEqual(before);
});

test("ARK-282-AC2 finish --failed --not-started after a merge start keeps the real round", () => {
  const { runId, directory } = startRun();
  approvePlan(directory);
  for (const round of [1, 2]) {
    expect(ark("run", "step", runId, "build", "start").code).toBe(0);
    expect(lastRound(directory)).toBe(round);
    ark("run", "step", runId, "build", "finish", "--failed");
  }
  const before = statusOf(runId);
  appendEvent(directory, "worktree.synced", { repo: ".", conflict: true });
  appendEvent(directory, "step.started", {
    step: "build",
    role: "implementer",
    repo: ".",
    round: 2,
    merge: true,
  });
  expect(ark("run", "step", runId, "build", "finish", "--failed", "--not-started").code).toBe(0);
  expect(statusOf(runId)).toEqual(before);
});

test("ARK-282-AC3 a failed start at the last round keeps phase building and opens no escalation gate", () => {
  const { runId, directory } = startRun();
  approvePlan(directory);
  for (const round of [1, 2]) {
    expect(ark("run", "step", runId, "build", "start").code).toBe(0);
    expect(lastRound(directory)).toBe(round);
    ark("run", "step", runId, "build", "finish", "--failed");
  }
  appendEvent(directory, "test.completed", {
    passed: false,
    heads: {},
    suites: [],
    criteria: { "ARK-900-AC1": "failing" },
  });
  appendEvent(directory, "gate.answered", { gate: "escalation", answer: "one_more_round" });

  expect(ark("run", "step", runId, "build", "start").code).toBe(0);
  expect(lastRound(directory)).toBe(3);
  expect(ark("run", "step", runId, "build", "finish", "--failed", "--not-started").code).toBe(0);

  const status = ark("status", runId).out;
  expect(status).toContain("phase: building");
  expect(status).toContain("waiting gate: none");
  const gatesBefore = eventLines(directory).filter((line) => line.includes('"gate.'));
  expect(ark("run", "step", runId, "build", "start").code).toBe(0);
  expect(lastRound(directory)).toBe(3);
  expect(eventLines(directory).filter((line) => line.includes('"gate.'))).toEqual(gatesBefore);
});

/** A building run in a real git worktree. Its one suite is a real `bun test` file that proves ARK-900-AC1. */
function worktreeRun(config: Record<string, unknown> = {}): {
  runId: string;
  directory: string;
  worktree: string;
} {
  const workspace = tempGitRepo({
    "ac.test.ts": `import { test } from "bun:test"; test("ARK-900-AC1 works", () => {});\n`,
  });
  writeProject(
    "demo",
    validConfig({
      workspace,
      suites: [
        {
          name: "e2e",
          level: "e2e",
          repo: ".",
          command: "bun test --reporter=junit --reporter-outfile={report} ./ac.test.ts",
          parser: "bun",
        },
      ],
      ...config,
    }),
  );
  const { runId, directory } = startRun();
  recordEvaluation(directory);
  writeFileSync(
    join(directory, "plan.yml"),
    JSON.stringify({
      design: { interfaces: [{ name: "fixture plan", callers: ["ark test"] }] },
      summary: {
        why: "Fixture.",
        changes: [{ criterion: "ARK-900-AC1", where: "tests", now: "None.", fix: "A test." }],
      },
      steps: workspaceSteps.map((step) => ({ ...step, harness: "claude", model: "claude-sonnet" })),
      test_cases: [
        {
          id: "proves-ARK-900-AC1",
          criterion: "ARK-900-AC1",
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
  ]) {
    const result = ark(...args);
    if (result.code !== 0) throw new Error(`${args.join(" ")} failed: ${result.err}`);
  }
  const worktree = (
    JSON.parse(
      eventLines(directory).find((line) => line.includes('"worktree.created"')) as string,
    ) as { data: { path: string } }
  ).data.path;
  return { runId, directory, worktree };
}

function commitIn(worktree: string, name: string): string {
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: worktree, stdout: "pipe" })
      .stdout.toString()
      .trim();
  writeFileSync(join(worktree, `${name}.txt`), name);
  git("add", "-A");
  git("commit", "-q", "-m", name);
  return git("rev-parse", "HEAD");
}

const testHeadLines = (runId: string) =>
  ark("status", runId)
    .out.split("\n")
    .filter((line) => line.startsWith("test head:"));

test("ARK-287-AC2 ark status prints no test head line before the first test, current after it and stale after one new commit", () => {
  const { runId, worktree } = worktreeRun();
  expect(testHeadLines(runId)).toEqual([]);

  expect(ark("test", runId).code).toBe(0);
  const tested = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: worktree })
    .stdout.toString()
    .trim();
  expect(testHeadLines(runId)).toEqual(["test head: current"]);

  const now = commitIn(worktree, "late");
  expect(testHeadLines(runId)).toEqual([
    `test head: stale (. tested ${tested.slice(0, 8)}, now ${now.slice(0, 8)})`,
  ]);
});

test("ARK-287-AC2 ark status skips a worktree whose path is gone and says tested nothing for a repo the test did not record", () => {
  const { runId, directory, worktree } = worktreeRun();
  const sibling = tempGitRepo();
  appendEvent(directory, "worktree.created", {
    repo: "docs",
    path: join(sibling, "removed"),
    branch: "x",
  });
  expect(ark("test", runId).code).toBe(0);
  // The missing path is skipped: status exits 0 and the run is current.
  const missing = ark("status", runId);
  expect(missing.code).toBe(0);
  expect(testHeadLines(runId)).toEqual(["test head: current"]);

  // A repo with a worktree but no tested head is stale with `tested nothing`.
  appendEvent(directory, "worktree.created", { repo: "docs", path: sibling, branch: "main" });
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: sibling })
    .stdout.toString()
    .trim();
  expect(testHeadLines(runId)).toEqual([
    `test head: stale (docs tested nothing, now ${head.slice(0, 8)})`,
  ]);
  expect(worktree).not.toBe(sibling);
});

test("ARK-287-AC3 a spent budget with a failed last test is escalation, and a passing ark test at a new head returns to building with no answer", () => {
  const { runId, directory, worktree } = worktreeRun();
  for (let round = 1; round <= 2; round++) {
    expect(ark("run", "step", runId, "build", "start").code).toBe(0);
    expect(ark("run", "step", runId, "build", "finish").code).toBe(0);
  }
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: worktree })
    .stdout.toString()
    .trim();
  appendEvent(directory, "test.completed", {
    passed: false,
    heads: { ".": head },
    suites: [],
    criteria: { "ARK-900-AC1": "failing" },
  });
  const escalated = ark("status", runId).out;
  expect(escalated).toContain("phase: escalation");
  expect(escalated).toContain("waiting gate: escalation");

  commitIn(worktree, "fix");
  expect(testHeadLines(runId)).toEqual([expect.stringContaining("test head: stale (.")]);
  expect(ark("test", runId).code).toBe(0);

  const status = ark("status", runId).out;
  expect(status).toContain("phase: building");
  expect(status).toContain("waiting gate: none");
  expect(status).toContain("test head: current");
  const eventsBefore = eventLines(directory);
  const opened = ark("merge-request", "open", runId);
  expect(opened.err).not.toContain("changed since the last test run");
  expect(opened.err).not.toContain("escalation");
  expect(eventLines(directory).some((line) => line.includes('"gate":"escalation"'))).toBe(false);
  expect(eventLines(directory).slice(0, eventsBefore.length)).toEqual(eventsBefore);
});

const localBranchLines = (runId: string) =>
  ark("status", runId)
    .out.split("\n")
    .filter((line) => line.startsWith("branch"));

test("ARK-295-AC5 a none project lists each branch with commits beyond its base, before and after handed_off", () => {
  const { runId, directory, worktree } = worktreeRun({ merge_requests: "none" });
  const created = JSON.parse(
    eventLines(directory).find((line) => line.includes('"worktree.created"')) as string,
  ).data as { branch: string; base: string };

  // No commit yet: the local-only line replaces `merge requests: none`, and no branch line.
  const before = ark("status", runId);
  expect(before.code).toBe(0);
  expect(before.out).toContain("merge requests: none (local only)\n");
  expect(before.out).not.toMatch(/^merge requests: none$/m);
  expect(localBranchLines(runId)).toEqual([]);

  commitIn(worktree, "one");
  commitIn(worktree, "two");
  const line = `branch   .  ${created.branch}  2 commit(s) ahead of ${created.base.slice(0, 8)}`;
  expect(created.base).toHaveLength(40);
  expect(localBranchLines(runId)).toEqual([line]);
  expect(ark("status", runId).out).toContain(`merge requests: none (local only)\n${line}\n`);

  // After the close the worktree is gone and the kept branch is counted in the source repo.
  expect(ark("test", runId).code).toBe(0);
  const closed = ark("run", "close", runId, "handed_off");
  expect(closed.code).toBe(0);
  expect(existsSync(worktree)).toBe(false);
  const after = ark("status", runId);
  expect(after.code).toBe(0);
  expect(after.out).toContain(`merge requests: none (local only)\n${line}\n`);
});

test("ARK-295-AC5 an open project and a project with no ark.yml print the unchanged merge requests line", () => {
  const { runId, directory, worktree } = worktreeRun({ merge_requests: "open" });
  commitIn(worktree, "one");
  const open = ark("status", runId);
  expect(open.code).toBe(0);
  expect(open.out).toMatch(/^merge requests: none$/m);
  expect(open.out).not.toContain("(local only)");
  expect(localBranchLines(runId)).toEqual([]);

  rmSync(join(directory, "../../ark.yml"));
  const missing = ark("status", runId);
  expect(missing.code).toBe(0);
  expect(missing.out).toMatch(/^merge requests: none$/m);
  expect(missing.out).not.toContain("(local only)");
  expect(localBranchLines(runId)).toEqual([]);
});

test("ARK-295-AC5 ark status counts a none project with an invalid unrelated field as open instead of failing", () => {
  const { runId, directory } = worktreeRun({ merge_requests: "none" });
  const configFile = join(directory, "../../ark.yml");
  writeFileSync(
    configFile,
    JSON.stringify({ ...JSON.parse(readFileSync(configFile, "utf8")), concurrency: 0 }),
  );
  const result = ark("status", runId);
  expect(result.code).toBe(0);
  expect(result.out).toMatch(/^merge requests: none$/m);
  expect(result.out).not.toContain("(local only)");
});

/** A run with gates.escalation auto whose spent budget `ark run step ... start` answers by auto. */
function autoEscalatedRun(): { runId: string; directory: string } {
  writeProject("demo", validConfig({ gates: { escalation: "auto" } }));
  const { runId, directory } = startRun();
  approvePlan(directory);
  for (let round = 1; round <= 2; round++) {
    expect(ark("run", "step", runId, "build", "start").code).toBe(0);
    expect(ark("run", "step", runId, "build", "finish").code).toBe(0);
  }
  appendEvent(directory, "test.completed", {
    passed: false,
    heads: {},
    suites: [],
    criteria: { "ARK-900-AC1": "failing" },
  });
  const started = ark("run", "step", runId, "build", "start");
  expect(started.err).toBe("");
  expect(started.out).toContain("escalation one_more_round by auto (1 of 2)");
  return { runId, directory };
}

test("ARK-288-AC7 ark status prints escalation one_more_round by auto after an automatic answer", () => {
  const { runId } = autoEscalatedRun();
  const status = ark("status", runId);
  expect(status.code).toBe(0);
  expect(status.out).toContain("escalation one_more_round by auto");
  expect(status.out).not.toContain("escalation one_more_round by human");
});

test("ARK-288-AC7 the retro counts the automatic escalation answer as auto and the run page timeline shows by auto", () => {
  const { runId, directory } = autoEscalatedRun();
  expect(ark("retro", runId).code).toBe(0);
  const metrics = JSON.parse(readFileSync(join(directory, "metrics.json"), "utf8"));
  expect(metrics.gates).toMatchObject({ auto_answers: 1 });
  const events = readFileSync(join(directory, "events.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const entry = timelineOf(events).find((item) => item.why.startsWith("escalation gate"));
  expect(entry?.why).toBe("escalation gate: one_more_round by auto");
});
