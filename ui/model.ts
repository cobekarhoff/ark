import type { createHub } from "../cli/hub/state.ts";
import { kindLabels, type Agent, type Item, type ItemKind } from "../cli/hub/types.ts";

export type HubState = ReturnType<ReturnType<typeof createHub>["state"]>;
export type RunView = HubState["runs"][number];
export type Selection = { type: "need" | "run" | "agent"; id: string } | null;

/** Item kinds as the design shows them: label, color tone, button text and action key. */
export const kinds: Record<ItemKind, { label: string; tone: string; short: string; key: string }> =
  {
    gate: { label: kindLabels.gate, tone: "needs", short: "Plannotator", key: "p" },
    mr: { label: kindLabels.mr, tone: "ok", short: "Open MR", key: "o" },
    question: { label: kindLabels.question, tone: "waiting", short: "Answer", key: "i" },
    agent: { label: kindLabels.agent, tone: "bad", short: "Orca", key: "o" },
    ticket: { label: kindLabels.ticket, tone: "working", short: "Plannotator", key: "p" },
    retro: { label: kindLabels.retro, tone: "idle", short: "Retro", key: "r" },
  };

const stepTone = {
  succeeded: "ok",
  running: "working",
  pending: "idle",
  failed: "bad",
  stopped: "idle",
};
export const stepToneOf = (status: string) => stepTone[status as keyof typeof stepTone] ?? "idle";

export const agentTone = (agent: Pick<Agent, "liveness">) =>
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

/** `HH:MM today`, else `Mon D HH:MM`, in local time. */
export function notificationTime(time: string, now: number): string {
  const date = new Date(time);
  const clock = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return date.toDateString() === new Date(now).toDateString()
    ? `${clock} today`
    : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${clock}`;
}

export type RunDetail = HubState["details"][string];

/** Seconds as `45s`, `12m` or `1h 12m`; "unknown" stays `?`. */
export const span = (seconds: number | "unknown") =>
  seconds === "unknown"
    ? "?"
    : seconds < 60
      ? `${Math.round(seconds)}s`
      : duration(Math.floor(seconds / 60));

export const costText = (cost: { usd: number | "unknown" } | "unknown") =>
  cost === "unknown" ? "?" : usd(cost.usd);

const splitLabels: Record<keyof RunDetail["time_split"], [string, string]> = {
  unavailable: ["Unavailable", "before the hub began collecting"],
  working: ["Working", ""],
  waiting_human: ["Waiting on you", ""],
  waiting_ci_or_paused: ["Waiting on CI or paused", ""],
  stalled: ["Stalled", ""],
};
const splitTones: Record<keyof RunDetail["time_split"], string> = {
  unavailable: "na",
  working: "working",
  waiting_human: "needs",
  waiting_ci_or_paused: "waiting",
  stalled: "bad",
};

/** Time split parts in the design's order; percentages are of the whole wall time. */
export function splitParts(split: RunDetail["time_split"]) {
  const total = Object.values(split).reduce((sum, seconds) => sum + seconds, 0);
  return (Object.keys(splitLabels) as (keyof RunDetail["time_split"])[]).map((key) => ({
    key,
    label: splitLabels[key][0],
    note: splitLabels[key][1],
    tone: splitTones[key],
    seconds: split[key],
    percent: total > 0 ? Math.round((split[key] / total) * 100) : 0,
  }));
}

const phaseLabels: Record<string, string> = {
  awaiting_criteria: "Gate: criteria",
  awaiting_strategy: "Gate: strategy",
  planning: "Plan",
  building: "Build",
  escalation: "Gate: escalation",
  merge_requests_open: "Merge requests",
  closed: "Closed",
};
export const phaseLabel = (phase: string) => phaseLabels[phase] ?? phase;

/** One bar segment per phase change; the last one runs to the end of the run or to now. */
export function phaseBars(detail: RunDetail) {
  const start = Date.parse(detail.timeline[0]?.at ?? "");
  const end = start + detail.wall_seconds * 1000;
  return detail.timeline.map((row, i) => {
    const to = i + 1 < detail.timeline.length ? Date.parse(detail.timeline[i + 1].at) : end;
    return {
      phase: row.phase,
      label: phaseLabel(row.phase),
      gate: row.phase.startsWith("awaiting_") || row.phase === "escalation",
      current: i + 1 === detail.timeline.length && row.phase !== "closed",
      seconds: Math.max(0, (to - Date.parse(row.at)) / 1000),
    };
  });
}

/** Step ids in columns: a step sits one column right of its deepest `needs`. */
export function stepColumns(steps: RunDetail["steps"]) {
  const depth = new Map<string, number>();
  const visit = (id: string, trail: string[]): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const step = steps.find((candidate) => candidate.id === id);
    if (!step || trail.includes(id)) return 0;
    const level = Math.max(-1, ...step.needs.map((need) => visit(need, [...trail, id]))) + 1;
    depth.set(id, level);
    return level;
  };
  const columns: RunDetail["steps"][] = [];
  for (const step of steps) (columns[visit(step.id, [])] ??= []).push(step);
  return columns.filter(Boolean);
}
