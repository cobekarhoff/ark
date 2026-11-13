import type { ArkEvent } from "../../cli/events.ts";
import type {
  ConversationAgent,
  ConversationMessage,
  RoleGroup,
  RunConversation,
} from "../conversation.ts";

export const roleGroups: RoleGroup[] = ["Planning", "Implementers", "Validators", "Reviewers"];
/** The narrowest window the trace zooms to. */
export const minimumViewMs = 5_000;
/** Ticks closer than this share of the view are one cluster. */
const clusterShare = 0.012;
/** A run of this many Ark events in a row is one folded line. */
export const foldEventsAt = 3;

export type Range = { start: number; end: number };

export const sentAt = (message: ConversationMessage): number =>
  message.created_at === null ? NaN : Date.parse(message.created_at);

const finite = (values: number[]) => values.filter((value) => Number.isFinite(value));

/** The span of the run: first to last known time. An open step or an unanswered wait ends at the last known time. */
export function runRange(conversation: RunConversation): Range {
  const times = finite([
    ...conversation.messages.map(sentAt),
    ...conversation.spans.flatMap((span) => [
      Date.parse(span.start),
      span.end === null ? NaN : Date.parse(span.end),
    ]),
    ...conversation.answers.map((answer) => Date.parse(answer.time)),
    ...(conversation.events ?? []).map((event) => Date.parse(event.time)),
  ]);
  if (times.length === 0) return { start: 0, end: 60_000 };
  const start = Math.min(...times);
  const end = Math.max(...times);
  return { start, end: end > start ? end : start + 60_000 };
}

/** A window inside `full`, at least `minimumViewMs` wide, moved (not shrunk) to stay inside. */
export function clampView(view: Range, full: Range): Range {
  const width = Math.min(Math.max(view.end - view.start, minimumViewMs), full.end - full.start);
  const start = Math.min(Math.max(view.start, full.start), full.end - width);
  return { start, end: start + width };
}

export type Row = {
  key: string;
  label: string;
  kind: "chief" | "lead" | "group" | "worker" | "other";
  group: RoleGroup | null;
  /** Workers in a group row. */
  count: number;
};
export type Bar = {
  row: string;
  kind: "active" | "idle" | "waiting";
  start: number;
  end: number;
  /** What hover names: the step, or the wait. */
  label: string;
};
export type Tick = {
  id: string;
  time: number;
  type: string | null;
  row: string;
  toRow: string;
};

export type Trace = {
  rows: Row[];
  bars: Bar[];
  ticks: Tick[];
  rowOfAgent: (agentId: string) => string;
};

/** Merges overlapping intervals, sorted. */
function union(intervals: Range[]): Range[] {
  const merged: Range[] = [];
  for (const interval of [...intervals].sort((left, right) => left.start - right.start)) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

/** The rows, bars and ticks of the trace. `expanded` groups show one row per worker. */
export function buildTrace(
  conversation: RunConversation,
  range: Range,
  expanded: ReadonlySet<RoleGroup>,
): Trace {
  const agents = new Map(conversation.agents.map((agent) => [agent.id, agent]));
  const workerKey = (span: RunConversation["spans"][number]) =>
    span.agent ??
    conversation.agents.find((agent) => agent.kind === "worker" && agent.step === span.step)?.id ??
    `step:${span.step}`;
  const workerLabel = new Map<string, string>();
  const workersOf = new Map<string, Set<string>>();
  const addWorker = (group: RoleGroup | null, key: string, label: string) => {
    const bucket = group ?? "other";
    workersOf.set(bucket, (workersOf.get(bucket) ?? new Set()).add(key));
    if (!workerLabel.has(key)) workerLabel.set(key, label);
  };
  for (const span of conversation.spans) addWorker(span.group, workerKey(span), span.step);
  for (const agent of conversation.agents)
    if (agent.kind === "worker")
      addWorker(agent.group, agent.id, agent.step ?? agent.title ?? agent.id);

  const needsOther =
    workersOf.has("other") ||
    conversation.agents.some((agent) => agent.kind === "session" || agent.kind === "unmapped");
  const rows: Row[] = [
    { key: "chief", label: "Master Chief", kind: "chief", group: null, count: 0 },
    { key: "lead", label: "Run lead", kind: "lead", group: null, count: 0 },
  ];
  for (const group of roleGroups) {
    const keys = [...(workersOf.get(group) ?? [])];
    rows.push({ key: `group:${group}`, label: group, kind: "group", group, count: keys.length });
    if (expanded.has(group))
      for (const key of keys)
        rows.push({
          key: `worker:${key}`,
          label: workerLabel.get(key) ?? key,
          kind: "worker",
          group,
          count: 0,
        });
  }
  if (needsOther)
    rows.push({
      key: "other",
      label: "Other",
      kind: "other",
      group: null,
      count: workersOf.get("other")?.size ?? 0,
    });

  const rowOfAgent = (agentId: string): string => {
    const agent: ConversationAgent | undefined = agents.get(agentId);
    if (!agent) return "other";
    if (agent.kind === "chief") return "chief";
    if (agent.kind === "run_lead") return "lead";
    if (agent.kind === "worker" && agent.group)
      return expanded.has(agent.group) ? `worker:${agent.id}` : `group:${agent.group}`;
    return "other";
  };
  const rowOfSpan = (span: RunConversation["spans"][number]) =>
    span.group === null
      ? "other"
      : expanded.has(span.group)
        ? `worker:${workerKey(span)}`
        : `group:${span.group}`;

  const bars: Bar[] = conversation.spans.map((span) => ({
    row: rowOfSpan(span),
    kind: "active",
    start: Date.parse(span.start),
    end: span.end === null ? range.end : Date.parse(span.end),
    label: span.step,
  }));

  // The run lead waits on the human from the question it sent Master Chief until the answer; idle is
  // every other time with no step running.
  const waits: Range[] = [];
  for (const question of conversation.questions) {
    const message = conversation.messages.find((candidate) => candidate.id === question.id);
    if (
      !message ||
      agents.get(message.from)?.kind !== "run_lead" ||
      agents.get(message.to)?.kind !== "chief" ||
      question.sent === null
    )
      continue;
    const start = Date.parse(question.sent);
    const end = question.answered === null ? range.end : Date.parse(question.answered);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) waits.push({ start, end });
  }
  for (const wait of waits)
    bars.push({ row: "lead", kind: "waiting", ...wait, label: "waiting on you" });
  const busy = union([
    ...waits,
    ...bars.filter((bar) => bar.kind === "active").map(({ start, end }) => ({ start, end })),
  ]);
  let cursor = range.start;
  for (const interval of [...busy, { start: range.end, end: range.end }]) {
    if (interval.start > cursor)
      bars.push({
        row: "lead",
        kind: "idle",
        start: cursor,
        end: interval.start,
        label: "idle",
      });
    cursor = Math.max(cursor, interval.end);
  }

  const ticks = conversation.messages
    .filter((message) => Number.isFinite(sentAt(message)))
    .map((message): Tick => ({
      id: message.id,
      time: sentAt(message),
      type: message.type,
      row: rowOfAgent(message.from),
      toRow: rowOfAgent(message.to),
    }))
    .sort((left, right) => left.time - right.time);
  return { rows, bars, ticks, rowOfAgent };
}

/** Consecutive ticks closer than a share of the view, in time order. Ticks outside the view are dropped. */
export function clusterTicks(ticks: Tick[], view: Range): Tick[][] {
  const gap = (view.end - view.start) * clusterShare;
  const clusters: Tick[][] = [];
  for (const tick of ticks) {
    if (tick.time < view.start || tick.time > view.end) continue;
    const last = clusters.at(-1);
    if (last && tick.time - last.at(-1)!.time <= gap) last.push(tick);
    else clusters.push([tick]);
  }
  return clusters;
}

const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const clockSeconds = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
export const clockText = (time: number, seconds = false) =>
  (seconds ? clockSeconds : clock).format(time);

// ---------- feed ----------

export type FeedItem =
  | { kind: "message"; time: number; message: ConversationMessage; replies: ConversationMessage[] }
  | { kind: "events"; time: number; events: ArkEvent[] };

export const typeOf = (message: ConversationMessage) => message.type ?? "other";
export const eventsChip = "Ark events";

const matches = (message: ConversationMessage, query: string) =>
  `${message.subject ?? ""}\n${message.body ?? ""}`.toLowerCase().includes(query);

/**
 * The feed, oldest first. A thread is its root with the later messages of the thread as replies; it shows
 * when any of its messages passes the chips and the search. Ark events are shown only when no search is
 * typed and the chips allow them.
 */
export function buildFeed(
  conversation: RunConversation,
  active: ReadonlySet<string>,
  search: string,
): FeedItem[] {
  const query = search.trim().toLowerCase();
  const messages = [...conversation.messages].sort(
    (left, right) =>
      (Number.isFinite(sentAt(left)) ? sentAt(left) : -Infinity) -
      (Number.isFinite(sentAt(right)) ? sentAt(right) : -Infinity),
  );
  const ids = new Set(messages.map((message) => message.id));
  const rootOf = new Map<string, string>();
  const replies = new Map<string, ConversationMessage[]>();
  const roots: ConversationMessage[] = [];
  for (const message of messages) {
    const thread = message.thread_id;
    if (thread !== null && !rootOf.has(thread))
      rootOf.set(thread, ids.has(thread) ? thread : message.id);
    if (thread !== null && rootOf.get(thread) !== message.id)
      replies.set(rootOf.get(thread)!, [...(replies.get(rootOf.get(thread)!) ?? []), message]);
    else roots.push(message);
  }
  const passes = (message: ConversationMessage) =>
    (active.size === 0 || active.has(typeOf(message))) && (query === "" || matches(message, query));
  const items: FeedItem[] = roots.flatMap((message) => {
    const thread = replies.get(message.id) ?? [];
    return [message, ...thread].some(passes)
      ? [
          {
            kind: "message" as const,
            time: Number.isFinite(sentAt(message)) ? sentAt(message) : -Infinity,
            message,
            replies: thread,
          },
        ]
      : [];
  });
  if (query === "" && (active.size === 0 || active.has(eventsChip)))
    for (const event of conversation.events ?? [])
      items.push({ kind: "events", time: Date.parse(event.time), events: [event] });
  // Stable: a message and an event at one time keep message first.
  items.sort((left, right) => left.time - right.time);
  // Events in a row join, so the view can fold a run of three or more.
  const joined: FeedItem[] = [];
  for (const item of items) {
    const last = joined.at(-1);
    if (item.kind === "events" && last?.kind === "events") last.events.push(...item.events);
    else joined.push(item);
  }
  return joined;
}
