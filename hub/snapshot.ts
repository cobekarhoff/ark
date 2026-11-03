import { readFileSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../cli/config.ts";
import { projectDirectory } from "../cli/paths.ts";
import { waitingGate } from "../cli/run.ts";
import {
  createArkReader,
  createEvidenceReader,
  parseAgentTitle,
  readAgentWait,
  readGithub,
  readOrca,
  readPlannotator,
  readProviderLimits,
  signatureOf,
  type ArkRun,
  type ArkValue,
  type EvidenceValue,
  type MergeRequestFacts,
  unknownActivity,
  type OrcaValue,
  type PlannotatorSession,
  type PsAgent,
} from "./sources.ts";
import type {
  Agent,
  Gate,
  GateKind,
  ProviderWindow,
  RoleTimes,
  RunDetail,
  RunEvidence,
  RunProgress,
  RunView,
  Snapshot,
  SourceName,
  StepStatus,
  TicketDocument,
  TicketRunView,
  TranscriptPage,
} from "./types.ts";
import { roleTimesOf } from "./progress.ts";
import { listRunFiles, timelineOf } from "./run-detail.ts";
import { parseTicketDocument } from "./ticket-document.ts";
import { UsageIndex, type RunCost } from "./usage.ts";

export const intervalMilliseconds: Record<SourceName, number> = {
  ark: 2000, // also woken by fs watchers; Orca (0.3 to 0.5 s a call) is never the trigger
  orca: 3000,
  plannotator: 5000,
  github: 15_000,
  usage: 5000,
  providerLimits: 60_000,
  agentWait: 3000,
  evidence: 5000,
};

const usageTimeoutMilliseconds = 30_000;

/** Harness and model of `roles.chief` in the project's `ark.yml`, or null when unset or unreadable. */
function chiefRole(project: string): { harness: string; model: string } | null {
  try {
    return loadConfig(project).roles.chief ?? null;
  } catch {
    return null;
  }
}

type Slot<T> = { ok: boolean; readAt: string | null; value: T | null };
const emptySlot = <T>(): Slot<T> => ({ ok: false, readAt: null, value: null });

const questions: Record<GateKind, (title: string) => string> = {
  criteria: (title) => `Approve the acceptance criteria for "${title}"?`,
  strategy: (title) => `Pick a strategy for "${title}"`,
  plan: (title) => `Approve the plan for "${title}"?`,
  escalation: (title) => `Escalation on "${title}": decide how to go on`,
};
const gateEvents: Record<GateKind, string> = {
  criteria: "run.started",
  strategy: "strategy.recorded",
  plan: "plan.checked",
  escalation: "escalation.requested",
};

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
  };
  const evidenceReader = createEvidenceReader();
  let githubFacts = new Map<string, MergeRequestFacts>();
  const costs = new Map<string, { key: string; cost: RunCost }>();
  const listeners = new Set<(json: string) => void>();
  const watchers = new Map<string, FSWatcher>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let stopped = false;
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
        live: false,
        running: true,
        activity: listed.activity,
      });
    }
    return agents.map((agent) => {
      const step = run.plan?.find((candidate) => candidate.id === agent.step);
      if (step)
        return {
          ...agent,
          planned: { harness: step.harness, model: step.model, source: "plan" as const },
        };
      // A run lead starts with the harness and model of `roles.chief` (chief playbook).
      const chief = agent.step === null ? chiefRole(run.state.project) : null;
      return chief ? { ...agent, planned: { ...chief, source: "configured" as const } } : agent;
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
      merge_requests: state.merge_requests.map((request) => {
        const facts = githubFacts.get(request.url);
        return {
          ...request,
          state: facts?.state ?? "unknown",
          ci: facts?.ci ?? "unknown",
          checks: facts?.checks ?? [],
          additions: facts?.additions ?? null,
          deletions: facts?.deletions ?? null,
          changed_files: facts?.changed_files ?? null,
          created_at: facts?.created_at ?? null,
        };
      }),
      agents: closed ? [] : agentsOf(run),
      waiting,
      progress: progressOf(run, startOf),
      evidence: evidenceOf(run),
      cost_usd: cost.total,
    };
  }

  function compose(): Omit<Snapshot, "generated_at"> {
    const sources = Object.fromEntries(
      Object.entries(slots).map(([name, slot]) => [name, { ok: slot.ok, read_at: slot.readAt }]),
    ) as Snapshot["sources"];
    const ark = slots.ark.value;
    if (!ark)
      return {
        sources,
        runs: "unknown",
        gates: "unknown",
        tickets: "unknown",
        ticket_runs: "unknown",
        provider_limits: slots.providerLimits.value ?? "unknown",
        role_times: {},
      };

    const openRuns = ark.runs.filter((run) => run.state.phase !== "closed");
    const sessions = slots.plannotator.value ?? [];
    const gates: Gate[] = [];
    const runs = openRuns.map((run): RunView => {
      const { state, events, directory } = run;
      const kind = waitingGate(state);
      if (kind !== "none") {
        const gateKind = kind as GateKind;
        const document = join(
          directory,
          gateKind === "plan" ? "plan.md" : gateKind === "strategy" ? "strategies.md" : "ticket.md",
        );
        gates.push({
          id: `gate:${state.run}:${kind}`,
          run: state.run,
          project: state.project,
          ticket: state.ticket.id,
          kind: gateKind,
          question: questions[gateKind](state.ticket.title),
          review_url: sessions.find((session) => session.target === document)?.url ?? null,
          since: (events.findLast((event) => event.type === gateEvents[gateKind]) ?? events.at(-1)!)
            .time,
        });
      }
      return viewOf(run, false);
    });
    gates.sort((left, right) => left.since.localeCompare(right.since));

    // Runs are newest first, so the first run seen for a ticket is its newest.
    const newest = new Map<string, TicketRunView>();
    for (const run of ark.runs) {
      const key = `${run.state.project}/${run.state.ticket.id}`;
      const closed = run.state.phase === "closed";
      const known = newest.get(key);
      if (known) {
        known.all.push({ run: run.state.run, phase: run.state.phase });
        continue;
      }
      newest.set(key, {
        project: run.state.project,
        ticket: run.state.ticket.id,
        run: run.state.run,
        phase: run.state.phase,
        waiting: !closed && (slots.orca.value?.waits.get(run.state.run)?.length ?? 0) > 0,
        cost_usd: costOf(run, closed).total,
        all: [{ run: run.state.run, phase: run.state.phase }],
      });
    }
    return {
      sources,
      runs,
      gates,
      tickets: ark.tickets,
      ticket_runs: [...newest.values()],
      provider_limits: slots.providerLimits.value ?? "unknown",
      role_times: roleTimes(),
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
    try {
      const value = await reader();
      if (value === null) slot.ok = false;
      else {
        slot.value = value;
        slot.readAt = new Date().toISOString();
        slot.ok = true;
      }
    } catch {
      slot.ok = false;
    }
    publish();
  }

  const openRunsOf = () =>
    (slots.ark.value?.runs ?? []).filter((run) => run.state.phase !== "closed");

  const readers: Record<SourceName, () => Promise<void>> = {
    ark: () => {
      const result = read("ark", () => arkReader.read());
      syncWatchers();
      return result;
    },
    orca: () =>
      read("orca", () =>
        readOrca(openRunsOf().map(({ state }) => ({ run: state.run, project: state.project }))),
      ),
    plannotator: () => read("plannotator", () => readPlannotator()),
    github: () =>
      read("github", async () => {
        const urls = openRunsOf().flatMap((run) => run.state.merge_requests.map((mr) => mr.url));
        const { facts, ok } = await readGithub(urls, githubFacts);
        githubFacts = facts;
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
  };

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

  function loop(name: SourceName): void {
    const tick = async () => {
      await readers[name]();
      if (!stopped) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          void tick();
        }, intervalMilliseconds[name]);
        timers.add(timer);
      }
    };
    void tick();
  }

  return {
    /** Reads Ark first, so the other sources know which runs are open, then starts every loop. */
    async start(): Promise<void> {
      await readers.ark();
      const timer = setInterval(() => void readers.ark(), intervalMilliseconds.ark);
      timers.add(timer as unknown as ReturnType<typeof setTimeout>);
      for (const name of [
        "orca",
        "plannotator",
        "github",
        "usage",
        "providerLimits",
        "agentWait",
        "evidence",
      ] as const)
        loop(name);
    },
    stop(): void {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      clearTimeout(arkSoon);
      for (const watcher of watchers.values()) watcher.close();
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
    subscribe(listener: (json: string) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    usage,
    /** Text of a ticket the hub lists, read on request: the URL names a project and an id, never a path. */
    ticketDocument(project: string, id: string): TicketDocument | null {
      const listed = slots.ark.value?.tickets.some(
        (ticket) => ticket.project === project && ticket.id === id,
      );
      if (!listed) return null;
      try {
        return parseTicketDocument(
          readFileSync(join(projectDirectory(project), "tickets", `${id}.md`), "utf8"),
        );
      } catch {
        return null;
      }
    },
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
      return {
        view: viewOf(found, closed),
        closed,
        outcome: found.state.outcome,
        closed_at: closed
          ? (events.findLast((event) => event.type === "run.closed")?.time ?? null)
          : null,
        timeline: timelineOf(events),
        files: listRunFiles(found.directory),
        sessions: usage.sessionsOf(found.directory, found.windows, Date.parse(events[0].time)),
        sessions_ready: slots.usage.readAt !== null,
      };
    },
    /** Terminal handles the current snapshot lists as live: the only handles `open-in-orca` accepts. */
    liveTerminals(): Set<string> {
      const current = JSON.parse(this.json()) as Snapshot;
      const handles = new Set<string>();
      if (current.runs !== "unknown")
        for (const run of current.runs)
          if (run.agents !== "unknown")
            for (const agent of run.agents)
              if (agent.live && agent.terminal) handles.add(agent.terminal);
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
  };
}
