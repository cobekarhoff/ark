import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { now } from "../cli/clock.ts";
import { loadConfig } from "../cli/config.ts";
import { waitingGate, type ArkEvent } from "../cli/events.ts";
import { gateWaits, splitRunTime } from "../cli/time-split.ts";
import {
  createArkReader,
  createEvidenceReader,
  parseAgentTitle,
  readAgentWait,
  readGithub,
  readDirectory,
  readInbox,
  readOrca,
  readPlannotator,
  readProviderLimits,
  readQueues,
  signatureOf,
  type InboxRead,
  type RunWorkers,
  type QueueRead,
  type ArkRun,
  type ArkValue,
  type EvidenceValue,
  type MergeRequestFacts,
  unknownActivity,
  type OrcaValue,
  type PlannotatorSession,
  type PsAgent,
  readTicketDocument,
} from "./sources.ts";
import type {
  ConversationInput,
  ConversationQuery,
  ConversationReply,
  Directory,
  InboxMessage,
  RunEvents,
} from "./conversation.ts";
import type {
  Agent,
  ClosedBand,
  Gate,
  GateKind,
  MergeRequestView,
  ProviderWindow,
  RoleTimes,
  RunDetail,
  RunEvidence,
  RunProgress,
  RunView,
  Snapshot,
  ResourcesView,
  SourceName,
  StepStatus,
  TicketRunView,
  TranscriptPage,
  TranscriptResult,
} from "./types.ts";
import { stageTimes } from "../cli/events.ts";
import { roleTimesOf } from "./progress.ts";
import { readRunEvidence, readTicketCases } from "./evidence.ts";
import { escapedDefects } from "../cli/retro.ts";
import { isProved, listRunFiles, timelineOf } from "./run-detail.ts";
import { createResourcesReader } from "./resources.ts";
import { UsageIndex, readMetricsCost, readMetricsRounds, type RunCost } from "./usage.ts";

// ARK_HUB_INTERVAL_MS sets every source interval in ms (tests); ARK_PROVIDER_LIMITS_MS, when set, wins for providerLimits.
const allIntervalMilliseconds = Number(process.env.ARK_HUB_INTERVAL_MS) || 0;
export const intervalMilliseconds: Record<SourceName, number> = {
  ark: allIntervalMilliseconds || 2000, // also woken by fs watchers; Orca (0.3 to 0.5 s a call) is never the trigger
  orca: allIntervalMilliseconds || 3000,
  plannotator: allIntervalMilliseconds || 5000,
  github: allIntervalMilliseconds || 15_000,
  usage: allIntervalMilliseconds || 5000,
  providerLimits: Number(process.env.ARK_PROVIDER_LIMITS_MS) || allIntervalMilliseconds || 60_000,
  agentWait: allIntervalMilliseconds || 3000,
  evidence: allIntervalMilliseconds || 5000,
  queue: allIntervalMilliseconds || 3000, // its own source: a slow Orca queue never delays another source
  resources: allIntervalMilliseconds || 5000, // one ps and one lsof: about 0.2 s of CPU, so slower than Orca
};
/** The full inbox read (ARK-344): its own loop, never a snapshot source, so a failure never touches `orca` and no message reaches `/events`. */
const conversationIntervalMilliseconds = allIntervalMilliseconds || 15_000;

const usageTimeoutMilliseconds = 30_000;

/** Harness and model of `roles.<role>` in the project's `ark.yml`, or null when unset or unreadable. */
function roleConfig(
  project: string,
  role: "chief" | "evaluator" | "designer",
): { harness: string; model: string } | null {
  try {
    return loadConfig(project).roles[role] ?? null;
  } catch {
    return null;
  }
}

/** The `ark.yml` role an Orca agent role is configured under: the run lead and Master Chief use `chief`. */
const configRole = (role: string): "chief" | "evaluator" | "designer" =>
  role === "evaluator" || role === "designer" ? role : "chief";

/**
 * `since` is the start of the healthy period (shown as `read_at` while `ok`); `readAt` is the last
 * good read. A failing source shows `readAt`, so `Stale` keeps "as of N s ago". Neither moves on a
 * read that changes nothing, so an unchanged read is not a push.
 */
type Slot<T> = { ok: boolean; since: string | null; readAt: string | null; value: T | null };
const emptySlot = <T>(): Slot<T> => ({ ok: false, since: null, readAt: null, value: null });

const questions: Record<GateKind, (title: string) => string> = {
  criteria: (title) => `Approve the acceptance criteria for "${title}"?`,
  strategy: (title) => `Pick a strategy for "${title}"`,
  plan: (title) => `Approve the plan for "${title}"?`,
  escalation: (title) => `Escalation on "${title}": decide how to go on`,
};

/**
 * When the open gate of `kind` started; never the newest event of the run. One rule for every kind:
 * the open wait of `gateWaits` (cli/time-split.ts). An escalation with an `escalation.requested`
 * after its last answered escalation starts at that request (an earlier, answered escalation does
 * not count); without one, at the `test.completed` or `step.finished` that spent the round budget.
 */
export function gateSince(events: ArkEvent[], kind: GateKind): string {
  const openWait = gateWaits(events).findLast(
    (wait) => wait.gate === kind && wait.answered === null,
  );
  if (kind === "escalation") {
    const lastAnswer = events.findLastIndex(
      (event) => event.type === "gate.answered" && event.data.gate === "escalation",
    );
    const request = events.findLast(
      (event, index) => index > lastAnswer && event.type === "escalation.requested",
    );
    if (request) return request.time;
  }
  return openWait?.asked ?? events[0].time; // run.started: gateWaits always opens the wait that waitingGate names
}

export type SnapshotReader = ReturnType<typeof createSnapshotReader>;

/**
 * The one background reader. Each source runs on its own timer, publishes as soon as its read
 * returns, and keeps its last good value. Everything a request handler needs is `json()`, a string
 * built when a source published: handlers never read a file, spawn a tool or wait for one.
 */
export function createSnapshotReader() {
  const arkReader = createArkReader();
  const usage = new UsageIndex();
  const slots = {
    ark: emptySlot<ArkValue>(),
    orca: emptySlot<OrcaValue>(),
    plannotator: emptySlot<PlannotatorSession[]>(),
    github: emptySlot<true>(),
    usage: emptySlot<true>(),
    providerLimits: emptySlot<ProviderWindow[]>(),
    agentWait: emptySlot<Map<string, PsAgent[]>>(),
    evidence: emptySlot<EvidenceValue>(),
    queue: emptySlot<true>(),
    resources: emptySlot<ResourcesView>(),
  };
  const resourcesReader = createResourcesReader();
  const evidenceReader = createEvidenceReader();
  let githubFacts = new Map<string, MergeRequestFacts>();
  // The latest queue read of each project, failures included: the reason is data (AC4), so it lives beside the slot, not in it.
  let queueReads: Map<string, QueueRead> | null = null;
  const costs = new Map<string, { key: string; cost: RunCost }>();
  const listeners = new Set<(json: string) => void>();
  // The last good full inbox, outside `slots` and `compose()`: bodies never reach `json()`, `/api/snapshot` or `/events`.
  let conversation: {
    version: string;
    messages: Map<string, InboxMessage>;
    input: ConversationInput;
    truncated: boolean;
    stale: boolean;
    /** "loading" while the handles are not mapped yet (the early value); "ready" once the directory read published. */
    directory: "loading" | "ready";
  } | null = null;
  const closedWorkers = new Map<string, RunWorkers>();
  /** Settles at the first publish (early or full) of the running read, or when that read ends without one. */
  let conversationFirst: Promise<void> | undefined;
  const watchers = new Map<string, FSWatcher>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let stopped = false;
  let running = false; // at least one /events client: loops, Ark timer and watchers run
  let armed = false; // the loops are started (an Ark read that sees a gate may wake Plannotator)
  let generation = 0; // changes on every pause and resume: a read from an older one is dropped
  let publishPending = false;
  let lastBody = "";
  let lastJson = "";

  function costOf(run: ArkRun, closed: boolean): RunCost {
    const metrics = closed ? signatureOf(join(run.directory, "metrics.json")) : "";
    const key = `${usage.version}|${run.state.events}|${metrics}|${slots.usage.readAt === null}`;
    const known = costs.get(run.directory);
    if (known?.key === key) return known.cost;
    // Before the first full index build an open run's cost is unknown, not a partial sum.
    const cost =
      !closed && slots.usage.readAt === null
        ? { total: null, steps: {} }
        : usage.runCost(run.directory, closed, run.windows);
    costs.set(run.directory, { key, cost });
    return cost;
  }

  /**
   * The agents of an open run: Orca's lists joined to `orca worktree ps` by step (or `run lead`, or
   * role). An agent that only `ps` lists is added as running; one that only the other lists name has
   * an `unknown` activity. While `ps` has never answered, every activity is `unknown`.
   */
  function agentsOf(run: ArkRun): Agent[] | "unknown" {
    const orca = slots.orca.value;
    if (!orca) return "unknown";
    const unmatched = [...(slots.agentWait.value?.get(run.state.run) ?? [])];
    const agents = (orca.agents.get(run.state.run) ?? []).map((agent): Agent => {
      const index = unmatched.findIndex(
        (listed) => parseAgentTitle(listed.title).key === (agent.step ?? agent.role),
      );
      const [listed] = index >= 0 ? unmatched.splice(index, 1) : [];
      return { ...agent, activity: listed?.activity ?? unknownActivity };
    });
    for (const listed of unmatched) {
      const { role, step } = parseAgentTitle(listed.title);
      agents.push({
        role,
        harness: listed.harness,
        model: null,
        title: listed.title,
        step,
        planned: null,
        terminal: null,
        presence: "running",
        activity: listed.activity,
      });
    }
    // A model that Orca does not report comes from the last message of the agent's session file
    // (the parse the cost already holds), then from the plan or `roles.chief`, labelled.
    const sessionModels = usage.modelsOf(
      run.directory,
      run.windows,
      Date.parse(run.events[0].time),
      stageTimes(run.events),
    );
    return agents.map((agent) => {
      const owner =
        agent.step ??
        (agent.role === "run lead"
          ? "lead"
          : agent.role === "evaluator" || agent.role === "designer"
            ? agent.role
            : null);
      const model = agent.model ?? (owner === null ? null : (sessionModels.get(owner) ?? null));
      const step = run.plan?.find((candidate) => candidate.id === agent.step);
      if (model !== null) {
        const harness =
          agent.harness ??
          step?.harness ??
          (agent.step === null
            ? roleConfig(run.state.project, configRole(agent.role))?.harness
            : null) ??
          null;
        return { ...agent, harness, model, planned: null };
      }
      if (step)
        return {
          ...agent,
          planned: { harness: step.harness, model: step.model, source: "plan" as const },
        };
      // A run lead starts with the harness and model of `roles.chief` (chief playbook).
      const configured =
        agent.step === null ? roleConfig(run.state.project, configRole(agent.role)) : null;
      return configured
        ? { ...agent, planned: { ...configured, source: "configured" as const } }
        : agent;
    });
  }

  let roleTimesMemo: { ark: ArkValue; times: RoleTimes } | null = null;
  /** Median and p90 of step time by role, from the closed runs: recomputed when Ark's files were read again. */
  function roleTimes(): RoleTimes {
    const ark = slots.ark.value;
    if (!ark) return {};
    if (roleTimesMemo?.ark !== ark)
      roleTimesMemo = {
        ark,
        times: roleTimesOf(
          ark.runs.filter((run) => run.state.phase === "closed").map((run) => run.windows),
        ),
      };
    return roleTimesMemo.times;
  }

  function progressOf(run: ArkRun, startOf: (id: string) => string | null): RunProgress | null {
    if (!run.plan) return null;
    const status = (id: string) => run.state.steps.find((step) => step.id === id)?.status;
    const running = run.plan.findLast((step) => status(step.id) === "running");
    const startedAt = running ? startOf(running.id) : null;
    const typical = running ? roleTimes()[running.role] : undefined;
    return {
      steps_done: run.plan.filter((step) => status(step.id) === "succeeded").length,
      steps_total: run.plan.length,
      round: run.state.round,
      round_budget: run.state.round_budget,
      current:
        running && startedAt
          ? {
              step: running.id,
              role: running.role,
              started_at: startedAt,
              typical_seconds: typical?.median ?? null,
              slow_above_seconds: typical?.p90 ?? null,
            }
          : null,
    };
  }

  /** The ACs of a run in `merge_requests_open` with their `state.json` status and JUnit proof. */
  function evidenceOf(run: ArkRun): RunEvidence | null {
    const found =
      run.state.phase === "merge_requests_open" && slots.evidence.value?.get(run.state.run);
    return found
      ? {
          criteria: run.state.criteria.map((criterion) => ({
            id: criterion.id,
            status: criterion.status,
            proof: found.proof.get(criterion.id) ?? [],
          })),
          findings: found.findings,
        }
      : null;
  }

  /** The MR state of a closed run, from its outcome, never from gh. An unknown or null outcome stays unknown. */
  function closedMrState(outcome: string | null): MergeRequestView["state"] {
    return outcome === "merged"
      ? "merged"
      : outcome === "aborted" || outcome === "abandoned"
        ? "closed"
        : "unknown";
  }

  /** The summary of a closed run, read when its detail opens. Never throws: a damaged file is "not recorded". */
  function bandOf(run: ArkRun, closedAt: string | null): ClosedBand {
    const cost = readMetricsCost(run.directory)?.total ?? null;
    const rounds = readMetricsRounds(run.directory);
    let defects: ClosedBand["escaped_defects"] = [];
    try {
      defects = escapedDefects(run.state.project, run.state.run).map(({ ticket, note, fix }) => ({
        ticket,
        note,
        fix,
      }));
    } catch {
      // A malformed escaped-defects.yml shows no list.
    }
    const { criteria } = run.state;
    return {
      wall_seconds:
        closedAt === null ? null : (Date.parse(closedAt) - Date.parse(run.events[0].time)) / 1000,
      criteria: {
        passing: criteria.filter(({ status }) => isProved(status)).length,
        total: criteria.length,
      },
      cost_usd: cost ?? "not recorded",
      rework_rounds: rounds ?? "not recorded",
      escaped_defects: defects,
    };
  }

  /** One run as the page draws it. A closed run has no Orca agents and nothing it waits for. */
  function viewOf(run: ArkRun, closed: boolean): RunView {
    const { state, events } = run;
    const cost = costOf(run, closed);
    const statusOf = (id: string): StepStatus =>
      state.steps.find((step) => step.id === id)?.status ?? "pending";
    const startOf = (id: string): string | null => {
      const start = run.windows.findLast((window) => window.id === id)?.start;
      return start === undefined ? null : new Date(start).toISOString();
    };
    const waiting = closed ? [] : (slots.orca.value?.waits.get(state.run) ?? []);
    return {
      run: state.run,
      project: state.project,
      ticket: state.ticket,
      phase: state.phase,
      round: state.round,
      started_at: events[0].time,
      updated_at: events.at(-1)!.time,
      plan:
        run.plan?.map((step) => ({
          id: step.id,
          role: step.role,
          harness: step.harness,
          model: step.model,
          needs: step.needs,
          status: statusOf(step.id),
          cost_usd: cost.steps[step.id] ?? null,
          started_at: startOf(step.id),
          waiting: waiting.find((wait) => wait.step === step.id) ?? null,
        })) ?? null,
      // handed_off: the MR stays with a person, so the page shows no card.
      merge_requests: (closed && state.outcome === "handed_off" ? [] : state.merge_requests).map(
        (request) => {
          const facts = githubFacts.get(request.url);
          return {
            ...request,
            state: closed ? closedMrState(state.outcome) : (facts?.state ?? "unknown"),
            ci: facts?.ci ?? "unknown",
            checks: facts?.checks ?? [],
            additions: facts?.additions ?? null,
            deletions: facts?.deletions ?? null,
            changed_files: facts?.changed_files ?? null,
            created_at: facts?.created_at ?? null,
          };
        },
      ),
      agents: closed ? [] : agentsOf(run),
      waiting,
      progress: progressOf(run, startOf),
      evidence: evidenceOf(run),
      cost_usd: cost.total,
    };
  }

  function compose(): Omit<Snapshot, "generated_at"> {
    const sources = Object.fromEntries(
      Object.entries(slots).map(([name, slot]) => [
        name,
        { ok: slot.ok, read_at: slot.ok ? slot.since : slot.readAt },
      ]),
    ) as Snapshot["sources"];
    const ark = slots.ark.value;
    if (!ark)
      return {
        resources: slots.resources.value ?? "unknown",
        sources,
        runs: "unknown",
        gates: "unknown",
        tickets: "unknown",
        roadmap: "unknown",
        ticket_runs: "unknown",
        provider_limits: slots.providerLimits.value ?? "unknown",
        role_times: {},
        queues: "unknown",
      };

    const openRuns = ark.runs.filter((run) => run.state.phase !== "closed");
    const sessions = slots.plannotator.value ?? [];
    const gates: Gate[] = [];
    const runs = openRuns.map((run): RunView => {
      const { state, events, directory } = run;
      const kind = waitingGate(state);
      if (kind !== "none") {
        const document = join(
          directory,
          kind === "plan" ? "plan.md" : kind === "strategy" ? "strategies.md" : "ticket.md",
        );
        gates.push({
          id: `gate:${state.run}:${kind}`,
          run: state.run,
          project: state.project,
          ticket: state.ticket.id,
          kind,
          question: questions[kind](state.ticket.title),
          review_url: sessions.find((session) => session.target === document)?.url ?? null,
          since: gateSince(events, kind),
        });
      }
      return viewOf(run, false);
    });
    gates.sort((left, right) => left.since.localeCompare(right.since));

    const allEntry = (run: ArkRun): TicketRunView["all"][number] => {
      const closed = run.state.phase === "closed";
      return {
        run: run.state.run,
        phase: run.state.phase,
        outcome: closed ? run.state.outcome : null,
        cost_usd: closed ? costOf(run, true).total : null,
      };
    };
    // Runs are newest first, so the first run seen for a ticket is its newest.
    const newest = new Map<string, TicketRunView>();
    for (const run of ark.runs) {
      const key = `${run.state.project}/${run.state.ticket.id}`;
      const closed = run.state.phase === "closed";
      const known = newest.get(key);
      if (known) {
        known.all.push(allEntry(run));
        continue;
      }
      newest.set(key, {
        project: run.state.project,
        ticket: run.state.ticket.id,
        run: run.state.run,
        phase: run.state.phase,
        waiting: !closed && (slots.orca.value?.waits.get(run.state.run)?.length ?? 0) > 0,
        cost_usd: costOf(run, closed).total,
        all: [allEntry(run)],
      });
    }
    return {
      resources: slots.resources.value ?? "unknown",
      sources,
      runs,
      gates,
      tickets: ark.tickets,
      roadmap: ark.roadmap,
      ticket_runs: [...newest.values()],
      provider_limits: slots.providerLimits.value ?? "unknown",
      role_times: roleTimes(),
      queues:
        queueReads === null
          ? "unknown"
          : [...queueReads].map(([project, queueRead]) => ({
              project,
              open: openRuns.filter((run) => run.state.project === project).length,
              ...queueRead,
            })),
    };
  }

  function publish(): void {
    if (publishPending || stopped) return;
    publishPending = true;
    queueMicrotask(() => {
      publishPending = false;
      const body = compose();
      const text = JSON.stringify(body);
      if (text === lastBody) return;
      lastBody = text;
      lastJson = JSON.stringify({ generated_at: new Date().toISOString(), ...body });
      for (const listener of listeners) listener(lastJson);
    });
  }

  async function read<Name extends SourceName>(
    name: Name,
    reader: () => Promise<(typeof slots)[Name]["value"]> | (typeof slots)[Name]["value"],
  ): Promise<void> {
    const slot = slots[name] as Slot<unknown>;
    const started = generation;
    let value: unknown = null;
    try {
      value = await reader();
    } catch {
      // A failed read leaves the slot's value and shows its last good read time.
    }
    if (started !== generation) return;
    if (value === null) slot.ok = false;
    else {
      const time = new Date().toISOString();
      if (!slot.ok || slot.since === null) slot.since = time;
      slot.value = value;
      slot.readAt = time;
      slot.ok = true;
    }
    publish();
  }

  const openRunsOf = () =>
    (slots.ark.value?.runs ?? []).filter((run) => run.state.phase !== "closed");

  const gateOpen = () => openRunsOf().some((run) => waitingGate(run.state) !== "none");
  let gateWasOpen = false;

  const readers: Record<SourceName, () => Promise<void>> = {
    ark: async () => {
      await read("ark", () => arkReader.read());
      if (!running) return;
      syncWatchers();
      // A gate that this read saw wakes the Plannotator read at once, not at its next tick.
      const open = gateOpen();
      if (armed && open && !gateWasOpen) void readers.plannotator();
      gateWasOpen = open;
    },
    orca: () =>
      read("orca", () =>
        readOrca(openRunsOf().map(({ state }) => ({ run: state.run, project: state.project }))),
      ),
    // With no open gate nothing is reviewed: no call, and an empty list (not a failure) so review_url goes away.
    plannotator: () => read("plannotator", () => (gateOpen() ? readPlannotator() : [])),
    github: () =>
      read("github", async () => {
        const started = generation;
        const urls = openRunsOf().flatMap((run) => run.state.merge_requests.map((mr) => mr.url));
        const { facts, ok } = await readGithub(urls, githubFacts);
        // A read from a paused generation is discarded whole, shared facts included.
        if (started === generation) githubFacts = facts;
        return ok ? true : null;
      }),
    usage: () =>
      read("usage", async () => {
        if (!slots.ark.value) return null;
        const directories = openRunsOf().map((run) => run.directory);
        const { promise: timeout, resolve } = Promise.withResolvers<null>();
        const timer = setTimeout(resolve, usageTimeoutMilliseconds, null);
        // A hung refresh is a failed read: the slot keeps its last good value and shows its age.
        const done = await Promise.race([
          usage.refresh(directories).then(() => true as const),
          timeout,
        ]);
        clearTimeout(timer);
        return done;
      }),
    providerLimits: () => read("providerLimits", () => readProviderLimits()),
    agentWait: () => read("agentWait", () => readAgentWait()),
    // Only runs in `merge_requests_open` have evidence; an unchanged file is never parsed again.
    evidence: () =>
      read("evidence", () =>
        evidenceReader.read(
          openRunsOf()
            .filter((run) => run.state.phase === "merge_requests_open")
            .map((run) => ({
              run: run.state.run,
              directory: run.directory,
              reviewerSteps: (run.plan ?? [])
                .filter((step) => step.role === "reviewer")
                .map((step) => step.id),
            })),
        ),
      ),
    // The host and every process: one `ps` and one `lsof` for each sample. Needs the runs, so never before the first Ark read.
    resources: () =>
      read("resources", async () => {
        const ark = slots.ark.value;
        if (!ark) return null;
        return resourcesReader.read({
          runs: ark.runs.map((run) => ({
            run: run.state.run,
            directory: run.directory,
            closed: run.state.phase === "closed",
          })),
          agents: slots.orca.value?.agents ?? new Map(),
        });
      }),
    // Failed (stale chip) when any project's queue could not be read; the reason is in `queueReads`.
    queue: () =>
      read("queue", async () => {
        const started = generation;
        const reads = await readQueues();
        if (started === generation) queueReads = reads;
        return [...reads.values()].every((queueRead) => !("unavailable" in queueRead))
          ? true
          : null;
      }),
  };

  /** One full inbox read. A failure keeps the last good value and marks it stale; a read of an older generation is dropped. */
  async function readConversation(): Promise<void> {
    const started = generation;
    let inbox: InboxRead | null = null;
    let settleFirst: () => void = () => {};
    conversationFirst = new Promise<void>((resolve) => (settleFirst = resolve));
    const publish = (read: InboxRead, directory: Directory, state: "loading" | "ready") => {
      const version = new Date().toISOString();
      conversation = {
        version,
        messages: new Map(read.messages.map((message) => [message.id, message])),
        input: { version, messages: read.messages, directory },
        truncated: read.truncated,
        stale: false,
        directory: state,
      };
      settleFirst();
    };
    try {
      inbox = await readInbox();
      const reading = inbox
        ? readDirectory(
            (slots.ark.value?.runs ?? []).map((run) => ({
              run: run.state.run,
              closed: run.state.phase === "closed",
            })),
            inbox.messages,
            closedWorkers,
          )
        : null;
      // The first value waits two seconds for the handle directory, not the 35 s a cold read of every run's workers takes:
      // after that the messages show with unmapped handles until the directory read fills them in.
      if (inbox && reading && !conversation) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const early = await Promise.race([
          reading.catch(() => null),
          new Promise<"slow">((resolve) => (timer = setTimeout(() => resolve("slow"), 2000))),
        ]);
        clearTimeout(timer);
        if (early === "slow" && started === generation)
          publish(inbox, { chiefs: [], leads: [], workers: [] }, "loading");
      }
      const directory = await reading;
      if (started !== generation) return settleFirst();
      if (inbox && directory) return publish(inbox, directory, "ready");
    } catch {
      // A failed read is the stale case below.
    }
    if (started !== generation) return settleFirst();
    if (conversation) conversation.stale = true;
    settleFirst();
  }

  /** Re-reads Ark's files soon after a watched folder changed; the 2 s timer is the fallback. */
  let arkSoon: ReturnType<typeof setTimeout> | undefined;
  function syncWatchers(): void {
    const wanted = new Set(arkReader.watchPaths());
    for (const [path, watcher] of watchers) {
      if (wanted.has(path)) continue;
      watcher.close();
      watchers.delete(path);
    }
    for (const path of wanted) {
      if (watchers.has(path)) continue;
      try {
        watchers.set(
          path,
          watch(path, () => {
            clearTimeout(arkSoon);
            arkSoon = setTimeout(() => void readers.ark(), 50);
          }),
        );
      } catch {
        // No watcher for this folder: the 2 s timer still sees its changes.
      }
    }
  }

  function loop(read: () => Promise<void>, intervalMilliseconds: number, started: number): void {
    const tick = async () => {
      await read();
      if (generation !== started) return;
      const timer = setTimeout(() => {
        timers.delete(timer);
        void tick();
      }, intervalMilliseconds);
      timers.add(timer);
    };
    void tick();
  }

  let firstArkRead: Promise<void> | undefined;

  /** Idempotent. Reads Ark first, so the other sources know which runs are open, then starts every other loop and the Ark timer. */
  async function resume(): Promise<void> {
    if (running) return;
    running = true;
    const started = ++generation;
    firstArkRead = readers.ark();
    await firstArkRead;
    if (generation !== started) return;
    armed = true;
    const arkTimer = setInterval(() => void readers.ark(), intervalMilliseconds.ark);
    timers.add(arkTimer as unknown as ReturnType<typeof setTimeout>);
    for (const name of [
      "orca",
      "plannotator",
      "github",
      "usage",
      "providerLimits",
      "agentWait",
      "evidence",
      "queue",
      "resources",
    ] as const)
      loop(() => readers[name](), intervalMilliseconds[name], started);
    loop(
      () => {
        return readConversation();
      },
      conversationIntervalMilliseconds,
      started,
    );
  }

  /** Idempotent. A read in flight finishes into nothing: `generation` changed, so it neither publishes nor re-arms. */
  function pause(): void {
    if (!running) return;
    running = false;
    armed = false;
    generation++;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    clearTimeout(arkSoon);
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
    try {
      resourcesReader.flush();
    } catch {
      // A run folder that cannot be written keeps no pause time: the next sample records no gap.
    }
  }

  return {
    /**
     * Resolves once Ark has been read, for a request that arrives before any page is connected (or
     * before the first read of the page that is connecting) and needs the runs and tickets.
     */
    async ready(): Promise<void> {
      if (slots.ark.value) return;
      await readers.ark();
      if (!slots.ark.value && firstArkRead) await firstArkRead;
    },
    stop(): void {
      stopped = true;
      pause();
      usage.close();
    },
    /** The serialized snapshot: what `/api/snapshot` sends and what a new `/events` client gets first. */
    json(): string {
      if (lastJson === "") {
        lastBody = JSON.stringify(compose());
        lastJson = JSON.stringify({
          generated_at: new Date().toISOString(),
          ...JSON.parse(lastBody),
        });
      }
      return lastJson;
    },
    /**
     * The first subscriber resumes the reader (Ark first, then every other source); the last one to
     * leave pauses it. With no subscriber the hub runs no read, timer or file watcher.
     */
    subscribe(listener: (json: string) => void): () => void {
      listeners.add(listener);
      if (listeners.size === 1 && !stopped) void resume();
      return () => {
        if (listeners.delete(listener) && listeners.size === 0) pause();
      };
    },
    usage,
    /** The 24-hour history of each host signal, kept in memory only: what `GET /api/resources/history` sends. */
    resourcesHistory: () => resourcesReader.history(),
    /** Run folder of a run the hub knows (open or closed), or null. The URL names a run, never a path. */
    runDirectory(run: string): string | null {
      return (
        slots.ark.value?.runs.find((candidate) => candidate.state.run === run)?.directory ?? null
      );
    },
    /**
     * Any run, open or closed, read on request: timeline from the events held in memory, the run files
     * that exist, and the session files mapped whole to owners. Null for a run the hub does not know.
     */
    runDetail(run: string): RunDetail | null {
      const found = slots.ark.value?.runs.find((candidate) => candidate.state.run === run);
      if (!found) return null;
      const closed = found.state.phase === "closed";
      const { events } = found;
      const closedAt = closed
        ? (events.findLast((event) => event.type === "run.closed")?.time ?? null)
        : null;
      return {
        view: viewOf(found, closed),
        closed,
        outcome: found.state.outcome,
        closed_at: closedAt,
        band: closed ? bandOf(found, closedAt) : null,
        time_split: splitRunTime(events, now()),
        timeline: timelineOf(events),
        files: listRunFiles(found.directory),
        sessions: usage.sessionsOf(
          found.directory,
          found.windows,
          Date.parse(events[0].time),
          stageTimes(events),
        ),
        sessions_ready: slots.usage.readAt !== null,
      };
    },
    /** The document of one listed ticket, read from its file on request. Null for a ticket the hub does not list. */
    ticketDocument(project: string, id: string) {
      const value = slots.ark.value;
      const ticket = value?.tickets.find((entry) => entry.project === project && entry.id === id);
      const listed = ticket && value?.ticketFiles.get(ticket);
      return listed ? readTicketDocument(listed) : null;
    },
    /** The test cases that a ticket names, read on request (see `readTicketCases`). Null for a ticket the hub does not know. */
    ticketCases(project: string, ticket: string) {
      const value = slots.ark.value;
      if (!value) return Promise.resolve(null);
      const newest = value.runs.find(
        (candidate) => candidate.state.project === project && candidate.state.ticket.id === ticket,
      );
      return readTicketCases(
        project,
        ticket,
        value.tickets,
        value.ticketFiles,
        newest?.directory ?? null,
      );
    },
    /** The test evidence of a run, read on request, open or closed. Null for a run the hub does not know. */
    runEvidence(run: string) {
      const found = slots.ark.value?.runs.find((candidate) => candidate.state.run === run);
      return found
        ? readRunEvidence(
            found.directory,
            found.state.project,
            found.state.ticket.id,
            slots.ark.value!.tickets,
            slots.ark.value!.ticketFiles,
          )
        : null;
    },
    /** Terminal handles the current snapshot lists as live: the only handles `open-in-orca` accepts. */
    liveTerminals(): Set<string> {
      const current = JSON.parse(this.json()) as Snapshot;
      const handles = new Set<string>();
      if (current.runs !== "unknown")
        for (const run of current.runs)
          if (run.agents !== "unknown")
            for (const agent of run.agents)
              if (agent.presence === "live" && agent.terminal) handles.add(agent.terminal);
      return handles;
    },
    /**
     * One page of a session file of the run, read in the usage worker thread. Null when the hub does
     * not know the run or the file is not one of the run's session files (the URL never names a path
     * that the index did not list). Rejects when the worker fails.
     */
    async transcript(run: string, file: string, cursor: number): Promise<TranscriptPage | null> {
      const session = this.runDetail(run)?.sessions.find((candidate) => candidate.file === file);
      return session ? usage.transcript(file, session.harness, cursor) : null;
    },
    /** The full result of one call in a session file of the run, or null for a foreign file, an unknown call or a call with no result yet. */
    async transcriptResult(
      run: string,
      file: string,
      callId: string,
    ): Promise<TranscriptResult | null> {
      const session = this.runDetail(run)?.sessions.find((candidate) => candidate.file === file);
      return session ? usage.transcriptResult(file, session.harness, callId) : null;
    },
    /**
     * The conversation of one run or of a window, built in the usage worker thread from the last good inbox read. Waits only for the
     * first read of a connected page. Null when no read has succeeded (no page connected, or Orca down), or for a run with no events.
     */
    async conversation(query: ConversationQuery): Promise<ConversationReply | null> {
      if (!conversation) await conversationFirst;
      const held = conversation;
      if (!held) return null;
      const wanted = (slots.ark.value?.runs ?? []).filter(
        (run) => query.kind === "project" || run.state.run === query.run,
      );
      const runs: RunEvents[] = wanted.map((run) => ({
        run: run.state.run,
        project: run.state.project,
        // The project answer needs only the human answers, the step spans and the workers that ran them.
        events:
          query.kind === "run"
            ? run.events
            : run.events.filter((event) =>
                ["gate.answered", "step.started", "step.finished", "worker.started"].includes(
                  event.type,
                ),
              ),
      }));
      const answer = await usage.conversation(held.input, runs, query);
      return answer
        ? {
            truncated: held.truncated,
            stale: held.stale,
            directory: held.directory,
            read_at: held.version,
            ...answer,
          }
        : null;
    },
    /** One message with its body, looked up by id in memory: the id never builds a path or a command. */
    conversationMessage(id: string): InboxMessage | null {
      return conversation?.messages.get(id) ?? null;
    },
  };
}
