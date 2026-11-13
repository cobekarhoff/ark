import { createContext, useContext } from "react";
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
const dayFormat = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short" });
/** True when the range crosses a local midnight: its clock labels then need a date. */
export const spansDays = (range: Range) =>
  dayFormat.format(range.start) !== dayFormat.format(range.end);
export const clockText = (time: number, seconds = false, dated = false) => {
  const text = (seconds ? clockSeconds : clock).format(time);
  return dated ? `${dayFormat.format(time)} ${text}` : text;
};

/** True when the run spans days: every clock label of the tab then carries its date. */
export const DatedContext = createContext(false);
export const useClockText = () => {
  const dated = useContext(DatedContext);
  return (time: number) => clockText(time, true, dated);
};

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

// ---------- replay ----------

/**
 * The conversation as it was at `playhead`: later messages, events and answers are gone, and a question
 * answered after the playhead is waiting again. Spans are kept: the trace dims what follows the playhead.
 */
export function atPlayhead(conversation: RunConversation, playhead: number): RunConversation {
  const before = (iso: string | null) => iso !== null && Date.parse(iso) <= playhead;
  return {
    ...conversation,
    messages: conversation.messages.filter((message) => sentAt(message) <= playhead),
    events: conversation.events?.filter((event) => before(event.time)),
    answers: conversation.answers.filter((answer) => before(answer.time)),
    questions: conversation.questions.map((question) =>
      before(question.answered) ? question : { ...question, answered: null },
    ),
  };
}

// ---------- project view (Runs page, Conversation mode) ----------

/** One run line of the metro map. `close` is null for an open run: its line stays open. */
export type ProjectRun = {
  run: string;
  conversation: RunConversation;
  start: number;
  close: number | null;
};

const lastKnown = (conversation: RunConversation): number =>
  Math.max(
    ...finite([
      ...conversation.messages.map(sentAt),
      ...conversation.spans.flatMap((span) => [
        Date.parse(span.start),
        span.end === null ? NaN : Date.parse(span.end),
      ]),
      ...conversation.answers.map((answer) => Date.parse(answer.time)),
    ]),
  );

/**
 * The runs of the scoped project, oldest start first. `openStarted` maps each open run of the snapshot to
 * its `started_at` (null while the snapshot is unknown: a run is then open when a step has no end). A run
 * is open when the snapshot lists it; otherwise it closed at its last known time. The reply has no close
 * event, and a run with no message in the window is not in it at all.
 */
export function projectRuns(
  runs: readonly RunConversation[],
  project: string | null,
  openStarted: ReadonlyMap<string, string> | null,
): ProjectRun[] {
  return runs
    .filter((conversation) => project === null || conversation.project === project)
    .map((conversation): ProjectRun => {
      const known = lastKnown(conversation);
      const snapshotStart = Date.parse(openStarted?.get(conversation.run) ?? "");
      const times = finite([
        snapshotStart,
        ...conversation.spans.map((span) => Date.parse(span.start)),
        ...conversation.messages.map(sentAt),
        ...conversation.answers.map((answer) => Date.parse(answer.time)),
      ]);
      const open = openStarted
        ? openStarted.has(conversation.run)
        : conversation.spans.some((span) => span.end === null);
      return {
        run: conversation.run,
        conversation,
        start: times.length ? Math.min(...times) : 0,
        close: open || !Number.isFinite(known) ? null : known,
      };
    })
    .sort((left, right) => left.start - right.start || left.run.localeCompare(right.run));
}

/** The window of the project view: the earliest start to the latest known time, at least one minute wide. */
export function projectRange(
  runs: readonly ProjectRun[],
  other: readonly ConversationMessage[],
): Range {
  const times = finite([
    ...runs.flatMap((run) => [run.start, run.close ?? lastKnown(run.conversation)]),
    ...other.map(sentAt),
  ]);
  if (times.length === 0) return { start: 0, end: 60_000 };
  const start = Math.min(...times);
  const end = Math.max(...times);
  return { start, end: end > start ? end : start + 60_000 };
}

/** A message with a usable time. One without (`created_at` null) has no position on any axis and no count. */
const timed = (message: ConversationMessage) => Number.isFinite(sentAt(message));
const touchesChief = (message: ConversationMessage) =>
  message.from === "chief" || message.to === "chief";

// -- filters --

export type ProjectFilter = {
  /** Chosen types; empty is all. */
  types: ReadonlySet<string>;
  /** One run, or null for every run. */
  run: string | null;
  /** Matches the subject only: the project reply holds no message body. */
  search: string;
};
export const noFilter: ProjectFilter = { types: new Set(), run: null, search: "" };

/**
 * The same runs with only the messages (and their questions) that pass the filter. Master Chief's line,
 * the answers and the run lines stay. A run filter drops every other run and the messages of no run.
 */
export function filterProject(
  runs: readonly ProjectRun[],
  other: readonly ConversationMessage[],
  filter: ProjectFilter,
): { runs: ProjectRun[]; other: ConversationMessage[] } {
  const query = filter.search.trim().toLowerCase();
  const passes = (message: ConversationMessage) =>
    (filter.types.size === 0 || filter.types.has(typeOf(message))) &&
    (query === "" || (message.subject ?? "").toLowerCase().includes(query));
  if (filter.types.size === 0 && query === "" && filter.run === null)
    return { runs: [...runs], other: [...other] };
  return {
    runs: runs
      .filter((run) => filter.run === null || run.run === filter.run)
      .map((run) => {
        const messages = run.conversation.messages.filter(passes);
        const ids = new Set(messages.map((message) => message.id));
        return {
          ...run,
          conversation: {
            ...run.conversation,
            messages,
            questions: run.conversation.questions.filter((question) => ids.has(question.id)),
          },
        };
      }),
    other: filter.run === null ? other.filter(passes) : [],
  };
}

/** The message types of the project, for the chips, with their counts. */
export function projectTypes(
  runs: readonly ProjectRun[],
  other: readonly ConversationMessage[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const message of [...runs.flatMap((run) => run.conversation.messages), ...other])
    counts.set(typeOf(message), (counts.get(typeOf(message)) ?? 0) + 1);
  return counts;
}

// -- map: in order, not to scale --

/**
 * The order axis: every distinct time the map draws gets the next slot, so the map is in order and not to
 * scale. `at` is the slot of a time; a time the axis does not hold is a bug, not a guess.
 */
export type Axis = { times: number[]; at: (time: number) => number };

export function buildAxis(
  runs: readonly ProjectRun[],
  other: readonly ConversationMessage[],
): Axis {
  const set = new Set<number>();
  const add = (time: number) => Number.isFinite(time) && set.add(time);
  for (const run of runs) {
    add(run.start);
    if (run.close !== null) add(run.close);
    for (const message of run.conversation.messages) add(sentAt(message));
    for (const answer of run.conversation.answers) add(Date.parse(answer.time));
    for (const question of run.conversation.questions) {
      add(Date.parse(question.sent ?? ""));
      add(Date.parse(question.delivered ?? ""));
      add(Date.parse(question.answered ?? ""));
    }
  }
  for (const message of other) add(sentAt(message));
  const times = [...set].sort((left, right) => left - right);
  const slot = new Map(times.map((time, index) => [time, index]));
  return { times, at: (time) => slot.get(time) ?? NaN };
}

export type Bead = {
  id: string;
  /** The owning run, or null for a message of no run. */
  run: string | null;
  message: ConversationMessage;
  time: number;
  /** A message to or from Master Chief touches the central line. */
  onChief: boolean;
  /** A question or an escalation to or from Master Chief is a thick spur. */
  spur: boolean;
};

/** Every message with a time, in time order. */
export function buildBeads(
  runs: readonly ProjectRun[],
  other: readonly ConversationMessage[],
): Bead[] {
  const bead = (run: string | null, message: ConversationMessage): Bead => ({
    id: message.id,
    run,
    message,
    time: sentAt(message),
    onChief: touchesChief(message),
    spur: touchesChief(message) && (message.type === "question" || message.type === "escalation"),
  });
  return [
    ...runs.flatMap((run) =>
      run.conversation.messages.filter(timed).map((message) => bead(run.run, message)),
    ),
    ...other.filter(timed).map((message) => bead(null, message)),
  ].sort((left, right) => left.time - right.time);
}

/**
 * Beads of the central line grouped into fixed buckets of `bucket` graph pixels (`step` pixels a slot): at Fit
 * a crowd becomes several clusters along the line, at 100% (`zoomed`) every bead stands alone. Buckets are
 * fixed, not chained, so a steady stream does not merge into one cluster.
 */
export function clusterBeads(
  beads: readonly Bead[],
  axis: Axis,
  zoomed: boolean,
  step: number,
  bucket = 24,
): Bead[][] {
  const chief = beads.filter((bead) => bead.onChief);
  if (zoomed) return chief.map((bead) => [bead]);
  const clusters: Bead[][] = [];
  let last = NaN;
  for (const bead of chief) {
    const key = Math.floor((axis.at(bead.time) * step) / bucket);
    if (key === last) clusters.at(-1)!.push(bead);
    else clusters.push([bead]);
    last = key;
  }
  return clusters;
}

export type Band = { question: string; run: string; start: number; end: number; open: boolean };

/**
 * The time each run waited for the human: a question or escalation to Master Chief, from delivery (sent,
 * when delivery is not recorded) to its answer. An unanswered one runs to `playhead`. A question not yet
 * sent at the playhead has no band; one answered after it is waiting again.
 */
export function waitingBands(runs: readonly ProjectRun[], playhead: number = Infinity): Band[] {
  return runs.flatMap((run) => {
    const toChief = new Set(
      run.conversation.messages.filter((m) => m.to === "chief").map((m) => m.id),
    );
    return run.conversation.questions.flatMap((question): Band[] => {
      if (!toChief.has(question.id)) return [];
      const start = Date.parse(question.delivered ?? question.sent ?? "");
      if (!Number.isFinite(start) || start > playhead) return [];
      const answered = Date.parse(question.answered ?? "");
      const done = Number.isFinite(answered) && answered <= playhead;
      return [
        {
          question: question.id,
          run: run.run,
          start,
          end: done ? answered : playhead,
          open: !done,
        },
      ];
    });
  });
}

// -- replay --

/** The send times that count, for `useReplay`: messages with no time are left out. */
export const sentTimes = (
  runs: readonly ProjectRun[],
  other: readonly ConversationMessage[],
): number[] =>
  finite([...runs.flatMap((run) => run.conversation.messages), ...other].map(sentAt)).sort(
    (left, right) => left - right,
  );

/** Density of messages in `bins` equal slices of the range, for the strip. */
export function density(times: readonly number[], range: Range, bins: number): number[] {
  const out = Array.from({ length: bins }, () => 0);
  const width = range.end - range.start;
  for (const time of times)
    if (time >= range.start && time <= range.end)
      out[Math.min(bins - 1, Math.floor(((time - range.start) / width) * bins))]++;
  return out;
}

// -- Now panel --

export type Now = {
  /** Open at the playhead; a run between two steps is live. */
  live: { run: string; step: string | null }[];
  messages: number;
  answers: number;
  /** Newest first. */
  latest: ConversationMessage[];
};

/** The numbers of the scrubber time, not of the window. */
export function nowAt(
  runs: readonly ProjectRun[],
  other: readonly ConversationMessage[],
  playhead: number,
  latestCount = 5,
): Now {
  const live = runs
    .filter((run) => run.start <= playhead && (run.close === null || playhead <= run.close))
    .map((run) => {
      const span = run.conversation.spans.find(
        (s) => Date.parse(s.start) <= playhead && (s.end === null || playhead < Date.parse(s.end)),
      );
      return { run: run.run, step: span?.step ?? null };
    });
  const messages = [...runs.flatMap((run) => run.conversation.messages), ...other]
    .filter((message) => sentAt(message) <= playhead)
    .sort((left, right) => sentAt(right) - sentAt(left));
  return {
    live,
    messages: messages.length,
    answers: runs.reduce(
      (sum, run) =>
        sum + run.conversation.answers.filter((a) => Date.parse(a.time) <= playhead).length,
      0,
    ),
    latest: messages.slice(0, latestCount),
  };
}

/** The fractional slot of any time on the axis (a span start or the playhead holds no slot of its own). */
export function slotOf(axis: Axis, time: number): number {
  const { times } = axis;
  if (times.length === 0) return 0;
  if (time <= times[0]) return 0;
  if (time >= times[times.length - 1]) return times.length - 1;
  let low = 0;
  let high = times.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (times[middle] <= time) low = middle;
    else high = middle;
  }
  return low + (time - times[low]) / (times[high] - times[low]);
}
