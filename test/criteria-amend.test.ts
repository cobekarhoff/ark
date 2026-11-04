import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { manualCriteria } from "../cli/criteria.ts";
import { appendEvent } from "../cli/events.ts";
import { ark, recordEvaluation, tempArkHome, tempGitRepo, writeProject } from "./helpers.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

const AC1 = "ARK-207-AC1";
const AC2 = "ARK-207-AC2";

let backlogFile: string;
let runDirectory: string;
let runId: string;

const ticketText = [
  "---",
  "id: ARK-207",
  'title: "Amend demo"',
  "acceptance_criteria:",
  `  - id: ${AC1}`,
  '    text: "original one"',
  `  - id: ${AC2}`,
  '    text: "original two"',
  "---",
  "## Acceptance criteria",
  "",
  "| ID | Criterion |",
  "| --- | --- |",
  `| ${AC1} | original one |`,
  `| ${AC2} | original two |`,
  "",
].join("\n");

const read = (name: string) => readFileSync(join(runDirectory, name), "utf8");
const events = () =>
  read("events.ndjson")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const amendments = () => events().filter((event) => event.type === "criteria.amended");
const textFile = (name: string, content: string) => {
  const file = join(runDirectory, `${name}.txt`);
  writeFileSync(file, content);
  return file;
};

const step = (id: string, role: string, needs: string[]) => ({
  id,
  role,
  repo: ".",
  harness: "omp",
  model: "pi/task",
  needs,
  criteria: [AC1, AC2],
});

function writeValidPlan(): void {
  const testCase = (id: string, criterion: string) => ({
    id,
    criterion,
    level: "integration",
    given: [],
    when: ["do the thing"],
    // oxlint-disable-next-line unicorn/no-thenable -- plan test-case field `then: string[]`
    then: ["it works"],
    expected: "the system shall work",
  });
  writeFileSync(
    join(runDirectory, "plan.yml"),
    JSON.stringify({
      design: { approach: "Do it.", interfaces: [{ name: "x", callers: ["y"] }], example: "ok" },
      summary: {
        why: "Because.",
        changes: [AC1, AC2].map((criterion) => ({ criterion, where: "x", now: "a", fix: "b" })),
      },
      steps: [step("build", "implementer", []), step("check", "validator", ["build"])],
      test_cases: [testCase("t1", AC1), testCase("t2", AC2)],
    }),
  );
}

beforeEach(() => {
  tempArkHome();
  const project = writeProject("demo", {
    workspace: tempGitRepo(),
    ticket_source: "local",
    suites: [{ name: "cli", level: "integration", repo: ".", command: "true", parser: "bun" }],
    roles: {
      implementer: { harness: "omp", model: "pi/task" },
      validator: { harness: "omp", model: "pi/task" },
      reviewer: { harness: "omp", model: "pi/task" },
    },
  });
  backlogFile = join(project, "tickets", "ARK-207.md");
  Bun.spawnSync(["mkdir", "-p", join(project, "tickets")]);
  writeFileSync(backlogFile, ticketText);
  expect(ark("run", "start", backlogFile).code).toBe(0);
  runId = readdirSync(join(project, "runs"))[0];
  runDirectory = join(project, "runs", runId);
  recordEvaluation(runDirectory);
});

test(`${AC1} writes the new text into ticket.md frontmatter and table and records the event`, () => {
  const before = read("ticket.md");
  const result = ark(
    "criteria",
    "amend",
    runId,
    AC1,
    textFile("new", "new | one\n"),
    "--reason",
    "why",
  );
  expect(result.code).toBe(0);
  expect(read("ticket.md")).toBe(
    before
      .replace('text: "original one"', 'text: "new | one"')
      .replace(`| ${AC1} | original one |`, `| ${AC1} | new \\| one |`),
  );
  expect(amendments()).toEqual([
    expect.objectContaining({
      data: { criterion: AC1, old: "original one", new: "new | one", by: "human", reason: "why" },
    }),
  ]);
  expect(readFileSync(backlogFile, "utf8")).toBe(ticketText);
});

test(`${AC1} a second amendment records the first amended text as old`, () => {
  expect(ark("criteria", "amend", runId, AC1, textFile("a", "first"), "--reason", "why").code).toBe(
    0,
  );
  expect(
    ark("criteria", "amend", runId, AC1, textFile("b", "second"), "--reason", "why").code,
  ).toBe(0);
  expect(amendments().map((event) => event.data)).toEqual([
    { criterion: AC1, old: "original one", new: "first", by: "human", reason: "why" },
    { criterion: AC1, old: "first", new: "second", by: "human", reason: "why" },
  ]);
  expect(read("ticket.md")).toContain(`| ${AC1} | second |`);
});

test(`${AC2} refuses an unknown criterion, names it, and changes nothing`, () => {
  const ticket = read("ticket.md");
  const log = read("events.ndjson");
  const result = ark(
    "criteria",
    "amend",
    runId,
    "ARK-207-AC9",
    textFile("new", "x"),
    "--reason",
    "why",
  );
  expect(result.code).toBe(1);
  expect(result.err).toContain("ARK-207-AC9");
  expect(read("ticket.md")).toBe(ticket);
  expect(read("events.ndjson")).toBe(log);
});

test(`${AC2} refuses a run in merge_requests_open, names the phase, and changes nothing`, () => {
  writeValidPlan();
  expect(ark("plan", "check", runId).code).toBe(0);
  expect(ark("gate", "record", runId, "plan", "approve").code).toBe(0);
  appendEvent(runDirectory, "merge_request.opened", { repo: ".", url: "u" });
  const ticket = read("ticket.md");
  const log = read("events.ndjson");
  const result = ark("criteria", "amend", runId, AC1, textFile("new", "x"), "--reason", "why");
  expect(result.code).toBe(1);
  expect(result.err).toContain("merge_requests_open");
  expect(read("ticket.md")).toBe(ticket);
  expect(read("events.ndjson")).toBe(log);
});

test(`${AC2} refuses an empty file and changes nothing`, () => {
  const ticket = read("ticket.md");
  const log = read("events.ndjson");
  const result = ark("criteria", "amend", runId, AC1, textFile("empty", ""), "--reason", "why");
  expect(result.code).toBe(1);
  expect(read("ticket.md")).toBe(ticket);
  expect(read("events.ndjson")).toBe(log);
});

test(`ARK-207-AC3 plan.md lists the amendment after the next plan check, and approve waits for it`, () => {
  writeValidPlan();
  expect(ark("plan", "check", runId).code).toBe(0);
  expect(read("plan.md")).not.toContain("Amended criteria");
  expect(
    ark("criteria", "amend", runId, AC1, textFile("new", "brand new text"), "--reason", "why").code,
  ).toBe(0);

  const refused = ark("gate", "record", runId, "plan", "approve");
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("plan.checked");

  expect(ark("plan", "check", runId).code).toBe(0);
  const plan = read("plan.md");
  expect(plan).toContain("## Amended criteria");
  expect(plan).toContain(`### ${AC1}`);
  expect(plan).toContain("- **Old:** original one");
  expect(plan).toContain("- **New:** brand new text");
  expect(plan).not.toContain(`### ${AC2}\n\n- **Old:**`);
  expect(ark("gate", "record", runId, "plan", "approve").code).toBe(0);
});

test("ARK-283-AC1 criteria amend keeps manual: true on the amended criterion (block-style ticket)", () => {
  writeFileSync(
    join(runDirectory, "ticket.md"),
    read("ticket.md").replace('text: "original one"', 'text: "original one"\n    manual: true'),
  );
  expect(manualCriteria(runDirectory)).toEqual([AC1]);
  expect(
    ark("criteria", "amend", runId, AC1, textFile("m", "reworded one"), "--reason", "why").code,
  ).toBe(0);
  expect(read("ticket.md")).toContain("manual: true");
  expect(manualCriteria(runDirectory)).toEqual([AC1]);
});

/** Plan checked, approved and a worktree made: the run is in building. */
function buildingRun(): void {
  writeValidPlan();
  for (const args of [
    ["plan", "check", runId],
    ["gate", "record", runId, "plan", "approve"],
    ["worktree", "create", runId, "."],
  ])
    expect(ark(...args).code).toBe(0);
  expect(ark("status", runId).out).toContain("phase: building");
}

const amend = (id: string, text: string, ...reason: string[]) =>
  ark("criteria", "amend", runId, id, textFile("amend", text), ...reason);

test("ARK-308-AC1 amend with --reason succeeds in building, escalation and testing", () => {
  buildingRun();
  expect(amend(AC1, "in building", "--reason", "r1").code).toBe(0);

  // testing: a test run has been recorded and the run is still building
  appendEvent(runDirectory, "test.completed", {
    passed: true,
    heads: {},
    suites: [{ name: "cli", level: "integration", passed: true }],
    criteria: {},
  });
  expect(amend(AC1, "in testing", "--reason", "r2").code).toBe(0);

  // escalation: the round budget is spent and the last test failed
  appendEvent(runDirectory, "step.started", {
    step: "build",
    role: "implementer",
    repo: ".",
    round: 2,
  });
  appendEvent(runDirectory, "test.completed", {
    passed: false,
    heads: {},
    suites: [{ name: "cli", level: "integration", passed: false }],
    criteria: {},
  });
  expect(ark("status", runId).out).toContain("phase: escalation");
  expect(amend(AC1, "in escalation", "--reason", "r3").code).toBe(0);
  expect(ark("status", runId).out).toContain("phase: escalation");
  expect(amendments().map((event) => event.data.reason)).toEqual(["r1", "r2", "r3"]);
  expect(read("ticket.md")).toContain(`| ${AC1} | in escalation |`);
});

test("ARK-308-AC1 amend is refused in merge_requests_open and in a closed run, naming the phase", () => {
  buildingRun();
  appendEvent(runDirectory, "merge_request.opened", { repo: ".", url: "u" });
  const ticket = read("ticket.md");
  const log = read("events.ndjson");
  const open = amend(AC1, "x", "--reason", "why");
  expect(open.code).toBe(1);
  expect(open.err).toContain("merge_requests_open");
  expect(read("ticket.md")).toBe(ticket);
  expect(read("events.ndjson")).toBe(log);

  appendEvent(runDirectory, "run.closed", { outcome: "abandoned" });
  const closed = amend(AC1, "x", "--reason", "why");
  expect(closed.code).toBe(1);
  expect(closed.err).toContain("closed");
  expect(read("ticket.md")).toBe(ticket);
});

test("ARK-308-AC1 amend without --reason, or with an empty or blank one, is refused and changes nothing", () => {
  const ticket = read("ticket.md");
  const log = read("events.ndjson");
  for (const reason of [[], ["--reason", ""], ["--reason", "   "]]) {
    const result = amend(AC1, "x", ...reason);
    expect(result.code).toBe(1);
    expect(result.err).toContain("--reason");
  }
  expect(read("ticket.md")).toBe(ticket);
  expect(read("events.ndjson")).toBe(log);
});

test("ARK-308-AC2 the event holds by human and the reason, and ark status shows the amendment and its reason", () => {
  const result = amend(AC1, "brand new text", "--reason", "the old wording named a deleted path");
  expect(result.code).toBe(0);
  expect(amendments()[0].data).toEqual({
    criterion: AC1,
    old: "original one",
    new: "brand new text",
    by: "human",
    reason: "the old wording named a deleted path",
  });
  const status = ark("status", runId).out;
  expect(status).toContain("amended criteria:");
  expect(status).toContain(`${AC1} by human: the old wording named a deleted path`);
  expect(status).toContain("new: ");
});

test("ARK-308-AC3 an amendment in planning clears the plan check, so ark plan check is needed again", () => {
  writeValidPlan();
  expect(ark("plan", "check", runId).code).toBe(0);
  expect(amend(AC1, "reworded", "--reason", "why").code).toBe(0);
  const refused = ark("gate", "record", runId, "plan", "approve");
  expect(refused.code).toBe(1);
  expect(ark("status", runId).out).toContain("phase: planning");
  expect(ark("plan", "check", runId).code).toBe(0);
  expect(ark("gate", "record", runId, "plan", "approve").code).toBe(0);
});

test("ARK-308-AC1 an amendment in awaiting_strategy is accepted and does not say the plan is approved", () => {
  appendEvent(runDirectory, "evaluation.recorded", { blockers: [], risks: [], surfaces: ["none"] });
  appendEvent(runDirectory, "strategy.recorded", {
    count: 2,
    recommended: "A",
    cards: ["A", "B"],
    card_text: { A: "### A", B: "### B" },
  });
  expect(ark("status", runId).out).toContain("phase: awaiting_strategy");
  const result = amend(AC1, "reworded before the strategy", "--reason", "why");
  expect(result.code).toBe(0);
  expect(result.out).not.toContain("the plan is approved");
  expect(ark("status", runId).out).toContain("phase: awaiting_strategy");
});

// ark test judges each criterion by its ID, its manual flag and its gate answer, so the amended text resets a manual answer and is judged anew.
test("ARK-308-AC3 an amendment in building keeps the phase and the approval, clears that criterion's manual answer, and ark test judges the new text", () => {
  writeFileSync(
    join(runDirectory, "ticket.md"),
    read("ticket.md").replace('text: "original one"', 'text: "original one"\n    manual: true'),
  );
  buildingRun();
  expect(ark("gate", "record", runId, "manual", AC1, "ok").code).toBe(0);
  const before = ark("test", runId);
  expect(before.out).toContain(`criterion  ${AC1}  manual ok`);

  const result = amend(AC1, "reworded after the plan gate", "--reason", "why");
  expect(result.code).toBe(0);
  expect(result.out).toContain("do not run ark plan check again");
  const status = ark("status", runId).out;
  expect(status).toContain("phase: building");
  expect(status).not.toContain("phase: planning");

  const after = ark("test", runId);
  expect(after.out).toContain(`criterion  ${AC1}  manual pending`);
  expect(read("ticket.md")).toContain("reworded after the plan gate");
  expect(read("ticket.md")).toContain("manual: true");
  expect(ark("gate", "record", runId, "manual", AC1, "ok").code).toBe(0);
  expect(ark("test", runId).out).toContain(`criterion  ${AC1}  manual ok`);
});
