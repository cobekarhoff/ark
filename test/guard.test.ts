import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent, deriveState, readEvents } from "../cli/events.ts";
import { planHash } from "../cli/plan.ts";
import { frontmatter, parseCriteria } from "../cli/ticket.ts";
import { installFakeOrca, removeFakeOrca } from "./fake-orca.ts";
import {
  acceptCriteriaFile,
  ark,
  type CriteriaRow,
  recordEvaluation,
  recordStrategy,
  tempArkHome,
  tempGitRepo,
  writeProject,
  writeTicket,
} from "./helpers.ts";

// ARK-617: the `guard` key of a criterion, through the `ark` process: the criteria gate (ARK-T764), the
// bug run's red proof at the implementer start (ARK-T763) and `ark criteria amend --guard` (ARK-T766).
setDefaultTimeout(120_000);

afterEach(removeFakeOrca);

const redTestRefusal = "bug run: record a failing ark test of the ACs before the fix";
const allGuardsRefusal = "bug run: every AC is a guard; mark the AC that shows the bug";

type Run = { runId: string; runDirectory: string; ticketId: string; ticketFile: string };

let ticketCounter = 0;

beforeEach(() => {
  tempArkHome();
  delete process.env.ARK_PROJECT;
  installFakeOrca();
  writeProject("demo", {
    workspace: tempGitRepo(),
    ticket_source: "local",
    suites: [{ name: "e2e", level: "e2e", repo: ".", command: "bun test {report}", parser: "bun" }],
    roles: {
      implementer: { harness: "claude", model: "claude-sonnet" },
      validator: { harness: "codex", model: "gpt-codex" },
      reviewer: { harness: "codex", model: "gpt-codex" },
    },
  });
});

/** A run of `kind` started from a ticket with no criteria and evaluated, so it waits in awaiting_criteria. */
function startRun(kind: string | undefined): Run {
  const ticketId = `ARK-${900 + ++ticketCounter}`;
  const ticketFile = writeTicket("demo", ticketId, [], `Ticket ${ticketId}`, kind);
  const started = ark("run", "start", ticketFile, "--project", "demo");
  expect(started.code, started.err).toBe(0);
  const runId = started.out.trim();
  const runDirectory = join(process.env.ARK_HOME as string, "projects", "demo", "runs", runId);
  recordEvaluation(runDirectory);
  return { runId, runDirectory, ticketId, ticketFile };
}

/** The run's plan checked and approved by events, as the run is when its implementer starts: step `build`. */
function approvePlan(run: Run): void {
  const criteria = deriveState(readEvents(run.runDirectory)).criteria.map(({ id }) => id);
  writeFileSync(join(run.runDirectory, "plan.yml"), "steps: []\n");
  appendEvent(run.runDirectory, "plan.checked", {
    valid: true,
    problems: [],
    plan_hash: planHash(run.runDirectory),
    steps: [{ id: "build", role: "implementer", repo: ".", needs: [], criteria }],
  });
  appendEvent(run.runDirectory, "gate.answered", { gate: "plan", answer: "approve" });
}

/** A run in building whose criteria gate got `rows` through the real `--criteria` path. */
function buildingRun(kind: string | undefined, rows: CriteriaRow[]): Run {
  const run = startRun(kind);
  const accepted = acceptCriteriaFile(run.runId, run.runDirectory, rows);
  expect(accepted.code, accepted.err).toBe(0);
  approvePlan(run);
  expect(deriveState(readEvents(run.runDirectory)).phase).toBe("building");
  return run;
}

const read = (run: Run, name: string) => readFileSync(join(run.runDirectory, name), "utf8");
const eventsOf = (run: Run) => readEvents(run.runDirectory);
const eventCount = (run: Run) => eventsOf(run).length;
const stateOf = (run: Run) => deriveState(eventsOf(run));
const canonical = (run: Run, localId: string) => `${run.ticketId}/${localId}`;

/** Appends one `test.completed` whose statuses are named by local id (`AC1`). */
function completed(run: Run, statuses: Record<string, string>): void {
  appendEvent(run.runDirectory, "test.completed", {
    passed: false,
    heads: {},
    suites: [],
    criteria: Object.fromEntries(
      Object.entries(statuses).map(([localId, status]) => [canonical(run, localId), status]),
    ),
  });
}

const start = (run: Run) => ark("run", "step", run.runId, "build", "start");

/** Asserts a refused start: exit 1, the text, none of the other refusal's text, and no event written. */
function expectStartRefused(run: Run, mention: string, absent: string): void {
  const before = eventCount(run);
  const refused = start(run);
  expect(refused.code, refused.out).toBe(1);
  expect(refused.err).toContain(mention);
  expect(refused.err).not.toContain(absent);
  expect(eventCount(run)).toBe(before);
}

function expectStarted(run: Run): void {
  const started = start(run);
  expect(started.code, started.err).toBe(0);
  expect(eventsOf(run).filter((event) => event.type === "step.started")).toHaveLength(1);
}

const threeTests = (guard: unknown): CriteriaRow[] => [
  { id: "AC1" },
  { id: "AC2", guard },
  { id: "AC3" },
];

test("ARK-T763 a non-guard AC that reads passing in the only red run, or fails in another run, leaves the bug run's implementer start refused with today's text", () => {
  const run = buildingRun("bug", threeTests(true));
  // The guard AC2 is not enough on its own: AC3 reads passing in the first run and AC1 in the second.
  completed(run, { AC1: "failing", AC2: "failing", AC3: "passing" });
  completed(run, { AC1: "passing", AC2: "passing", AC3: "failing" });
  expectStartRefused(run, redTestRefusal, allGuardsRefusal);
});

test("ARK-T763 a guard AC needs no status in the red run: passing, failing, not run and missing all let the start succeed", () => {
  for (const guardStatus of ["passing", "failing", "not run", undefined]) {
    const run = buildingRun("bug", threeTests(true));
    completed(run, {
      AC1: "failing",
      AC3: "failing",
      ...(guardStatus === undefined ? {} : { AC2: guardStatus }),
    });
    expectStarted(run);
  }
});

test("ARK-T763 a run whose test ACs are all guards is accepted at the gate and refused at the implementer start with the all-guards text, whatever the red run says", () => {
  const cases: [string, CriteriaRow[], Record<string, string>][] = [
    [
      "every AC a guard",
      [
        { id: "AC1", guard: true },
        { id: "AC2", guard: true },
      ],
      { AC1: "failing", AC2: "failing" },
    ],
    [
      "the only test AC a guard, the other inspection",
      [
        { id: "AC1", guard: true },
        { id: "AC2", method: "inspection" },
      ],
      { AC1: "failing", AC2: "manual pending" },
    ],
    [
      "a guard and a demonstration AC",
      [
        { id: "AC1", guard: true },
        { id: "AC2", method: "demonstration" },
      ],
      { AC1: "failing", AC2: "manual pending" },
    ],
  ];
  for (const [, rows, statuses] of cases) {
    const run = buildingRun("bug", rows);
    expectStartRefused(run, allGuardsRefusal, redTestRefusal);
    completed(run, statuses);
    expectStartRefused(run, allGuardsRefusal, redTestRefusal);
  }
});

test("ARK-T763 an old events.ndjson, with a criteria.updated and a text criteria.amended that carry no guard field, replays with no guard and keeps today's red proof", () => {
  const ticketId = `ARK-${900 + ++ticketCounter}`;
  const ticketFile = writeTicket(
    "demo",
    ticketId,
    [
      { id: "AC1", text: "one", method: "test", verified_by: ["ARK-T10"] },
      { id: "AC2", text: "two", method: "test", verified_by: ["ARK-T11"] },
    ],
    `Ticket ${ticketId}`,
    "bug",
  );
  const runId = ark("run", "start", ticketFile, "--project", "demo").out.trim();
  const runDirectory = join(process.env.ARK_HOME as string, "projects", "demo", "runs", runId);
  const run: Run = { runId, runDirectory, ticketId, ticketFile };
  // The shapes before ARK-617, appended by hand: no `guards` on criteria.updated, no `guard` on criteria.amended.
  appendEvent(runDirectory, "evaluation.recorded", { blockers: [], risks: [], surfaces: ["none"] });
  appendEvent(runDirectory, "criteria.updated", {
    criteria: stateOf(run).criteria.map(({ id }) => id),
  });
  appendEvent(runDirectory, "gate.answered", { gate: "criteria", answer: "accept", by: "human" });
  recordStrategy(runDirectory);
  appendEvent(runDirectory, "criteria.amended", {
    criterion: canonical(run, "AC2"),
    old: "two",
    new: "two, reworded",
    by: "human",
    reason: "wording",
  });
  approvePlan(run);

  const status = ark("status", runId);
  expect(status.code, status.err).toBe(0);
  expect(status.out).toContain("amended criteria:");
  expect(status.out).toContain(canonical(run, "AC2"));
  expect(stateOf(run).guards).toEqual([]);

  expectStartRefused(run, redTestRefusal, allGuardsRefusal);
  completed(run, { AC1: "failing", AC2: "passing" });
  expectStartRefused(run, redTestRefusal, allGuardsRefusal);
  completed(run, { AC1: "failing", AC2: "failing" });
  expectStarted(run);
});

// ---------------------------------------------------------------------------------------------
// ARK-T764: the criteria gate
// ---------------------------------------------------------------------------------------------

/** The `guard:` lines of a ticket: indexes of the lines, and the id of the criterion block each one sits in. */
function guardLines(ticket: string): { at: number; owner: string | undefined }[] {
  const lines = ticket.split("\n");
  const end = lines.indexOf("---", 1);
  let owner: string | undefined;
  const found: { at: number; owner: string | undefined }[] = [];
  lines.slice(0, end).forEach((line, at) => {
    const id = line.match(/^\s*-\s*id:\s*["']?([^"'\s]+)["']?\s*$/)?.[1];
    if (id !== undefined) owner = id;
    if (/^\s*guard:/.test(line)) found.push({ at, owner });
  });
  return found;
}

/** The guard flag of each criterion in `ticket`, by local id (the parser canonicalises ids to `<ticket>/AC<k>`). */
const parsedGuards = (ticket: string) =>
  parseCriteria(frontmatter(ticket).fields ?? {}, "ticket.md").map(({ id, guard }) => [
    id.replace(/^.*\//, ""),
    guard,
  ]);

const ticketWith = (run: Run, kind: string | undefined, block: string[]) =>
  [
    "---",
    `id: ${run.ticketId}`,
    `title: "Ticket ${run.ticketId}"`,
    "status: ready",
    ...(kind === undefined ? [] : [`kind: ${kind}`]),
    ...block,
    "---",
    "## Why",
    "",
    "Test ticket.",
    "",
  ].join("\n");

/** The criteria of a hand-edited ticket for the no-flag accept path: AC2 gets `extra` lines. */
const handEditedBlock = (ac2Lines: string[], ac3Lines = ["    method: inspection"]) => [
  "acceptance_criteria:",
  "  - id: AC1",
  '    text: "first"',
  "    method: test",
  "    verified_by: [ARK-T10]",
  "  - id: AC2",
  '    text: "second"',
  ...ac2Lines,
  "  - id: AC3",
  '    text: "third"',
  ...ac3Lines,
];

const goodRows: CriteriaRow[] = [
  { id: "AC1", verified_by: ["ARK-T10"] },
  { id: "AC2", guard: true, verified_by: ["ARK-T11"] },
  { id: "AC3", method: "inspection" },
];

test("ARK-T764 the criteria gate writes guard: true into ticket_file, ticket.md and the criteria.updated event, on the AC that carries it only", () => {
  const run = startRun("bug");
  const accepted = acceptCriteriaFile(run.runId, run.runDirectory, goodRows);
  expect(accepted.code, accepted.err).toBe(0);

  const ticketFileText = readFileSync(run.ticketFile, "utf8");
  expect(read(run, "ticket.md")).toBe(ticketFileText);
  expect(guardLines(ticketFileText).map(({ owner }) => owner)).toEqual(["AC2"]);
  expect(parsedGuards(ticketFileText)).toEqual([
    ["AC1", false],
    ["AC2", true],
    ["AC3", false],
  ]);
  const updated = eventsOf(run).findLast((event) => event.type === "criteria.updated");
  expect(updated?.data).toEqual({
    criteria: ["AC1", "AC2", "AC3"].map((id) => canonical(run, id)),
    guards: [canonical(run, "AC2")],
  });
  expect(stateOf(run).phase).toBe("planning");
  expect(stateOf(run).guards).toEqual([canonical(run, "AC2")]);
});

test("ARK-T764 guard: false is a criterion with no guard, and a file without the key writes no guards field", () => {
  const withFalse = startRun("bug");
  expect(
    acceptCriteriaFile(withFalse.runId, withFalse.runDirectory, [
      { id: "AC1" },
      { id: "AC2", guard: false },
    ]).code,
  ).toBe(0);
  const updated = eventsOf(withFalse).findLast((event) => event.type === "criteria.updated");
  expect(updated?.data).not.toHaveProperty("guards");
  expect(parsedGuards(read(withFalse, "ticket.md")).map(([, guard]) => guard)).toEqual([
    false,
    false,
  ]);
  expect(stateOf(withFalse).guards).toEqual([]);

  // A file with no `guard` key at all writes the old `criteria.updated` shape.
  const withoutKey = startRun("bug");
  expect(
    acceptCriteriaFile(withoutKey.runId, withoutKey.runDirectory, [{ id: "AC1" }, { id: "AC2" }])
      .code,
  ).toBe(0);
  const plain = eventsOf(withoutKey).findLast((event) => event.type === "criteria.updated");
  expect(plain?.data).not.toHaveProperty("guards");
  expect(guardLines(read(withoutKey, "ticket.md"))).toEqual([]);
  expect(stateOf(withoutKey).guards).toEqual([]);
});

/** One refused accept: exit 1, one `ark: ` line that holds every `mentions`, and nothing written. */
function expectAcceptRefused(
  run: Run,
  accept: () => { code: number; out: string; err: string },
  mentions: string[],
): void {
  const ticketFileBefore = readFileSync(run.ticketFile, "utf8");
  const ticketBefore = read(run, "ticket.md");
  const eventsBefore = read(run, "events.ndjson");
  const refused = accept();
  expect(refused.code, refused.out).toBe(1);
  const lines = refused.err.trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toStartWith("ark: ");
  for (const mention of mentions) expect(lines[0]).toContain(mention);
  expect(readFileSync(run.ticketFile, "utf8")).toBe(ticketFileBefore);
  expect(read(run, "ticket.md")).toBe(ticketBefore);
  expect(read(run, "events.ndjson")).toBe(eventsBefore);
  expect(stateOf(run).phase).toBe("awaiting_criteria");
}

test("ARK-T764 --criteria refuses guard: true on a criterion whose method is not test, in a run that is not a bug run, and with a value that is not a boolean, and names the AC", () => {
  const cases: [string, string | undefined, CriteriaRow[], string[]][] = [
    [
      "an inspection AC",
      "bug",
      [...goodRows.slice(0, 2), { id: "AC3", method: "inspection", guard: true }],
      ["AC3", "guard", "inspection"],
    ],
    [
      "a demonstration AC",
      "bug",
      [...goodRows.slice(0, 2), { id: "AC3", method: "demonstration", guard: true }],
      ["AC3", "guard", "demonstration"],
    ],
    ["a refactor run", "refactor", goodRows, ["AC2", "guard", "refactor"]],
    ["a feature run", undefined, goodRows, ["AC2", "guard", "feature"]],
    [
      "the string false",
      "bug",
      [goodRows[0], { ...goodRows[1], guard: "false" }, goodRows[2]],
      ["AC2", "guard", "true or false"],
    ],
    [
      "the string yes",
      "bug",
      [goodRows[0], { ...goodRows[1], guard: "yes" }, goodRows[2]],
      ["AC2", "guard", "true or false"],
    ],
  ];
  for (const [, kind, rows, mentions] of cases) {
    const run = startRun(kind);
    expectAcceptRefused(run, () => acceptCriteriaFile(run.runId, run.runDirectory, rows), mentions);
  }
});

test("ARK-T764 accept with no --criteria reads guard: true from the hand-edited ticket into ticket.md and the event, and writes nothing to the ticket file", () => {
  const run = startRun("bug");
  const edited = ticketWith(
    run,
    "bug",
    handEditedBlock(["    method: test", "    guard: true", "    verified_by: [ARK-T11]"]),
  );
  writeFileSync(run.ticketFile, edited);

  const accepted = ark("gate", "record", run.runId, "criteria", "accept");
  expect(accepted.code, accepted.err).toBe(0);
  expect(readFileSync(run.ticketFile, "utf8")).toBe(edited);
  expect(guardLines(read(run, "ticket.md")).map(({ owner }) => owner)).toEqual(["AC2"]);
  expect(parsedGuards(read(run, "ticket.md"))).toEqual([
    ["AC1", false],
    ["AC2", true],
    ["AC3", false],
  ]);
  const updated = eventsOf(run).findLast((event) => event.type === "criteria.updated");
  expect(updated?.data.guards).toEqual([canonical(run, "AC2")]);
  expect(stateOf(run).phase).toBe("planning");
});

test("ARK-T764 accept with no --criteria refuses a hand-edited guard on an inspection or manual AC, a quoted false, and a feature run, and names the AC", () => {
  const guardedAc2 = ["    method: test", "    guard: true", "    verified_by: [ARK-T11]"];
  const cases: [string | undefined, string[], string[], string[]][] = [
    [
      "bug",
      guardedAc2,
      ["    method: inspection", "    guard: true"],
      ["AC3", "guard", "inspection"],
    ],
    [
      "bug",
      ["    manual: true", "    guard: true"],
      ["    method: inspection"],
      ["AC2", "guard", "demonstration"],
    ],
    [
      "bug",
      ["    method: test", '    guard: "false"', "    verified_by: [ARK-T11]"],
      ["    method: inspection"],
      ["AC2", "guard", "true or false"],
    ],
    [undefined, guardedAc2, ["    method: inspection"], ["AC2", "guard", "feature"]],
  ];
  for (const [kind, ac2Lines, ac3Lines, mentions] of cases) {
    const run = startRun(kind);
    writeFileSync(run.ticketFile, ticketWith(run, kind, handEditedBlock(ac2Lines, ac3Lines)));
    expectAcceptRefused(
      run,
      () => ark("gate", "record", run.runId, "criteria", "accept"),
      mentions,
    );
  }
});

// ---------------------------------------------------------------------------------------------
// ARK-T766: ark criteria amend --guard and --no-guard
// ---------------------------------------------------------------------------------------------

const amendRows = (guard: boolean): CriteriaRow[] => [
  { id: "AC1", verified_by: ["ARK-T1"] },
  { id: "AC2", verified_by: ["ARK-T2"], ...(guard ? { guard: true } : {}) },
  { id: "AC3", method: "inspection" },
  { id: "AC4", method: "demonstration" },
];

/** A bug run in building, as the ARK-T766 preconditions: AC1 failing, AC2 passing, AC3 and AC4 manual, AC4 answered ok. */
function amendRun(kind: string | undefined, guard: boolean): Run {
  const run = buildingRun(kind, amendRows(guard));
  completed(run, { AC1: "failing", AC2: "passing", AC3: "manual pending", AC4: "manual pending" });
  appendEvent(run.runDirectory, "gate.answered", {
    gate: "manual",
    criterion: canonical(run, "AC4"),
    answer: "ok",
    by: "human",
  });
  return run;
}

const amendGuard = (run: Run, flag: "--guard" | "--no-guard", criterion = "AC2", reason = "x") =>
  ark("criteria", "amend", run.runId, criterion, flag, "--reason", reason);

const manualAnswer = (run: Run, localId: string) =>
  (stateOf(run).gates as Record<string, string>)[`manual:${canonical(run, localId)}`];

/** `ticket` minus its one guard line, and where that line sat: in the block of `owner`. */
function withoutGuardLine(ticket: string, owner: string): string {
  const [only, ...rest] = guardLines(ticket);
  expect(rest).toHaveLength(0);
  expect(only.owner).toBe(owner);
  const lines = ticket.split("\n");
  lines.splice(only.at, 1);
  return lines.join("\n");
}

function expectAmendRefused(
  run: Run,
  amend: () => { code: number; err: string },
  mentions: string[],
): void {
  const ticket = read(run, "ticket.md");
  const log = read(run, "events.ndjson");
  const state = read(run, "state.json");
  const refused = amend();
  expect(refused.code).toBe(1);
  const lines = refused.err.trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toStartWith("ark: ");
  for (const mention of mentions) expect(lines[0]).toContain(mention);
  expect(read(run, "ticket.md")).toBe(ticket);
  expect(read(run, "events.ndjson")).toBe(log);
  expect(read(run, "state.json")).toBe(state);
}

test("ARK-T766 --guard after the criteria gate adds one guard line to that AC and records criteria.amended with guard true, and the red proof then skips the AC", () => {
  const run = amendRun("bug", false);
  expect(start(run).err).toContain(redTestRefusal);
  const before = read(run, "ticket.md");
  const amendmentsBefore = stateOf(run).amended_criteria;

  const amended = amendGuard(run, "--guard", "AC2", "holds at base");
  expect(amended.code, amended.err).toBe(0);
  expect(amended.out).toContain("AC2");

  expect(withoutGuardLine(read(run, "ticket.md"), "AC2")).toBe(before);
  expect(parsedGuards(read(run, "ticket.md"))).toEqual([
    ["AC1", false],
    ["AC2", true],
    ["AC3", false],
    ["AC4", false],
  ]);
  const event = eventsOf(run).findLast((entry) => entry.type === "criteria.amended");
  expect(event?.data).toMatchObject({
    criterion: canonical(run, "AC2"),
    guard: true,
    reason: "holds at base",
  });
  // A guard amend is no text amendment: none in the state, and the manual answer stands.
  expect(stateOf(run).amended_criteria).toEqual(amendmentsBefore);
  expect(manualAnswer(run, "AC4")).toBe("ok");
  expectStarted(run);
});

test("ARK-T766 --no-guard removes the guard line and records guard false, whether --guard or the criteria gate set it, and the red proof demands the AC again", () => {
  const amendedRun = amendRun("bug", false);
  const original = read(amendedRun, "ticket.md");
  expect(amendGuard(amendedRun, "--guard").code).toBe(0);
  const removed = amendGuard(amendedRun, "--no-guard", "AC2", "it shows the bug");
  expect(removed.code, removed.err).toBe(0);
  expect(read(amendedRun, "ticket.md")).toBe(original);
  expect(parsedGuards(read(amendedRun, "ticket.md")).map(([, guard]) => guard)).toEqual([
    false,
    false,
    false,
    false,
  ]);
  expect(
    eventsOf(amendedRun).findLast((entry) => entry.type === "criteria.amended")?.data,
  ).toMatchObject({
    criterion: canonical(amendedRun, "AC2"),
    guard: false,
  });
  expectStartRefused(amendedRun, redTestRefusal, allGuardsRefusal);

  // The line the criteria gate wrote goes too.
  const gateRun = amendRun("bug", true);
  const withGuard = read(gateRun, "ticket.md");
  expect(amendGuard(gateRun, "--no-guard", "AC2", "it shows the bug").code).toBe(0);
  expect(withoutGuardLine(withGuard, "AC2")).toBe(read(gateRun, "ticket.md"));
  expect(
    eventsOf(gateRun).findLast((entry) => entry.type === "criteria.amended")?.data,
  ).toMatchObject({
    criterion: canonical(gateRun, "AC2"),
    guard: false,
  });
  expectStartRefused(gateRun, redTestRefusal, allGuardsRefusal);
});

test("ARK-T766 --guard is refused on a non-test AC, an unknown AC, in a feature run and in merge_requests_open, and writes nothing", () => {
  const bugRun = amendRun("bug", false);
  expectAmendRefused(bugRun, () => amendGuard(bugRun, "--guard", "AC3"), [
    "AC3",
    "guard",
    "inspection",
  ]);
  expectAmendRefused(bugRun, () => amendGuard(bugRun, "--guard", "AC4"), [
    "AC4",
    "guard",
    "demonstration",
  ]);
  expectAmendRefused(bugRun, () => amendGuard(bugRun, "--guard", "AC9"), ["AC9", "AC1"]);

  const featureRun = amendRun("feature", false);
  expectAmendRefused(featureRun, () => amendGuard(featureRun, "--guard"), [
    "AC2",
    "guard",
    "feature",
  ]);

  const openRun = amendRun("bug", false);
  appendEvent(openRun.runDirectory, "merge_request.opened", { repo: ".", url: "u" });
  expectAmendRefused(openRun, () => amendGuard(openRun, "--guard"), ["merge_requests_open"]);
});

test("ARK-T766 --guard on a guard and --no-guard on a non-guard are refused by name and change nothing", () => {
  const plainRun = amendRun("bug", false);
  expectAmendRefused(plainRun, () => amendGuard(plainRun, "--no-guard"), ["AC2", "not a guard"]);

  const guardRun = amendRun("bug", true);
  expectAmendRefused(guardRun, () => amendGuard(guardRun, "--guard"), ["AC2", "already a guard"]);
  expect(guardLines(read(guardRun, "ticket.md")).map(({ owner }) => owner)).toEqual(["AC2"]);
  expect(parsedGuards(read(guardRun, "ticket.md")).find(([id]) => id === "AC2")?.[1]).toBe(true);
  expect(stateOf(guardRun).guards).toEqual([canonical(guardRun, "AC2")]);
});

const git = (directory: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", "-C", directory, ...args]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
};

test("ARK-T766 a text amend and a --verified-by amend of a guard AC keep the guard in the ticket and through replay, and the implementer still starts", () => {
  // The real plan check and worktree: the --verified-by form reads the case files at head.
  const run = startRun("bug");
  expect(acceptCriteriaFile(run.runId, run.runDirectory, amendRows(true)).code).toBe(0);
  const scenario = {
    level: "integration",
    given: [],
    when: ["do the thing"],
    // oxlint-disable-next-line unicorn/no-thenable -- plan test-case field `then: string[]`, not a Promise-like
    then: ["it works"],
    expected: "the system shall work",
  };
  const ids = deriveState(readEvents(run.runDirectory)).criteria.map(({ id }) => id);
  writeFileSync(
    join(run.runDirectory, "plan.yml"),
    JSON.stringify({
      design: { approach: "Do it.", interfaces: [{ name: "x", callers: ["y"] }], example: "ok" },
      summary: {
        why: "Because.",
        changes: ids.map((criterion) => ({ criterion, where: "x", now: "a", fix: "b" })),
      },
      steps: [
        {
          id: "tests",
          role: "validator",
          repo: ".",
          harness: "codex",
          model: "gpt-codex",
          needs: [],
          criteria: ids,
        },
        {
          id: "build",
          role: "implementer",
          repo: ".",
          harness: "claude",
          model: "claude-sonnet",
          needs: ["tests"],
          criteria: ids,
        },
      ],
      test_cases: [
        { id: "ARK-T1", action: "add", ...scenario },
        { id: "ARK-T2", action: "add", ...scenario },
      ],
    }),
  );
  for (const args of [
    ["plan", "check", run.runId],
    ["gate", "record", run.runId, "plan", "approve"],
    ["worktree", "create", run.runId, "."],
  ]) {
    const result = ark(...args);
    expect(result.code, `${args.join(" ")}: ${result.err}${result.out}`).toBe(0);
  }
  const worktree = join(run.runDirectory, "workspace");
  mkdirSync(join(worktree, "test", "cases"), { recursive: true });
  for (const id of ["ARK-T2", "ARK-T3"]) {
    writeFileSync(
      join(worktree, "test", "cases", `${id}.md`),
      [
        "---",
        `id: ${id}`,
        `title: ${id} case`,
        "level: integration",
        "technique: equivalence classes",
        "priority: high",
        "risk: wrong proof",
        "status: active",
        "changed_by: 2026-11-21-ARK-617-1",
        "---",
        "",
        "## Objective",
        "",
        "Prove it.",
        "",
      ].join("\n"),
    );
    git(worktree, "add", `test/cases/${id}.md`);
  }
  git(worktree, "commit", "-q", "-m", "cases ARK-T2 and ARK-T3");
  completed(run, { AC1: "failing", AC2: "passing", AC3: "manual pending", AC4: "manual pending" });

  const textFile = join(run.runDirectory, "new-text.txt");
  writeFileSync(textFile, "reworded two\n");
  const reworded = ark("criteria", "amend", run.runId, "AC2", textFile, "--reason", "x");
  expect(reworded.code, reworded.err).toBe(0);
  const renumbered = ark(
    "criteria",
    "amend",
    run.runId,
    "AC2",
    "--verified-by",
    "ARK-T2,ARK-T3",
    "--reason",
    "x",
  );
  expect(renumbered.code, renumbered.err).toBe(0);

  expect(read(run, "ticket.md")).toContain("reworded two");
  expect(read(run, "ticket.md")).toContain("verified_by: [ARK-T2, ARK-T3]");
  expect(guardLines(read(run, "ticket.md")).map(({ owner }) => owner)).toEqual(["AC2"]);
  expect(parsedGuards(read(run, "ticket.md")).find(([id]) => id === "AC2")?.[1]).toBe(true);
  const amendments = eventsOf(run).filter((event) => event.type === "criteria.amended");
  expect(amendments).toHaveLength(2);
  for (const amendment of amendments) expect(amendment.data).not.toHaveProperty("guard");
  expect(stateOf(run).guards).toEqual([canonical(run, "AC2")]);
  expectStarted(run);
});
