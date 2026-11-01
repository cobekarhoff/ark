import { deriveState } from "../events.ts";
import { waitingGate } from "../run.ts";
import { readRuns } from "./ark.ts";
import { readHistory, stateAt } from "./history.ts";

/** The parts of the hub's state the Map reads. `createHub().state()` satisfies it. */
export type HubView = {
  projects: { name: string; chief: { state: string } }[];
  runs: {
    run: string;
    open: boolean;
    agents: {
      role: string;
      title: string;
      terminal: string | null;
      liveness: string;
    }[];
    agents_known: boolean;
    merge_requests: { url: string; label: string }[];
  }[];
  needs_me: { id: string }[];
  last_seen: string | null;
};

export type MapNode = {
  id: string;
  kind: "project" | "chief" | "run" | "step" | "agent" | "mr";
  label: string;
  /** "unavailable": the hub was not collecting then. "unknown": a reader failed. Never a guess. */
  state: string;
  needs_you: number;
};

export type MapReplayEvent = {
  time: string;
  kind: string;
  run: string | null;
  label: string;
};

export type MapGraph = {
  at: string;
  replay: { from?: string; to: string; events: MapReplayEvent[] };
  nodes: MapNode[];
  edges: [string, string][];
};

/** The run or project an item id belongs to: `gate:<run>:<gate>`, `mr:<run>`, `ticket:<project>:<id>`. */
const ownerOf = (id: string): string => id.split(":")[1] ?? "";

/**
 * The graph at `at` (an ISO time), or now when `at` is null or not in the past. Run and step
 * state come from `events.ndjson`, so a run with no `run.started` by then is `not_started`.
 * Agent, Master Chief and CI state of a past time come from the history log only: before
 * collection or inside a gap it is "unavailable".
 */
export function buildMap(view: HubView, at: string | null, now = new Date()): MapGraph {
  const nowIso = now.toISOString();
  const live = at === null || Date.parse(at) >= now.getTime();
  const time = live || at === null ? nowIso : at;
  const cutoff = Date.parse(time);
  const history = readHistory();
  const nodes: MapNode[] = [];
  const edges: [string, string][] = [];
  const needsYouOfOwner = (kinds: string[], owner: string) =>
    view.needs_me.filter(
      (item) => kinds.includes(item.id.split(":")[0]) && ownerOf(item.id) === owner,
    ).length;

  for (const { name, chief } of view.projects) {
    const seen = live ? { state: chief.state } : stateAt(history, `chief:${name}`, time, nowIso);
    nodes.push(
      {
        id: `project:${name}`,
        kind: "project",
        label: name,
        state: "ok",
        needs_you: view.needs_me.filter(
          (item) => item.id.startsWith("ticket:") && ownerOf(item.id) === name,
        ).length,
      },
      {
        id: `chief:${name}`,
        kind: "chief",
        label: `Master Chief ${name}`,
        state: seen === "unavailable" ? "unavailable" : (seen?.state ?? "missing"),
        needs_you: 0,
      },
    );
    edges.push([`project:${name}`, `chief:${name}`]);
  }

  const runs = readRuns(now.getTime());
  for (const { state: finalState, events } of runs) {
    const runId = `run:${finalState.run}`;
    const known = events.filter((event) => Date.parse(event.time) <= cutoff);
    const state = known.length > 0 ? deriveState(known) : null;
    const gate = state ? waitingGate(state) : "none";
    nodes.push({
      id: runId,
      kind: "run",
      label: finalState.ticket.id,
      state: !state ? "not_started" : gate !== "none" ? "waiting" : state.phase,
      needs_you: live
        ? needsYouOfOwner(["gate", "mr", "retro", "agent"], finalState.run)
        : gate !== "none"
          ? 1
          : 0,
    });
    edges.push([`chief:${finalState.project}`, runId]);
    if (!state) continue;

    for (const step of state.steps) {
      nodes.push({
        id: `step:${state.run}:${step.id}`,
        kind: "step",
        label: step.id,
        state: step.status,
        needs_you: 0,
      });
      edges.push([runId, `step:${state.run}:${step.id}`]);
    }
    const labels = new Map(
      view.runs
        .find((candidate) => candidate.run === state.run)
        ?.merge_requests.map((mergeRequest) => [mergeRequest.url, mergeRequest.label]) ?? [],
    );
    for (const mergeRequest of state.merge_requests) {
      const seen = stateAt(history, `ci:${mergeRequest.url}`, time, nowIso);
      const ci =
        seen === "unavailable" && !live ? "unavailable" : (seen as { state: string } | null)?.state;
      nodes.push({
        id: `mr:${mergeRequest.url}`,
        kind: "mr",
        label: labels.get(mergeRequest.url) ?? `#${mergeRequest.number}`,
        state: typeof ci === "string" ? ci : "unknown",
        needs_you: 0,
      });
      edges.push([runId, `mr:${mergeRequest.url}`]);
    }
  }

  const agentNodes: MapNode[] = [];
  if (live) {
    for (const run of view.runs.filter((candidate) => candidate.open)) {
      // A failed Orca reader lists no agents: show one unknown agent, never a live or dead one.
      if (!run.agents_known)
        agentNodes.push({
          id: `agent:${run.run}:run lead`,
          kind: "agent",
          label: "run lead",
          state: "unknown",
          needs_you: 0,
        });
      for (const agent of run.agents) {
        const id = `agent:${run.run}:${agent.terminal ?? agent.role}`;
        agentNodes.push({
          id,
          kind: "agent",
          label: agent.title,
          state: agent.liveness,
          needs_you: view.needs_me.filter((item) => item.id === id).length,
        });
      }
    }
  } else {
    const keys = new Set(
      history.flatMap((event) => (event.key?.startsWith("agent:") ? [event.key] : [])),
    );
    for (const key of keys) {
      const seen = stateAt(history, key, time, nowIso);
      if (seen === null) continue;
      agentNodes.push({
        id: key,
        kind: "agent",
        label: key.split(":").slice(2).join(":"),
        state: seen === "unavailable" ? "unavailable" : seen.state,
        needs_you: 0,
      });
    }
  }
  const runIds = new Set(nodes.filter((node) => node.kind === "run").map((node) => node.id));
  for (const node of agentNodes) {
    nodes.push(node);
    const parent = `run:${node.id.split(":")[1]}`;
    if (runIds.has(parent)) edges.push([parent, node.id]);
  }

  const events: MapReplayEvent[] = [];
  if (view.last_seen) {
    const after = Date.parse(view.last_seen);
    const inRange = (isoTime: string) =>
      Date.parse(isoTime) > after && Date.parse(isoTime) <= now.getTime();
    for (const { state, events: runEvents } of runs)
      for (const event of runEvents.filter((candidate) => inRange(candidate.time)))
        events.push({
          time: event.time,
          kind: event.type,
          run: state.run,
          label: event.type,
        });
    for (const event of history.filter(
      (candidate) => candidate.type === "state.changed" && inRange(candidate.time),
    ))
      events.push({
        time: event.time,
        kind: event.type,
        run: event.key?.startsWith("agent:") ? ownerOf(event.key) : null,
        label: `${event.key} ${event.state}`,
      });
    events.sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  }

  return {
    at: time,
    replay: {
      ...(view.last_seen ? { from: view.last_seen } : {}),
      to: nowIso,
      events,
    },
    nodes,
    edges,
  };
}
