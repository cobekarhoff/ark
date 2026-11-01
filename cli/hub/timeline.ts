import { deriveState, type ArkEvent } from "../events.ts";
import { waitingGate } from "../run.ts";
import { readUsage } from "../usage/index.ts";
import { readRuns } from "./ark.ts";
import { collectedIntervals, readHistory, type HistoryEvent } from "./changes.ts";
import type { HubView } from "./map.ts";

export const timelineWindows = [1, 12, 24];

export type Segment = {
  kind: "phase" | "gate" | "worker" | "stall" | "pause" | "ci" | "chief" | "unavailable";
  from: string;
  /** Null while the thing still goes on. */
  to: string | null;
  item?: string;
  state?: string;
};

/** `usd` is the known cost inside the window, or "unknown" when any message in it has no provider cost. `baseline` is the cumulative known cost before the window, where `series` starts. */
export type Cost = {
  usd: number | "unknown";
  baseline: number;
  series: { at: string; usd: number | "unknown" }[];
};

export type Lane = {
  id: string;
  kind: "chief" | "run" | "agent";
  label: string;
  segments: Segment[];
  cost: Cost;
};

const unknownCost: Cost = { usd: "unknown", baseline: 0, series: [] };

type Open = { name: string; from: string };

/** Phase, gate wait and worker segments of one run, from its events. */
function eventSegments(events: ArkEvent[]): Segment[] {
  const segments: Segment[] = [];
  const run = events[0]?.data.run as string;
  let phase = null as Open | null;
  let gate = null as Open | null;
  const workers = new Map<string, string>();
  const close = (
    open: Open | null,
    next: string | null,
    time: string,
    make: (name: string) => Omit<Segment, "from" | "to">,
  ) => {
    if (open && open.name !== next)
      segments.push({ ...make(open.name), from: open.from, to: time });
    return open && open.name === next ? open : next ? { name: next, from: time } : null;
  };
  events.forEach((event, index) => {
    const state = deriveState(events.slice(0, index + 1));
    phase = close(phase, state.phase === "closed" ? null : state.phase, event.time, (name) => ({
      kind: "phase",
      item: name,
    }));
    const waiting = waitingGate(state);
    gate = close(gate, waiting === "none" ? null : waiting, event.time, (name) => ({
      kind: "gate",
      item: `gate:${run}:${name}`,
    }));
    if (event.type === "step.started") workers.set(event.data.step, event.time);
    if (event.type === "step.finished" && workers.has(event.data.step)) {
      segments.push({
        kind: "worker",
        item: `step:${run}:${event.data.step}`,
        state: event.data.outcome,
        from: workers.get(event.data.step)!,
        to: event.time,
      });
      workers.delete(event.data.step);
    }
  });
  const closed = events.find((event) => event.type === "run.closed")?.time ?? null;
  const open = (name: string, from: string, kind: Segment["kind"], item: string) =>
    segments.push({ kind, from, to: closed, item });
  if (phase) open(phase.name, phase.from, "phase", phase.name);
  if (gate) open(gate.name, gate.from, "gate", `gate:${run}:${gate.name}`);
  for (const [step, from] of workers) open(step, from, "worker", `step:${run}:${step}`);
  return segments;
}

/** The spans where `key` held a state that `pick` names, from the history log only. */
function historySegments(
  history: HistoryEvent[],
  key: string,
  now: string,
  pick: (event: HistoryEvent) => Omit<Segment, "from" | "to"> | null,
): Segment[] {
  const segments: Segment[] = [];
  for (const span of collectedIntervals(history, now)) {
    const changes = history.filter(
      (event) =>
        event.type === "state.changed" &&
        event.key === key &&
        Date.parse(event.time) >= Date.parse(span.from) &&
        Date.parse(event.time) <= Date.parse(span.to),
    );
    changes.forEach((event, index) => {
      const segment = pick(event);
      if (!segment) return;
      const end = changes[index + 1]?.time ?? span.to;
      segments.push({
        ...segment,
        from: event.time,
        to: end === now ? null : end,
      });
    });
  }
  return segments;
}

/** Cost over time from the usage logs. A message with no provider cost makes its point and the total "unknown". */
function costOf(directory: string, since: number): Cost {
  try {
    const messages = readUsage(directory)
      .flatMap((session) => session.messages)
      .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
    let sum = 0;
    let baseline = 0;
    const series: Cost["series"] = [];
    for (const message of messages) {
      if (message.costUsd !== "unknown") sum += message.costUsd;
      if (Date.parse(message.time) < since) baseline = sum;
      else
        series.push({
          at: message.time,
          usd: message.costUsd === "unknown" ? "unknown" : sum,
        });
    }
    return {
      usd:
        series.length === 0 || series.some((point) => point.usd === "unknown")
          ? "unknown"
          : sum - baseline,
      baseline,
      series,
    };
  } catch {
    return unknownCost;
  }
}

/** One lane for each Master Chief, run and agent that belongs to no run, over the last `hours`. */
export function buildTimeline(
  view: HubView,
  hours: number,
  now = new Date(),
): { hours: number; lanes: Lane[] } {
  const nowIso = now.toISOString();
  const since = now.getTime() - hours * 3_600_000;
  const history = readHistory();
  const spans = collectedIntervals(history, nowIso);

  // The window minus every collected span: time the hub has no history for.
  const gaps: Segment[] = [];
  let cursor = since;
  for (const span of spans.filter((candidate) => Date.parse(candidate.to) > since)) {
    if (Date.parse(span.from) > cursor)
      gaps.push({
        kind: "unavailable",
        from: new Date(cursor).toISOString(),
        to: span.from,
      });
    cursor = Math.max(cursor, Date.parse(span.to));
  }
  if (cursor < now.getTime())
    gaps.push({
      kind: "unavailable",
      from: new Date(cursor).toISOString(),
      to: null,
    });

  const inWindow = (segment: Segment) => segment.to === null || Date.parse(segment.to) > since;
  const clipped = (segments: Segment[]) =>
    [...segments.filter(inWindow), ...gaps].map((segment) => ({
      ...segment,
      from: Date.parse(segment.from) < since ? new Date(since).toISOString() : segment.from,
    }));

  const lanes: Lane[] = view.projects.map(({ name }) => ({
    id: `chief:${name}`,
    kind: "chief",
    label: `Master Chief ${name}`,
    segments: clipped(
      historySegments(history, `chief:${name}`, nowIso, (event) => ({
        kind: "chief",
        state: event.state,
      })),
    ),
    cost: unknownCost,
  }));

  const runs = readRuns(now.getTime()).filter(
    ({ state, events }) =>
      state.phase !== "closed" || Date.parse(events[events.length - 1].time) > since,
  );
  for (const { directory, state, events } of runs) {
    const agentStates = (pick: (event: HistoryEvent) => Omit<Segment, "from" | "to"> | null) =>
      [
        ...new Set(
          history.flatMap((event) =>
            event.key?.startsWith(`agent:${state.run}:`) ? [event.key] : [],
          ),
        ),
      ].flatMap((key) => historySegments(history, key, nowIso, pick));
    lanes.push({
      id: `run:${state.run}`,
      kind: "run",
      label: state.ticket.id,
      segments: clipped([
        ...eventSegments(events),
        ...agentStates((event) => (event.state === "stuck" ? { kind: "stall" } : null)),
        ...agentStates((event) => (/pause/i.test(event.activity ?? "") ? { kind: "pause" } : null)),
        ...state.merge_requests.flatMap(({ url }) =>
          historySegments(history, `ci:${url}`, nowIso, (event) =>
            event.state === "pending"
              ? { kind: "ci", item: `ci:${url}`, state: event.state }
              : null,
          ),
        ),
      ]),
      cost: costOf(directory, since),
    });
  }

  // An agent whose run has no lane (an older or removed run) still gets its own lane.
  const runIds = new Set(runs.map(({ state }) => state.run));
  const standalone = new Set(
    history.flatMap((event) =>
      event.key?.startsWith("agent:") && !runIds.has(event.key.split(":")[1]) ? [event.key] : [],
    ),
  );
  for (const key of standalone)
    lanes.push({
      id: key,
      kind: "agent",
      label: key.split(":").slice(2).join(":"),
      segments: clipped([
        ...historySegments(history, key, nowIso, (event) =>
          event.state === "stuck" ? { kind: "stall" } : null,
        ),
        ...historySegments(history, key, nowIso, (event) =>
          /pause/i.test(event.activity ?? "") ? { kind: "pause" } : null,
        ),
      ]),
      cost: unknownCost,
    });
  return { hours, lanes };
}
