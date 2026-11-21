import { join } from "node:path";
import { now } from "../cli/clock.ts";
import { hubConfig } from "./config.ts";
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
  readChiefUnreads,
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
  ProjectUnread,
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
import { chainOf, needsRepoFacts, readRepoFacts, repoViews, type RepoFacts } from "./repos.ts";
import { isProved, listRunFiles, timelineOf } from "./run-detail.ts";
import { companionSessionFiles } from "./companions.ts";
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
  chiefUnread: allIntervalMilliseconds || 15_000, // the whole inbox is read (about 2 MB): as slow as the conversation read
  resources: allIntervalMilliseconds || 5000, // one ps and one lsof: about 0.2 s of CPU, so slower than Orca
};
/** The git facts of a run's repo graph: its own loop, like the inbox read, so no git runs in `viewOf`. */
const repoFactsIntervalMilliseconds = allIntervalMilliseconds || 3000;
/** The full inbox read (ARK-344): its own loop, never a snapshot source, so a failure never touches `orca` and no message reaches `/events`. */
const conversationIntervalMilliseconds = allIntervalMilliseconds || 15_000;

const usageTimeoutMilliseconds = 30_000;

/** Harness and model of `roles.<role>` in the project's `ark.yml`, or null when unset or unreadable. */
function roleConfig(
  project: string,
  role: "chief" | "evaluator" | "designer",
): { harness: string; model: string } | null {
  try {
    return hubConfig(project).roles[role] ?? null;
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

/** The most recent finished pass of a source: how long it took and when it ended (ms since the epoch). */
type Pass = { durationMilliseconds: number; endedAt: number };
/** `GET /api/health` (ARK-533): a reader pass longer than its interval is slow; lag is null while no page is connected. */
export type Health = {
  lag_ms: number | null;
  sources: Record<SourceName, { last_ms: number | null; ended_at: string | null; slow: boolean }>;
  slow: SourceName[];
};
/** The event loop lag is the largest delay of a timer of this period over the last minute. */
const lagTimerMilliseconds = 100;
const lagWindowMilliseconds = 60_000;
/** The hub logs a loop lag above this. */
const lagLogMilliseconds = 1000;
/** The longest a request waits for the first inbox read (ARK-533: every route answers within 1 s). */
const firstConversationWaitMilliseconds = 250;

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
    chiefUnread: emptySlot<true>(),
    resources: emptySlot<ResourcesView>(),
  };
  // Health (ARK-533), outside `slots` and `compose()` so it never makes a push. Both parts exist only while a page is connected:
  // `pause()` clears them, so a hub with no page reports no lag and no pass.
  const passes = new Map<SourceName, Pass>();
  let lagSamples: { at: number; delay: number }[] = [];
  let lagTimer: NodeJS.Timeout | undefined;
  const resourcesReader = createResourcesReader();
  const evidenceReader = createEvidenceReader();
  let githubFacts = new Map<string, MergeRequestFacts>();
  // The latest queue read of each project, failures included: the reason is data (AC4), so it lives beside the slot, not in it.
  let queueReads: Map<string, QueueRead> | null = null;
  // The latest unread read of each project, failures included: like `queueReads`, so a failing inbox is an `unavailable` entry and never a 0.
  let chiefUnreadReads: ProjectUnread[] | null = null;
  const costs = new Map<string, { key: string; cost: RunCost }>();
  // The model of each owner's newest session, by run directory: `modelsOf` maps every session file of the run, so it is read again only when the index or the run's events moved.
  const sessionModelsOf = new Map<string, { key: string; models: Map<string, string> }>();
  // Git facts of multi-repo runs (branch commits ahead, submodule pointers), by run directory. Read by `repoFactsLoop`, never in `viewOf`.
  // `key` is the event count: a closed run is read once; an open run's branches move without an event, so its entry is read again each tick.
  const repoFacts = new Map<string, { key: number; facts: RepoFacts }>();
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
  /** hub/watch-worker.ts, started at the first sync; one `synced` answer per message, in order. */
  let watchWorker: Worker | undefined;
  const syncAnswers: (() => void)[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let stopped = false;
  let running = false; // at least one /events client: loops, Ark timer and watchers run
  let armed = false; // the loops are started (an Ark read that sees a gate may wake Plannotator)
  let generation = 0; // changes on every pause and resume: a read from an older one is dropped
  let publishPending = false;
  let lastBody = "";
  let lastJson = "";

  function costOf(run: ArkRun, closed: boolean): RunCost {
    const metrics = closed ? run.metrics : "";
    // A closed run's cost is its `metrics.json`: a new usage version never changes it (a re-read of every closed run on each version held the loop, ARK-533).
    const key = closed
      ? `${run.state.events}|${metrics}`
      : `${usage.version}|${run.state.events}|${metrics}|${slots.usage.readAt === null}`;
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
    const modelsKey = `${usage.version}|${run.state.events}`;
    let modelsMemo = sessionModelsOf.get(run.directory);
    if (modelsMemo?.key !== modelsKey) {
      modelsMemo = {
        key: modelsKey,
        models: usage.modelsOf(
          run.directory,
          run.windows,
          Date.parse(run.events[0].time),
          stageTimes(run.events),
        ),
      };
      sessionModelsOf.set(run.directory, modelsMemo);
    }
    const sessionModels = modelsMemo.models;
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
      // A run lead starts with the harness and model of `roles.chief` (chief skill).
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

  /** The MRs of a run as the page draws them. A handed_off run's MR stays with a person, so the page shows no card. */
  function mergeRequestsOf(run: ArkRun, closed: boolean): MergeRequestView[] {
    const { state } = run;
    return (closed && state.outcome === "handed_off" ? [] : state.merge_requests).map(
      ({ order, waits_for, ...request }) => {
        const facts = githubFacts.get(request.url);
        return {
          ...request,
          order: order ?? null,
          waits_for: waits_for ?? [],
          state: closed ? closedMrState(state.outcome) : (facts?.state ?? "unknown"),
          ci: facts?.ci ?? "unknown",
          checks: facts?.checks ?? [],
          additions: facts?.additions ?? null,
          deletions: facts?.deletions ?? null,
          changed_files: facts?.changed_files ?? null,
          created_at: facts?.created_at ?? null,
        };
      },
    );
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
    const mergeRequests = mergeRequestsOf(run, closed);
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
          repo: step.repo,
          harness: step.harness,
          model: step.model,
          needs: step.needs,
          status: statusOf(step.id),
          cost_usd: cost.steps[step.id] ?? null,
          started_at: startOf(step.id),
          waiting: waiting.find((wait) => wait.step === step.id) ?? null,
        })) ?? null,
      repos: repoViews(run, repoFacts.get(run.directory)?.facts, mergeRequests),
      merge_requests: mergeRequests,
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
        chief_unread: "unknown",
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
        chain: chainOf(
          repoViews(run, repoFacts.get(run.directory)?.facts, mergeRequestsOf(run, closed)),
        ),
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
      chief_unread: chiefUnreadReads ?? "unknown",
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
      // The same bytes as stringifying `{ generated_at, ...body }`, without a second pass over a
      // large body that holds the loop (ARK-606).
      lastJson = `{"generated_at":"${new Date(now()).toISOString()}",${text.slice(1)}`;
      for (const listener of listeners) listener(lastJson);
    });
  }

  async function read<Name extends SourceName>(
    name: Name,
    reader: () => Promise<(typeof slots)[Name]["value"]> | (typeof slots)[Name]["value"],
  ): Promise<void> {
    const slot = slots[name] as Slot<unknown>;
    const started = generation;
    const began = performance.now();
    let value: unknown = null;
    try {
      value = await reader();
    } catch {
      // A failed read leaves the slot's value and shows its last good read time.
    }
    if (started !== generation) return; // a pass that a pause dropped is no pass
    const durationMilliseconds = Math.round(performance.now() - began);
    passes.set(name, { durationMilliseconds, endedAt: now() });
    if (durationMilliseconds > intervalMilliseconds[name])
      console.log(`slow pass: ${name} took ${durationMilliseconds} ms`);
    if (value === null) slot.ok = false;
    else {
      const time = new Date(now()).toISOString();
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
      await read("ark", async () => {
        const value = await arkReader.read();
        // What `compose()` would read on its first call is read here, a few runs at a time, so no publish holds the loop for it (ARK-533).
        const open = value.runs.filter((run) => run.state.phase !== "closed");
        await usage.remember(open.map((run) => run.directory));
        for (const [index, run] of value.runs.entries()) {
          if (run.state.phase !== "closed") continue;
          costOf(run, true);
          if (index % 8 === 7) await new Promise((resolve) => setImmediate(resolve));
        }
        return value;
      });
      if (!running) return;
      await syncWatchers(arkReader.watchPaths());
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
          usage.refresh(directories, companionSessionFiles()).then(() => true as const),
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
    // Failed (stale chip) when any project's inbox could not be read; the reason is in `chiefUnreadReads`.
    chiefUnread: () =>
      read("chiefUnread", async () => {
        const started = generation;
        const reads = await readChiefUnreads();
        if (started === generation) chiefUnreadReads = reads;
        return reads.every((unread) => !("unavailable" in unread)) ? true : null;
      }),
  };

  /** Git facts of the multi-repo runs (hub/repos.ts). Not a source: it has no slot and no stale chip, and an unread fact shows as unknown. */
  async function readRepoFactsOnce(): Promise<void> {
    const started = generation;
    let changed = false;
    for (const run of (slots.ark.value?.runs ?? []).filter(needsRepoFacts)) {
      const known = repoFacts.get(run.directory);
      if (run.state.phase === "closed" && known?.key === run.state.events) continue;
      const facts = readRepoFacts(run);
      if (started !== generation) return;
      if (JSON.stringify(known?.facts) !== JSON.stringify(facts)) changed = true;
      repoFacts.set(run.directory, { key: run.state.events, facts });
      await new Promise((resolve) => setTimeout(resolve)); // git is read with spawnSync: let a request run between two runs
    }
    if (changed) publish();
  }

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
  /**
   * Sends the folders to watch to hub/watch-worker.ts and waits for its answer. The worker is the only thread that calls `watch()`
   * (ARK-613). A worker that fails or closes is dropped, its waiters released, and the next sync starts a new one: the 2 s timer
   * covers the folders in between.
   */
  function syncWatchers(paths: string[]): Promise<void> {
    if (!watchWorker) {
      const worker = new Worker(new URL("./watch-worker.ts", import.meta.url));
      const gone = () => {
        if (watchWorker !== worker) return;
        watchWorker = undefined;
        for (const answer of syncAnswers.splice(0)) answer();
      };
      worker.onmessage = (event) => {
        if (event.data === "synced") syncAnswers.shift()?.();
        else if (running) {
          clearTimeout(arkSoon);
          arkSoon = setTimeout(() => void readers.ark(), 50);
        }
      };
      worker.onerror = gone;
      worker.addEventListener("close", gone);
      watchWorker = worker;
    }
    return new Promise((resolve) => {
      syncAnswers.push(resolve);
      watchWorker!.postMessage(paths);
    });
  }

  /** One timer of 100 ms while a page is connected: how late it fires is the event loop lag. */
  function startLagTimer(): void {
    let expected = performance.now() + lagTimerMilliseconds;
    lagTimer = setInterval(() => {
      const at = performance.now();
      const delay = Math.max(0, Math.round(at - expected));
      expected = at + lagTimerMilliseconds;
      while (lagSamples.length > 0 && lagSamples[0].at < at - lagWindowMilliseconds)
        lagSamples.shift();
      lagSamples.push({ at, delay });
      if (delay > lagLogMilliseconds) console.log(`loop lag: ${delay} ms`);
    }, lagTimerMilliseconds);
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
    startLagTimer();
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
      "chiefUnread",
      "resources",
    ] as const)
      loop(() => readers[name](), intervalMilliseconds[name], started);
    loop(readRepoFactsOnce, repoFactsIntervalMilliseconds, started);
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
    clearInterval(lagTimer);
    lagSamples = [];
    passes.clear();
    armed = false;
    generation++;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    clearTimeout(arkSoon);
    if (watchWorker) void syncWatchers([]);
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
    /** What `GET /api/health` sends, from memory: the lag of the last minute and the last pass of each source. */
    health(): Health {
      const cutoff = performance.now() - lagWindowMilliseconds;
      const delays = lagSamples
        .filter((sample) => sample.at >= cutoff)
        .map((sample) => sample.delay);
      const sources = {} as Health["sources"];
      const slow: SourceName[] = [];
      for (const name of Object.keys(slots) as SourceName[]) {
        const pass = passes.get(name);
        const isSlow = pass !== undefined && pass.durationMilliseconds > intervalMilliseconds[name];
        if (isSlow) slow.push(name);
        sources[name] = {
          last_ms: pass?.durationMilliseconds ?? null,
          ended_at: pass ? new Date(pass.endedAt).toISOString() : null,
          slow: isSlow,
        };
      }
      return { lag_ms: delays.length === 0 ? null : Math.max(...delays), sources, slow };
    },
    stop(): void {
      stopped = true;
      pause();
      const worker = watchWorker;
      watchWorker = undefined;
      worker?.terminate();
      for (const answer of syncAnswers.splice(0)) answer();
      usage.close();
    },
    /** The serialized snapshot: what `/api/snapshot` sends and what a new `/events` client gets first. */
    json(): string {
      if (lastJson === "") {
        lastBody = JSON.stringify(compose());
        lastJson = JSON.stringify({
          generated_at: new Date(now()).toISOString(),
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
     * The conversation of one run or of a window, built in the usage worker thread from the last good inbox read. Waits at most 250 ms for the
     * first read of a connected page. Null when no read has succeeded (no page connected, or Orca down), or for a run with no events.
     */
    async conversation(query: ConversationQuery): Promise<ConversationReply | null> {
      // A cold hub waits for the first Ark read (250 runs) and the first inbox read (an Orca call, up to two seconds for the handle
      // directory): wait a short bound for both together, then answer "no read yet" (503). The reads keep running.
      const bound = Bun.sleep(firstConversationWaitMilliseconds);
      if (!slots.ark.value) await Promise.race([this.ready(), bound]);
      if (!conversation && conversationFirst) await Promise.race([conversationFirst, bound]);
      const held = conversation;
      if (!held || !slots.ark.value) return null;
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
