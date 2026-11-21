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
import { today, writeRun } from "./hub-fixtures.ts";
import {
  bigProject,
  controlProject,
  expectedRoadmap,
  filler,
  planSteps,
  runModels,
  runPhase,
  stepRows,
  stepStatusesOf,
  ticketModels,
  writeBigProject,
  type RunModel,
  type TicketModel,
} from "./hub-big-home.ts";
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

/** Master Chief's inbox: about 2 MB for the whole inbox (hub/snapshot.ts, `chiefUnread`). */
const inboxMessageCount = 800;
const inboxBodyBytes = 2_500;
/** `ps -E` and `lsof -d cwd` of this host: 532 rows of 1.3 KB, and 528 processes. */
const processRowCount = 532;
const orcaRunRowCount = 273;


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

test("ARK-T751 On a hub whose Ark home switches from a near-empty project to a project at or above the real home's size and shape, the added health lag of the large pass is at most 150 ms over the control, and the snapshot holds every run, gate, ticket, cost, role time, queue and unread count the fixture names", async () => {
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
