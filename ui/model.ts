import type { createHub } from "../cli/hub/state.ts";
import type { Agent, Item, ItemKind } from "../cli/hub/types.ts";

export type HubState = ReturnType<ReturnType<typeof createHub>["state"]>;
export type RunView = HubState["runs"][number];
export type Selection = { type: "need" | "run" | "agent"; id: string } | null;

/** Item kinds as the design shows them: label, color tone, button text and action key. */
export const kinds: Record<ItemKind, { label: string; tone: string; short: string; key: string }> =
  {
    gate: { label: "Gate", tone: "needs", short: "Plannotator", key: "p" },
    mr: { label: "Merge request", tone: "ok", short: "Open MR", key: "o" },
    question: { label: "Question", tone: "waiting", short: "Answer", key: "i" },
    agent: { label: "Agent", tone: "bad", short: "Orca", key: "o" },
    ticket: { label: "Approval", tone: "working", short: "Plannotator", key: "p" },
    retro: { label: "Retro", tone: "idle", short: "Retro", key: "r" },
  };

const stepTone = {
  succeeded: "ok",
  running: "working",
  pending: "idle",
  failed: "bad",
  stopped: "idle",
};
export const stepToneOf = (status: string) => stepTone[status as keyof typeof stepTone] ?? "idle";

export const agentTone = (agent: Agent) =>
  agent.liveness === "live"
    ? "working"
    : ["stuck", "dead", "exited"].includes(agent.liveness)
      ? "bad"
      : "idle";

export const minutesSince = (since: string, now: number) =>
  Math.max(0, Math.floor((now - Date.parse(since)) / 60_000));

/** Amber after 30 minutes, red after 2 hours. */
export const heat = (minutes: number) => (minutes >= 120 ? "hot" : minutes >= 30 ? "warm" : "");

export const duration = (minutes: number) =>
  minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;

export const usd = (value: number | "unknown") =>
  value === "unknown" ? "?" : `$${value.toFixed(2)}`;

export type Filter = string;
export const otherFilter = ":other";

/** Projects the hub knows; items of any other project belong to "Other". */
export const inFilter = (project: string, filter: Filter, known: string[]) =>
  filter === "all" || (filter === otherFilter ? !known.includes(project) : project === filter);

export const needRun = (item: Item, runs: RunView[]) =>
  item.ticket === null
    ? undefined
    : runs.find((run) => run.open && run.ticket.id === item.ticket && run.project === item.project);
