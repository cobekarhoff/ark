// A project of the size and shape of the real Ark home, written in the real file layout (ARK-613, ARK-T751). Shared by
// test/hub-home-lag.test.ts and test/hub.test.ts (ARK-620): the hub's first Ark read of it lasts well over 250 ms, the bound of
// `readyOrLoading` (hub/server.ts), so the run route answers 503 `loading` at first. A fixture only: nothing under hub/ knows it.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBacklogTicket, writeRun, type FixtureStep } from "./hub-fixtures.ts";

// ---------------------------------------------------------------- the size of the large home
// The floor is this host's real home on 2026-11-20 (~/.ark/projects/ark, read only): 270 run folders (2 with no events.ndjson,
// 264 closed, 4 open), 4.6 MB of events (10,135 lines, the largest run 305 KB), 266 plan.yml of 2.3 MB (the largest 115 KB), 258
// metrics.json of 4.7 KB, 505 tickets of 5 KB. A constant is never below its floor.
// Scaled (6 times the floor): `homeRunCount`, `openRunCount` and `ticketCount`. At the floor one pass adds about 20 ms of lag to the
// control, at 4 times the floor 136 to 209 ms, at 6 times 260 to 630 ms (results/ARK-T751-scale.md of the run folder). The run count
// is the lever that moved the lag; 4 times the bytes of events and plans alone moved it by about 50 ms, so those stay at the floor.
// The profile of ARK-613 names the cause: one `fs.watch()` costs 5 to 8 ms of main-thread time and the reader made one per run
// folder; hub/watch-worker.ts owns them now. The test failed at base in 3 of 3 separate processes.
const homeRunCount = 1620;
const eventsPerRun = 38;
const planBytes = 8_100;
const ticketCount = 3030;
const openRunCount = 24;
const largestPlanBytes = 115_000;
const largestEventsBytes = 305_000;
const ticketBytes = 5_000;
const metricsBytes = 4_700;
const eventNoteBytes = 380;
export const bigProject = "big";
export const controlProject = "p";
/** Four digits, so that the ticket file names sort the same by text and by number at any ticket count. */
const firstTicketNumber = 1001;
export const stepRows: { id: string; role: string; seconds: number }[] = [
  { id: "s1", role: "implementer", seconds: 600 },
  { id: "s2", role: "validator", seconds: 900 },
  { id: "s3", role: "reviewer", seconds: 300 },
];
/** The events a closed run holds besides its padding: run.started to run.closed with one merge request. */
const coreEventCount = 14;

export const filler = (length: number, seed: string): string =>
  `${seed} lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor `
    .repeat(Math.ceil(length / 40) + 1)
    .slice(0, length)
    .trim();

// ---------------------------------------------------------------- the model of the large project (the fixture, nothing else)

type RunKind = "noEvents" | "closed" | "building" | "brokenPlan" | "planning" | "mergeRequestsOpen";
export type RunModel = {
  index: number;
  name: string;
  project: string;
  ticketId: string;
  ticketTitle: string;
  kind: RunKind;
  startedAt: Date;
  outcome: "merged" | "aborted" | "handed_off" | null;
  /** The total of the run's metrics.json; null for an open run or a closed run with none. */
  cost: number | null;
  paddingEvents: number;
  planSize: number;
};
export type TicketModel = {
  id: string;
  number: number;
  title: string | null;
  status: string;
  kind: string | null;
  milestone: string | null;
  dependsOn: string[];
  why: string | null;
  broken: boolean;
};

const noEventsIndexes = new Set([57, 133]);
const noMetricsIndexes = new Set([11, 61, 111, 161, 211, 241]);
const largestEventsIndex = 150;
const largestPlanIndex = 151;
const brokenTicketNumber = 1333;
const openIndexes = Array.from({ length: openRunCount }, (_, k) => homeRunCount - 1 - k * 23);
const openKinds: RunKind[] = ["building", "brokenPlan", "planning", "mergeRequestsOpen"];
const dayMilliseconds = 86_400_000;

export function runModels(): RunModel[] {
  let ticketNumber = firstTicketNumber - 1;
  return Array.from({ length: homeRunCount }, (_, index) => {
    // About 20 tickets have a second run: every 13th run from the 7th continues the ticket of the run before it.
    const second = index % 13 === 6 && index <= 253;
    if (!second) ticketNumber += 1;
    const startedAt = new Date(Date.UTC(2015, 0, 1) + index * dayMilliseconds);
    const ticketId = `ARK-${ticketNumber}`;
    const openPosition = openIndexes.indexOf(index);
    const kind: RunKind = noEventsIndexes.has(index)
      ? "noEvents"
      : openPosition >= 0
        ? (openKinds[openPosition] ?? "building")
        : "closed";
    const outcome =
      kind !== "closed"
        ? null
        : index % 11 === 3
          ? "aborted"
          : index % 17 === 5
            ? "handed_off"
            : "merged";
    return {
      index,
      name: `${startedAt.toISOString().slice(0, 10)}-${ticketId}-${second ? 2 : 1}`,
      project: bigProject,
      ticketId,
      ticketTitle: `Ticket ${ticketNumber} of the large home`,
      kind,
      startedAt,
      outcome,
      cost: kind === "closed" && !noMetricsIndexes.has(index) ? (1000 + index * 7) / 100 : null,
      paddingEvents:
        index === largestEventsIndex
          ? Math.ceil(largestEventsBytes / (eventNoteBytes + 80))
          : Math.max(0, eventsPerRun - coreEventCount),
      planSize: index === largestPlanIndex ? largestPlanBytes : planBytes,
    };
  });
}

const ticketStatuses = ["done", "ready", "in_progress", "proposed", "superseded"];
const ticketKinds = ["feature", "bug", "perf"];
const isFinished = (status: string) => status === "done" || status === "superseded";

export function ticketModels(): TicketModel[] {
  return Array.from({ length: ticketCount }, (_, offset) => {
    const number = firstTicketNumber + offset;
    const broken = number === brokenTicketNumber;
    return broken
      ? {
          id: `ARK-${number}`,
          number,
          title: null,
          status: "unreadable",
          kind: null,
          milestone: null,
          dependsOn: [],
          why: null,
          broken,
        }
      : {
          id: `ARK-${number}`,
          number,
          title: `Ticket ${number} of the large home`,
          status: ticketStatuses[number % 5]!,
          kind: ticketKinds[number % 3]!,
          milestone: `M${(number % 4) + 1}`,
          dependsOn: number % 7 === 0 ? [`ARK-${number - 1}`] : [],
          why: `Problem of ticket ${number}.`,
          broken,
        };
  });
}

const milestoneRows = [
  { id: "M1", name: "Core", outcome: "The core loop runs.", state: "done" },
  { id: "M2", name: "Hub", outcome: "The hub shows live runs.", state: "active" },
  { id: "M3", name: "Reliable", outcome: "A run needs no repair.", state: "active" },
  { id: "M4", name: "Standing", outcome: "Scheduled jobs write tickets.", state: "later" },
];
const visionText = `Ark takes a ticket to merge-ready changes. ${filler(1500, "vision")}`;
const doneListedTicket = "ARK-1005";
const missingListedTicket = "ARK-9999";

/** The ids that ROADMAP.md lists under Now, Next and Later: the open, ranked tickets of the fixture, 12 each. */
function listedIds(tickets: TicketModel[]) {
  const eligible = tickets
    .filter(
      (ticket) =>
        !ticket.broken &&
        (ticket.status === "ready" || ticket.status === "in_progress") &&
        ticket.number % 7 !== 0,
    )
    .map((ticket) => ticket.id);
  return {
    now: eligible.slice(0, 12),
    next: eligible.slice(12, 24),
    later: eligible.slice(24, 36),
    laterFile: [...eligible.slice(24, 36), doneListedTicket, missingListedTicket],
  };
}

const roadmapText = (tickets: TicketModel[]): string => {
  const listed = listedIds(tickets);
  const list = (ids: string[]) => ids.map((id) => `- ${id}`).join("\n");
  return [
    "## Vision",
    "",
    visionText,
    "",
    "## Milestones",
    "",
    "| id | name | outcome | state |",
    "| --- | --- | --- | --- |",
    ...milestoneRows.map((row) => `| ${row.id} | ${row.name} | ${row.outcome} | ${row.state} |`),
    "",
    "## Now",
    "",
    list(listed.now),
    "",
    "## Next",
    "",
    list(listed.next),
    "",
    "## Later",
    "",
    list(listed.laterFile),
    "",
  ].join("\n");
};

/** What the roadmap of `big` must show, from the fixture's tickets and ROADMAP.md alone. */
export function expectedRoadmap(tickets: TicketModel[]) {
  const listed = listedIds(tickets);
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const positioned = [...listed.now, ...listed.next, ...listed.laterFile];
  // A ticket whose front matter does not read has no real status: the roadmap holds it as proposed.
  const roadmapStatus = (ticket: TicketModel) => (ticket.broken ? "proposed" : ticket.status);
  const unranked = tickets.filter(
    (ticket) =>
      !isFinished(roadmapStatus(ticket)) &&
      roadmapStatus(ticket) !== "proposed" &&
      !positioned.includes(ticket.id),
  );
  const finishedOf = (milestone: string) =>
    tickets.filter((ticket) => ticket.milestone === milestone && isFinished(ticket.status));
  return {
    vision: visionText,
    milestones: milestoneRows.map((row) => {
      const own = tickets.filter((ticket) => ticket.milestone === row.id);
      return {
        ...row,
        done: own.filter((ticket) => ticket.status === "done").length,
        superseded: own.filter((ticket) => ticket.status === "superseded").length,
        open: own.filter((ticket) => !isFinished(ticket.status)).length,
      };
    }),
    now: listed.now,
    next: listed.next,
    later: listed.later,
    unranked: unranked.map((ticket) => ticket.id),
    review: tickets
      .filter((ticket) => roadmapStatus(ticket) === "proposed")
      .map((ticket) => ticket.id),
    shipped: milestoneRows
      .map((row) => ({ milestone: row.id, tickets: finishedOf(row.id).map((ticket) => ticket.id) }))
      .filter((entry) => entry.tickets.length > 0),
    warnings: [
      ...positioned.flatMap((id) => {
        const ticket = byId.get(id);
        if (!ticket) return [{ kind: "missing_ticket", ids: [id] }];
        return isFinished(ticket.status) ? [{ kind: "finished_listed", ids: [id] }] : [];
      }),
      ...unranked.map((ticket) => ({ kind: "unranked", ids: [ticket.id] })),
    ],
  };
}

// ---------------------------------------------------------------- writing the large project

export const planSteps = (kind: RunKind): FixtureStep[] =>
  stepRows.map((row, position) => {
    const started = [100, 800, 1800][position]!;
    const finished = started + row.seconds;
    const base = {
      id: row.id,
      role: row.role,
      harness: "omp",
      model: "anthropic/claude-sonnet-5-5",
      needs: position === 0 ? [] : [stepRows[position - 1]!.id],
    };
    if (kind === "planning") return base;
    if ((kind === "building" || kind === "brokenPlan") && position >= 1)
      return position === 1 ? { ...base, startedAfter: started } : base;
    return { ...base, startedAfter: started, finishedAfter: finished };
  });

/** The statuses `deriveState` gives the three steps, as the fixture's events say. */
export const stepStatusesOf = (kind: RunKind): string[] =>
  kind === "planning"
    ? ["pending", "pending", "pending"]
    : kind === "building" || kind === "brokenPlan"
      ? ["succeeded", "running", "pending"]
      : ["succeeded", "succeeded", "succeeded"];

/** A `plan.yml` in the real shape (steps, design, test cases), padded with test cases to `bytes`. */
function planYaml(ticketId: string, bytes: number): string {
  const lines = [
    "steps:",
    ...stepRows.flatMap((row, position) => [
      `  - id: ${row.id}`,
      `    role: ${row.role}`,
      "    repo: .",
      "    harness: omp",
      "    model: anthropic/claude-sonnet-5-5",
      `    needs: [${position === 0 ? "" : stepRows[position - 1]!.id}]`,
      `    criteria: [${ticketId}/AC1]`,
      `    goal: ${JSON.stringify(filler(300, row.id))}`,
    ]),
    "design:",
    `  approach: ${JSON.stringify(filler(400, "approach"))}`,
    "test_cases:",
  ];
  let size = lines.join("\n").length;
  for (let number = 1; size < bytes; number++) {
    const block = [
      `  - id: ${ticketId.replace("ARK-", "ARK-T")}${number}`,
      "    action: add",
      `    title: ${JSON.stringify(filler(120, `title${number}`))}`,
      "    level: integration",
      "    given:",
      `      - ${JSON.stringify(filler(90, "given"))}`,
      "    when:",
      `      - ${JSON.stringify(filler(90, "when"))}`,
      "    then:",
      `      - ${JSON.stringify(filler(90, "then"))}`,
      `    expected: ${JSON.stringify(filler(100, "expected"))}`,
    ];
    lines.push(...block);
    size += block.join("\n").length + 1;
  }
  return `${lines.join("\n")}\n`;
}

const brokenPlanText = "steps: [unclosed\n  - id: s1\n    bad: : :\n";

function metricsText(model: RunModel): string {
  const body = {
    run: model.name,
    actual_models: { s1: ["claude-sonnet-5-5"], s2: ["claude-sonnet-5-5"] },
    helper_models: {} as Record<string, unknown>,
    cost: {
      total_usd: model.cost,
      tokens: 1_000_000,
      by_step: Object.fromEntries(
        stepRows.map((row) => [row.id, { usd: 1, tokens: 1, includes_unknown: false }]),
      ),
    },
    rework: { rounds: 1 },
  };
  let size = JSON.stringify(body).length;
  for (let number = 0; size < metricsBytes; number++) {
    body.helper_models[`step${number}`] = [
      { model: "gpt-6-luna", purpose: "job-caption", usd: 0.0001, tokens: 100 },
    ];
    size += 110;
  }
  return JSON.stringify(body, null, 2);
}

export const runPhase = (kind: RunKind) =>
  kind === "closed"
    ? "closed"
    : kind === "planning"
      ? "planning"
      : kind === "mergeRequestsOpen"
        ? "merge_requests_open"
        : "building";

function writeBigRun(runsRoot: string, model: RunModel): void {
  if (model.kind === "noEvents") {
    mkdirSync(join(runsRoot, model.name), { recursive: true });
    writeFileSync(join(runsRoot, model.name, "ticket.md"), `# ${model.ticketTitle}\n`);
    return;
  }
  const hasMergeRequest = model.kind === "mergeRequestsOpen" || model.outcome === "merged";
  writeRun({
    project: model.project,
    run: model.name,
    runsRoot,
    ticket: { id: model.ticketId, title: model.ticketTitle },
    phase: runPhase(model.kind),
    steps: planSteps(model.kind),
    startedAt: model.startedAt,
    criteria: [`${model.ticketId}/AC1`],
    worktrees: [
      {
        repo: ".",
        path: join(runsRoot, model.name, "workspace"),
        branch: `ark/${model.ticketId}-fixture`,
        base: "0123456789abcdef0123456789abcdef01234567",
      },
    ],
    mergeRequests: hasMergeRequest
      ? [{ repo: ".", url: `https://example.test/${model.name}/pull/1`, number: model.index }]
      : undefined,
    outcome: model.outcome ?? undefined,
    statuses: model.kind === "closed" ? { [`${model.ticketId}/AC1`]: "passing" } : undefined,
    metricsText: model.cost === null ? undefined : metricsText(model),
    planText:
      model.kind === "brokenPlan" ? brokenPlanText : planYaml(model.ticketId, model.planSize),
    evaluationRisks: Array.from({ length: 6 }, (_, number) =>
      filler(600, `risk${number} of ${model.ticketId}`),
    ),
    extraEvents: Array.from({ length: model.paddingEvents }, (_, number) => ({
      after: 2200,
      type: number % 2 === 0 ? "worker.started" : "worktree.synced",
      data:
        number % 2 === 0
          ? { step: "s1", session: "unknown", note: filler(eventNoteBytes, "worker") }
          : { repo: ".", conflict: false, note: filler(eventNoteBytes, "sync") },
    })),
  });
}

export function writeBigProject(directory: string, runs: RunModel[], tickets: TicketModel[]): void {
  mkdirSync(join(directory, "runs"), { recursive: true });
  writeFileSync(join(directory, "ark.yml"), "ticket_source: local\n");
  writeFileSync(join(directory, "ROADMAP.md"), roadmapText(tickets));
  for (const run of runs) writeBigRun(join(directory, "runs"), run);
  for (const ticket of tickets) {
    if (ticket.broken) {
      mkdirSync(join(directory, "tickets"), { recursive: true });
      writeFileSync(
        join(directory, "tickets", `${ticket.id}.md`),
        `---\nid: ${ticket.id}\ntitle: "never closed\nstatus: ready\n---\n\n## Problem\n\nBroken.\n`,
      );
      continue;
    }
    writeBacklogTicket({
      project: bigProject,
      projectDirectory: directory,
      id: ticket.id,
      title: ticket.title!,
      status: ticket.status,
      kind: ticket.kind!,
      milestone: ticket.milestone!,
      dependsOn: ticket.dependsOn,
      problem: `${ticket.why} ${filler(ticketBytes / 2, "problem")}`,
      change: filler(ticketBytes / 2, "change"),
      criteria: [
        {
          id: "AC1",
          text: filler(200, "criterion"),
          method: "test",
          verifiedBy: [`ARK-T${ticket.number}`],
        },
      ],
    });
  }
}

let built: string | undefined;

/**
 * The large project for the hub's first read, written once per test file into a scratch folder and read only after that.
 * `removeBigProject` deletes it. It is the first 500 runs and 750 tickets of the model of ARK-T751, sized for a first read of 2 to 4
 * times the 250 ms bound of `readyOrLoading` on an idle host, so a loaded host stays far under the 10 s poll bound of ARK-T662.
 * Read times of the first answer through the hub (host load 21 to 25 on 10 cores, 3 runs each): 500 runs and 750 tickets 1.4 to
 * 1.7 s (about 0.6 s idle); 400 and 600 1.0 to 1.3 s; 300 and 450 0.7 to 0.8 s; 200 and 300 0.35 to 0.46 s; 100 and 200 no
 * hold at all (the first answer was not 503). The read grows faster than the size: 800 and 1,500 took 3.9 s there, and the full
 * 1,620 runs and 3,030 tickets 13 s at host load 19, which is why this is not the home of ARK-T751.
 */
function bigProjectDirectory(): string {
  if (!built) {
    built = mkdtempSync(join(tmpdir(), "ark-big-project-"));
    writeBigProject(built, runModels().slice(0, 500), ticketModels().slice(0, 750));
  }
  return built;
}

/**
 * Puts the large project into an Ark home as `projects/big`. The project folder is real, because the hub lists a project by
 * `Dirent.isDirectory()` (cli/paths.ts), which is false for a link; its entries link to the shared copy, so a test copies nothing.
 */
export function linkBigProject(arkHome: string): void {
  const target = join(arkHome, "projects", bigProject);
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(bigProjectDirectory()))
    symlinkSync(join(bigProjectDirectory(), name), join(target, name));
}

export function removeBigProject(): void {
  if (built) rmSync(built, { recursive: true, force: true });
  built = undefined;
}
