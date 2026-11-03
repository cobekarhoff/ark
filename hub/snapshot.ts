import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../cli/config.ts";
import { waitingGate } from "../cli/run.ts";
import {
  createArkReader,
  readGithub,
  readOrca,
  readPlannotator,
  signatureOf,
  type ArkRun,
  type ArkValue,
  type MergeRequestFacts,
  type OrcaValue,
  type PlannotatorSession,
} from "./sources.ts";
import type {
  Gate,
  GateKind,
  RunView,
  Snapshot,
  SourceName,
  StepStatus,
  TicketRunView,
} from "./types.ts";
import { UsageIndex, type RunCost } from "./usage.ts";

export const intervalMilliseconds: Record<SourceName, number> = {
  ark: 2000, // also woken by fs watchers; Orca (0.3 to 0.5 s a call) is never the trigger
  orca: 3000,
  plannotator: 5000,
  github: 15_000,
  usage: 5000,
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
  };
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
      };

    const openRuns = ark.runs.filter((run) => run.state.phase !== "closed");
    const sessions = slots.plannotator.value ?? [];
    const gates: Gate[] = [];
    const runs = openRuns.map((run): RunView => {
      const { state, events, directory } = run;
      const cost = costOf(run, false);
      const statusOf = (id: string): StepStatus =>
        state.steps.find((step) => step.id === id)?.status ?? "pending";
      const startOf = (id: string): string | null => {
        const start = run.windows.findLast((window) => window.id === id)?.start;
        return start === undefined ? null : new Date(start).toISOString();
      };
      const waiting = slots.orca.value?.waits.get(state.run) ?? [];
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
          return { ...request, state: facts?.state ?? "unknown", ci: facts?.ci ?? "unknown" };
        }),
        agents: slots.orca.value
          ? (slots.orca.value.agents.get(state.run) ?? []).map((agent) => {
              const step = run.plan?.find((candidate) => candidate.id === agent.step);
              if (step)
                return {
                  ...agent,
                  planned: { harness: step.harness, model: step.model, source: "plan" as const },
                };
              // A run lead starts with the harness and model of `roles.chief` (chief playbook).
              const chief = agent.step === null ? chiefRole(state.project) : null;
              return chief
                ? { ...agent, planned: { ...chief, source: "configured" as const } }
                : agent;
            })
          : "unknown",
        waiting,
        cost_usd: cost.total,
      };
    });
    gates.sort((left, right) => left.since.localeCompare(right.since));

    // Runs are newest first, so the first run seen for a ticket is its newest.
    const newest = new Map<string, TicketRunView>();
    for (const run of ark.runs) {
      const key = `${run.state.project}/${run.state.ticket.id}`;
      if (newest.has(key)) continue;
      const closed = run.state.phase === "closed";
      newest.set(key, {
        project: run.state.project,
        ticket: run.state.ticket.id,
        run: run.state.run,
        phase: run.state.phase,
        waiting: !closed && (slots.orca.value?.waits.get(run.state.run)?.length ?? 0) > 0,
        cost_usd: costOf(run, closed).total,
      });
    }
    return {
      sources,
      runs,
      gates,
      tickets: ark.tickets,
      ticket_runs: [...newest.values()],
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
      for (const name of ["orca", "plannotator", "github", "usage"] as const) loop(name);
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
  };
}
