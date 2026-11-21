// ARK-613/AC1, ARK-T751: a hub that reads an Ark home of the real size and shape adds at most 150 ms to its loop lag over a
// control on the same hub, and the snapshot it publishes holds what the fixture names. A real `hub/main.ts` with the fake
// `orca`, `gh`, `omp`, `plannotator`, `ps` and `lsof` of `stage()` (test/hub-stall-support.ts).
//
// Waiting rule (test/wallclock.test.ts, ARK-T126): no timer and no sleep. Every wait is an event: a request loop (the
// requests are the wait), a read of the `/events` stream or a process exit.
import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunView, Snapshot } from "../hub/types.ts";
import { today, writeBacklogTicket, writeRun, type FixtureStep } from "./hub-fixtures.ts";
import {
  healthProber,
  installHooks,
  openPage,
  snapshotOf,
  stage,
  startHub,
} from "./hub-stall-support.ts";

setDefaultTimeout(120_000);
installHooks();

/** What the large pass may add to the largest lag of the control phase on the same hub (ARK-613/AC1, as ARK-606/AC1 for the orca pass). */
const homeLagAddedLimitMilliseconds = 150;

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
/** Master Chief's inbox: about 2 MB for the whole inbox (hub/snapshot.ts, `chiefUnread`). */
const inboxMessageCount = 800;
const inboxBodyBytes = 2_500;
/** `ps -E` and `lsof -d cwd` of this host: 532 rows of 1.3 KB, and 528 processes. */
const processRowCount = 532;
const orcaRunRowCount = 273;

const bigProject = "big";
const controlProject = "p";
/** Four digits, so that the ticket file names sort the same by text and by number at any ticket count. */
const firstTicketNumber = 1001;
const stepRows: { id: string; role: string; seconds: number }[] = [
  { id: "s1", role: "implementer", seconds: 600 },
  { id: "s2", role: "validator", seconds: 900 },
  { id: "s3", role: "reviewer", seconds: 300 },
];
/** The events a closed run holds besides its padding: run.started to run.closed with one merge request. */
const coreEventCount = 14;

const filler = (length: number, seed: string): string =>
  `${seed} lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor `
    .repeat(Math.ceil(length / 40) + 1)
    .slice(0, length)
    .trim();

// ---------------------------------------------------------------- the model of the large project (the fixture, nothing else)

type RunKind = "noEvents" | "closed" | "building" | "brokenPlan" | "planning" | "mergeRequestsOpen";
type RunModel = {
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
type TicketModel = {
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

function runModels(): RunModel[] {
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

function ticketModels(): TicketModel[] {
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
function expectedRoadmap(tickets: TicketModel[]) {
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

const planSteps = (kind: RunKind): FixtureStep[] =>
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
const stepStatusesOf = (kind: RunKind): string[] =>
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

const runPhase = (kind: RunKind) =>
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

function writeBigProject(directory: string, runs: RunModel[], tickets: TicketModel[]): void {
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

// ---------------------------------------------------------------- the fake answers, fixed for both phases

const chiefOrcaRun = {
  id: "orca-chief-big",
  objective: `Master Chief: ${bigProject} tickets`,
  coordinator_handle: "term-chief-big",
};

const taskRows = (status: string, count: number, firstNumber: number) =>
  Array.from({ length: count }, (_, number) => ({
    id: `task-${status}-${number}`,
    title: `ARK-${firstNumber - number} ${status} task ${number}`,
    status,
    spec: filler(300, "task"),
  }));
const readyTasks = taskRows("ready", 25, 612);
const pendingTasks = taskRows("pending", 25, 560);

const inboxMessages = Array.from({ length: inboxMessageCount }, (_, number) => ({
  id: `message-${number}`,
  from_handle: `term-${number % 9}`,
  to_handle: "term-chief-big",
  type: number % 5 === 0 ? "question" : "status",
  subject: `Message ${number}`,
  body: filler(inboxBodyBytes, `body${number}`),
  read: number % 7 === 0 ? 0 : 1,
  created_at: new Date(Date.UTC(2026, 10, 1) + number * 60_000).toISOString(),
}));
const unreadMessages = inboxMessages.filter((message) => message.read === 0);

const orcaRunRows = [
  ...Array.from({ length: orcaRunRowCount - 1 }, (_, number) => ({
    id: `orca-run-${number}`,
    objective: `Orca chore ${number}`,
    coordinator_handle: `term-${number}`,
    status: "completed",
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-02T00:00:00.000Z",
    notes: filler(120, "run"),
  })),
  chiefOrcaRun,
];

const environmentText = Array.from(
  { length: 24 },
  (_, number) => `VARIABLE_${number}=${filler(40, "v").replaceAll(" ", "_")}`,
).join(" ");
const processTable = Array.from(
  { length: processRowCount },
  (_, number) =>
    `${1000 + number} 1 ${1000 + number} ${20_000 + number} 0:0${number % 10}.12 0${number % 9}:10:20 /usr/bin/program-${number} --flag ${environmentText}`,
).join("\n");
const workingDirectoryTable = Array.from(
  { length: processRowCount - 4 },
  (_, number) => `p${1000 + number}\nn/Users/fixture/work-${number}`,
).join("\n");

// ---------------------------------------------------------------- the snapshot the fixture names

const projectionOfRun = (view: RunView) => ({
  run: view.run,
  project: view.project,
  ticket: view.ticket,
  phase: view.phase,
  plan: view.plan?.map(({ id, status }) => ({ id, status })) ?? null,
  progress: view.progress && {
    steps_done: view.progress.steps_done,
    steps_total: view.progress.steps_total,
  },
  merge_requests: view.merge_requests.map((request) => request.url),
});

type TicketRunProjection = {
  project: string;
  ticket: string;
  run: string;
  phase: string;
  waiting: boolean;
  chain: unknown;
  cost_usd: number | null | "not compared";
  all: { run: string; phase: string; outcome: string | null; cost_usd: number | null }[];
};

/** The Ark-pass surfaces of a snapshot: what `first` and `last` are compared on. */
function surfacesOf(snapshot: Snapshot) {
  if (
    snapshot.runs === "unknown" ||
    snapshot.gates === "unknown" ||
    snapshot.tickets === "unknown" ||
    snapshot.ticket_runs === "unknown" ||
    snapshot.roadmap === "unknown"
  )
    throw new Error("the snapshot holds no Ark surface yet");
  const roadmapOfBig = snapshot.roadmap[bigProject];
  if (!roadmapOfBig || !("milestones" in roadmapOfBig))
    throw new Error("the snapshot holds no roadmap of the large project");
  const ids = (items: { id: string }[]) => items.map((item) => item.id);
  return {
    runs: snapshot.runs.map(projectionOfRun),
    gates: snapshot.gates.map(({ run, project, ticket, kind, since }) => ({
      run,
      project,
      ticket,
      kind,
      since,
    })),
    tickets: snapshot.tickets.map(
      ({ project, id, title, status, kind, milestone, depends_on, why }) => ({
        project,
        id,
        title,
        status,
        kind,
        milestone,
        depends_on,
        why,
      }),
    ),
    ticket_runs: snapshot.ticket_runs.map((entry) => ({
      project: entry.project,
      ticket: entry.ticket,
      run: entry.run,
      phase: entry.phase,
      waiting: entry.waiting,
      chain: entry.chain,
      // The cost of an open run comes from session files, which the fixture has none of: the usage cases own it.
      cost_usd: entry.phase === "closed" ? entry.cost_usd : "not compared",
      all: entry.all,
    })),
    roadmap: {
      big: {
        vision: roadmapOfBig.vision,
        milestones: roadmapOfBig.milestones,
        now: ids(roadmapOfBig.now),
        next: ids(roadmapOfBig.next),
        later: ids(roadmapOfBig.later),
        unranked: ids(roadmapOfBig.unranked),
        review: ids(roadmapOfBig.review),
        shipped: roadmapOfBig.shipped.map((entry) => ({
          milestone: entry.milestone,
          tickets: ids(entry.tickets),
        })),
        warnings: roadmapOfBig.warnings.map((warning) => ({
          kind: warning.kind,
          ids: warning.ids,
        })),
      },
      [controlProject]: snapshot.roadmap[controlProject],
    },
    role_times: snapshot.role_times,
  };
}

/** The same surfaces, written from the fixture: the model of the runs and tickets above and the files written from it. */
function expectedSurfaces(
  runs: RunModel[],
  tickets: TicketModel[],
  controlRun: { name: string; ticketId: string; ticketTitle: string },
) {
  const withEvents = runs.filter((run) => run.kind !== "noEvents");
  const newestFirst = (left: { name: string }, right: { name: string }) =>
    left.name < right.name ? 1 : -1;
  const openRuns = withEvents.filter((run) => run.kind !== "closed").sort(newestFirst);
  const planOf = (run: RunModel) =>
    run.kind === "brokenPlan"
      ? null
      : stepRows.map((row, position) => ({
          id: row.id,
          status: stepStatusesOf(run.kind)[position]!,
        }));
  const controlSteps = [
    { id: "s1", status: "succeeded" },
    { id: "s2", status: "running" },
    { id: "s3", status: "pending" },
  ];
  const planningRun = openRuns.find((run) => run.kind === "planning");
  // ticket_runs: runs newest first, the first run of a ticket is its newest.
  const everyRun = [
    {
      name: controlRun.name,
      project: controlProject,
      ticketId: controlRun.ticketId,
      phase: "building",
      outcome: null as string | null,
      cost: null as number | null,
    },
    ...withEvents
      .map((run) => ({
        name: run.name,
        project: bigProject,
        ticketId: run.ticketId,
        phase: runPhase(run.kind),
        outcome: run.outcome,
        cost: run.cost,
      }))
      .sort(newestFirst),
  ];
  const entries = new Map<string, TicketRunProjection>();
  for (const run of everyRun) {
    const key = `${run.project}/${run.ticketId}`;
    const all = {
      run: run.name,
      phase: run.phase,
      outcome: run.phase === "closed" ? run.outcome : null,
      cost_usd: run.phase === "closed" ? run.cost : null,
    };
    const known = entries.get(key);
    if (known) {
      known.all.push(all);
      continue;
    }
    entries.set(key, {
      project: run.project,
      ticket: run.ticketId,
      run: run.name,
      phase: run.phase,
      waiting: false,
      chain: null,
      cost_usd: run.phase === "closed" ? run.cost : "not compared",
      all: [all],
    });
  }
  const closedRuns = withEvents.filter((run) => run.kind === "closed");
  const timesOf = (seconds: number) => ({
    median: seconds,
    p90: seconds,
    count: closedRuns.length,
  });
  return {
    runs: [
      {
        run: controlRun.name,
        project: controlProject,
        ticket: { id: controlRun.ticketId, title: controlRun.ticketTitle },
        phase: "building",
        plan: controlSteps,
        progress: { steps_done: 1, steps_total: 3 },
        merge_requests: [],
      },
      ...openRuns.map((run) => ({
        run: run.name,
        project: bigProject,
        ticket: { id: run.ticketId, title: run.ticketTitle },
        phase: runPhase(run.kind),
        plan: planOf(run),
        progress:
          planOf(run) === null
            ? null
            : {
                steps_done: stepStatusesOf(run.kind).filter((status) => status === "succeeded")
                  .length,
                steps_total: stepRows.length,
              },
        merge_requests:
          run.kind === "mergeRequestsOpen" ? [`https://example.test/${run.name}/pull/1`] : [],
      })),
    ],
    gates: planningRun
      ? [
          {
            run: planningRun.name,
            project: bigProject,
            ticket: planningRun.ticketId,
            kind: "plan",
            since: new Date(planningRun.startedAt.getTime() + 20_000).toISOString(),
          },
        ]
      : [],
    tickets: tickets.map((ticket) => ({
      project: bigProject,
      id: ticket.id,
      title: ticket.title,
      status: ticket.status,
      kind: ticket.kind,
      milestone: ticket.milestone,
      depends_on: ticket.dependsOn,
      why: ticket.why,
    })),
    ticket_runs: [...entries.values()],
    roadmap: { big: expectedRoadmap(tickets), [controlProject]: { none: "local" } },
    role_times: Object.fromEntries(stepRows.map((row) => [row.role, timesOf(row.seconds)])),
  };
}

// ---------------------------------------------------------------- ARK-T751

test("ARK-T751 On a hub whose Ark home switches from a near-empty project to a project of the real home's size and shape (270 run folders with real events, plans and metrics, 505 tickets), the largest health lag of the large pass and of the compose and publish after it is at most 150 ms over the largest lag of a control phase on the same hub, and the snapshot holds every run, gate, ticket, cost, role time, queue and unread count the fixture names", async () => {
  const fake = stage();
  const runs = runModels();
  const tickets = ticketModels();
  const openBigRuns = runs.filter((run) => run.kind !== "noEvents" && run.kind !== "closed");
  const closedBigRuns = runs.filter((run) => run.kind === "closed");

  // Step 1: the fake answers (fixed for both phases), the control home, the large project in staging, the hub and its page.
  fake.set("ps.table", `${processTable}\n`);
  fake.set("lsof.table", `${workingDirectoryTable}\n`);
  fake.set("orca.runs", JSON.stringify({ result: { runs: orcaRunRows } }));
  fake.set("orca.tasks", JSON.stringify({ result: { tasks: readyTasks } }));
  fake.set("orca.tasks.pending", JSON.stringify({ result: { tasks: pendingTasks } }));
  fake.set("orca.chief-inbox", JSON.stringify({ result: { messages: inboxMessages } }));
  const controlRun = {
    name: `${today()}-ARK-9001-1`,
    ticketId: "ARK-9001",
    ticketTitle: "Control run",
  };
  mkdirSync(join(fake.home, "projects", controlProject), { recursive: true });
  writeFileSync(join(fake.home, "projects", controlProject, "ark.yml"), "ticket_source: local\n");
  writeRun({
    project: controlProject,
    run: controlRun.name,
    ticket: { id: controlRun.ticketId, title: controlRun.ticketTitle },
    phase: "building",
    steps: planSteps("building"),
  });
  const staging = join(fake.home, "staging", bigProject);
  writeBigProject(staging, runs, tickets);
  const hub = await startHub({ interval: 2000 });
  const page = openPage(hub);
  const prober = healthProber(hub, {
    caseId: "ARK-T751",
    sources: ["ark", "usage", "evidence", "queue", "chiefUnread", "resources"],
  });

  // Steps 2 and 3: two passes of each source that reads the home; their largest lag is what the control home and the host cost.
  await prober.untilPasses(2);
  const controlLag = prober.largestLag();
  const largeFrom = prober.probeCount();
  const control = await snapshotOf(hub);
  expect(
    control.runs === "unknown" ? [] : control.runs.map((run) => run.project),
    "the control snapshot holds no run of the large project",
  ).toEqual([controlProject]);
  expect(control.tickets, "the control snapshot holds no ticket").toEqual([]);

  // Step 4: one rename puts the whole project in place. No watcher sees $ARK_HOME/projects, so the next ark tick reads it cold, in one pass.
  const switchedAt = Date.now();
  renameSync(staging, join(fake.home, "projects", bigProject));
  let first: Snapshot | undefined;
  while (!first) {
    await prober.probe();
    const latest = page.latest();
    if (
      latest &&
      Array.isArray(latest.runs) &&
      latest.runs.some((run) => run.project === bigProject)
    )
      first = latest;
  }
  await prober.untilPasses(2);
  await prober.probe(); // the sample of the publish that follows the last pass end

  // Steps 5 and 6: the snapshot and the files hold what the fixture names, before the lag is judged.
  const last = await snapshotOf(hub);
  const expected = expectedSurfaces(runs, tickets, controlRun);
  expect<unknown>(surfacesOf(first), "first push of the large pass").toEqual(expected);
  expect<unknown>(surfacesOf(last), "last snapshot").toEqual(expected);
  // ark.yml of the fixture carries no full config, so `concurrency` is not compared.
  expect(last.queues).toMatchObject([
    {
      project: bigProject,
      open: openBigRuns.length,
      tasks: [
        ...readyTasks.map(({ id, title }) => ({
          id,
          title,
          status: "ready",
          ticket: title.split(" ")[0],
        })),
        ...pendingTasks.map(({ id, title }) => ({
          id,
          title,
          status: "pending",
          ticket: title.split(" ")[0],
        })),
      ],
    },
    {
      project: controlProject,
      open: 1,
      unavailable: expect.stringContaining(`Master Chief: ${controlProject} tickets`),
    },
  ]);
  expect(last.chief_unread).toEqual([
    {
      project: bigProject,
      count: unreadMessages.length,
      oldest: new Date(
        Math.min(...unreadMessages.map((message) => Date.parse(message.created_at))),
      ).toISOString(),
    },
    { project: controlProject, none: true },
  ]);
  // The queue source reads not ok while any project's queue is unavailable, and `p` has no Master Chief run, at base and at head.
  expect(last.sources.ark.ok, "sources.ark.ok").toBe(true);
  expect(last.sources.chiefUnread.ok, "sources.chiefUnread.ok").toBe(true);
  expect(last.sources.resources.ok, "sources.resources.ok").toBe(true);
  expect(last.sources.queue.ok, "sources.queue.ok (p has no Master Chief run)").toBe(false);
  for (const run of openBigRuns) {
    const file = join(
      fake.home,
      "projects",
      bigProject,
      "runs",
      run.name,
      "results",
      "resources.json",
    );
    expect(existsSync(file), `resources.json of ${run.name}`).toBe(true);
    const sampledUntil = Date.parse(String(JSON.parse(readFileSync(file, "utf8")).sampled_until));
    expect(sampledUntil >= switchedAt, `sampled_until of ${run.name}`).toBe(true);
  }
  for (const run of [...closedBigRuns, ...runs.filter((model) => model.kind === "noEvents")])
    expect(
      existsSync(join(fake.home, "projects", bigProject, "runs", run.name, "results")),
      `no results folder of ${run.name}`,
    ).toBe(false);

  // Step 7: the large pass adds at most the limit to the control's lag (the health lag reads the last 60 s).
  const largeLag = prober.largestLag(largeFrom);
  expect(
    largeLag <= controlLag + homeLagAddedLimitMilliseconds,
    `controlLag ${controlLag} ms, largeLag ${largeLag} ms, added ${largeLag - controlLag} ms, limit ${homeLagAddedLimitMilliseconds} ms: ${prober.message()}`,
  ).toBe(true);

  // Step 8.
  hub.child.kill("SIGTERM");
  await hub.exited;
}, 120_000);
