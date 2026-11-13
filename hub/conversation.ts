import { stepWindows, type ArkEvent } from "../cli/events.ts";

/** One Orca inbox message. A field Orca did not send stays null: nothing is defaulted, least of all `delivered_at`. */
export type InboxMessage = {
  id: string;
  type: string | null;
  from_handle: string | null;
  to_handle: string | null;
  subject: string | null;
  body: string | null;
  thread_id: string | null;
  run_id: string | null;
  payload: Record<string, unknown> | null;
  created_at: string | null;
  delivered_at: string | null;
};

/** What the Orca lists say about the handles of one agent. `step` and `role` come from the task title (`stepTask`, `roleOfTask`). */
export type DirectoryWorker = {
  arkRun: string;
  handles: string[];
  step: string | null;
  role: string;
  title: string;
};
export type Directory = {
  /** Master Chief: its Orca Run id and every handle it answers to. */
  chiefs: { orcaRun: string; handles: string[] }[];
  /** The run lead of each Ark run: its Orca Run id and every handle it answers to. */
  leads: { arkRun: string; orcaRun: string; handles: string[] }[];
  workers: DirectoryWorker[];
};
export type ConversationInput = {
  /** Changes on every new inbox read: the worker thread keeps the input it holds for one version. */
  version: string;
  messages: InboxMessage[];
  directory: Directory;
};
export type RunEvents = {
  run: string;
  project: string;
  events: ArkEvent[];
};
export type ConversationQuery =
  | { kind: "run"; run: string }
  | { kind: "project"; since: number; until: number };

export type AgentKind = "chief" | "run_lead" | "worker" | "session" | "unmapped";
export type RoleGroup = "Planning" | "Implementers" | "Validators" | "Reviewers";
export type ConversationAgent = {
  id: string;
  kind: AgentKind;
  /** The raw handle of a session or unmapped agent. */
  handle: string | null;
  step: string | null;
  role: string | null;
  group: RoleGroup | null;
  title: string | null;
};
export type ConversationMessage = Omit<InboxMessage, "body" | "payload"> & {
  from: string;
  to: string;
  body?: string | null;
  payload?: Record<string, unknown> | null;
};
export type ConversationQuestion = {
  id: string;
  sent: string | null;
  /** Null when Orca did not record it: never the sent time. */
  delivered: string | null;
  answered: string | null;
  /** Seconds from sent to delivered, or "not recorded". */
  pickup_seconds: number | "not recorded";
};
export type ConversationSpan = {
  step: string;
  role: string;
  group: RoleGroup | null;
  agent: string | null;
  start: string;
  /** Null for a step that started and has no `step.finished` yet (or ever: a crash). */
  end: string | null;
};
export type RunConversation = {
  run: string;
  project: string;
  agents: ConversationAgent[];
  spans: ConversationSpan[];
  /** Every Ark event of the run (run route only). */
  events?: ArkEvent[];
  answers: { time: string; gate: string | null; answer: string | null }[];
  questions: ConversationQuestion[];
  messages: ConversationMessage[];
};
export type RunAnswer = RunConversation | null;
export type ProjectAnswer = {
  runs: RunConversation[];
  /** Messages that no Ark run owns (Master Chief with a session, unknown handles): never dropped. */
  other: { agents: ConversationAgent[]; messages: ConversationMessage[] };
};
/** What the conversation routes send: the read's state, then the answer. */
export type ConversationReply = { truncated: boolean; stale: boolean; read_at: string } & (
  | RunConversation
  | ProjectAnswer
);

const planningRoles = new Set(["evaluator", "designer", "test-case-writer", "test-case-reviewer"]);
const groupOfRole = (role: string): RoleGroup | null =>
  planningRoles.has(role)
    ? "Planning"
    : role === "implementer"
      ? "Implementers"
      : role === "validator"
        ? "Validators"
        : role === "reviewer"
          ? "Reviewers"
          : null;

type Resolved = { agent: ConversationAgent; arkRun: string | null };
type Index = {
  byMessage: Map<string, { from: Resolved; to: Resolved; arkRuns: string[] }>;
  workersOf: Map<string, ConversationAgent[]>;
};

const dispatchHandle = (handle: string) => handle.replace(/^dispatch:/, "");

/** Maps every handle of every message to one agent. A handle that maps to nothing becomes an unmapped agent, never a dropped message. */
function indexOf(input: ConversationInput): Index {
  const { directory, messages } = input;
  const known = new Map<string, Resolved>();
  const chief: ConversationAgent = {
    id: "chief",
    kind: "chief",
    handle: null,
    step: null,
    role: "Master Chief",
    group: null,
    title: null,
  };
  const chiefHandles = new Set<string>();
  const add = (handle: string, resolved: Resolved) => {
    known.set(handle, resolved);
    known.set(dispatchHandle(handle), resolved);
    known.set(`dispatch:${dispatchHandle(handle)}`, resolved);
  };
  for (const { orcaRun, handles } of directory.chiefs)
    for (const handle of [`run:${orcaRun}`, ...handles]) {
      chiefHandles.add(handle);
      add(handle, { agent: chief, arkRun: null });
    }
  const orcaRunToArkRun = new Map<string, string>();
  for (const { arkRun, orcaRun, handles } of directory.leads) {
    orcaRunToArkRun.set(orcaRun, arkRun);
    const lead: ConversationAgent = {
      id: `lead:${arkRun}`,
      kind: "run_lead",
      handle: null,
      step: null,
      role: "run lead",
      group: null,
      title: null,
    };
    for (const handle of [`run:${orcaRun}`, ...handles]) add(handle, { agent: lead, arkRun });
  }
  const workersOf = new Map<string, ConversationAgent[]>();
  for (const worker of directory.workers) {
    const agent: ConversationAgent = {
      id: `worker:${worker.arkRun}:${worker.handles[0] ?? worker.title}`,
      kind: "worker",
      handle: null,
      step: worker.step,
      role: worker.role,
      group: groupOfRole(worker.role),
      title: worker.title,
    };
    workersOf.set(worker.arkRun, [...(workersOf.get(worker.arkRun) ?? []), agent]);
    for (const handle of worker.handles) add(handle, { agent, arkRun: worker.arkRun });
  }
  // A terminal that sent to Master Chief and is none of the above is a brainstorm or other session.
  const sentToChief = new Set(
    messages
      .filter((message) => message.to_handle !== null && chiefHandles.has(message.to_handle))
      .map((message) => message.from_handle),
  );
  const loose = new Map<string, Resolved>();
  const resolve = (handle: string | null): Resolved => {
    if (handle === null) handle = "";
    const found = known.get(handle) ?? known.get(dispatchHandle(handle));
    if (found) return found;
    let unknown = loose.get(handle);
    if (!unknown) {
      const session = handle.startsWith("term_") && sentToChief.has(handle);
      unknown = {
        agent: {
          id: `${session ? "session" : "unmapped"}:${handle}`,
          kind: session ? "session" : "unmapped",
          handle,
          step: null,
          role: null,
          group: null,
          title: null,
        },
        arkRun: null,
      };
      loose.set(handle, unknown);
    }
    return unknown;
  };

  const byMessage = new Map<string, { from: Resolved; to: Resolved; arkRuns: string[] }>();
  for (const message of messages) {
    const from = resolve(message.from_handle);
    const to = resolve(message.to_handle);
    const owned = [from.arkRun, to.arkRun].filter((run): run is string => run !== null);
    const viaRun = message.run_id ? orcaRunToArkRun.get(message.run_id) : undefined;
    const arkRuns = [...new Set(owned.length > 0 ? owned : viaRun ? [viaRun] : [])];
    byMessage.set(message.id, { from, to, arkRuns });
  }
  return { byMessage, workersOf };
}

const indexes = new WeakMap<ConversationInput, Index>();
const indexFor = (input: ConversationInput): Index => {
  let index = indexes.get(input);
  if (!index) {
    index = indexOf(input);
    indexes.set(input, index);
  }
  return index;
};

const timeOf = (value: string | null): number => (value === null ? NaN : Date.parse(value));

function runConversation(
  input: ConversationInput,
  index: Index,
  { run, project, events }: RunEvents,
  messages: InboxMessage[],
  withBodies: boolean,
): RunConversation {
  const agents = new Map<string, ConversationAgent>();
  const lead = input.directory.leads.find((candidate) => candidate.arkRun === run);
  if (lead)
    for (const message of input.messages) {
      const resolved = index.byMessage.get(message.id)!;
      if (resolved.from.agent.id === `lead:${run}`)
        agents.set(resolved.from.agent.id, resolved.from.agent);
      if (resolved.to.agent.id === `lead:${run}`)
        agents.set(resolved.to.agent.id, resolved.to.agent);
    }
  const workers = index.workersOf.get(run) ?? [];
  for (const worker of workers) agents.set(worker.id, worker);
  const view = messages.map((message): ConversationMessage => {
    const { from, to } = index.byMessage.get(message.id)!;
    for (const resolved of [from, to]) agents.set(resolved.agent.id, resolved.agent);
    const { body, payload, ...rest } = message;
    return {
      ...rest,
      from: from.agent.id,
      to: to.agent.id,
      ...(withBodies ? { body, payload } : {}),
    };
  });

  const answers = events
    .filter((event) => event.type === "gate.answered" && event.data.by === "human")
    .map((event) => ({
      time: event.time,
      gate: typeof event.data.gate === "string" ? event.data.gate : null,
      answer: typeof event.data.answer === "string" ? event.data.answer : null,
    }));
  // No event names the message a gate answer settles: the first human answer at or after delivery (sent, when delivery is not recorded) is its answer.
  const questions = messages
    .filter((message) => message.type === "question" || message.type === "escalation")
    .map((message): ConversationQuestion => {
      const since = timeOf(message.delivered_at ?? message.created_at);
      const sent = timeOf(message.created_at);
      const delivered = timeOf(message.delivered_at);
      return {
        id: message.id,
        sent: message.created_at,
        delivered: message.delivered_at,
        answered: answers.find((answer) => Date.parse(answer.time) >= since)?.time ?? null,
        pickup_seconds:
          Number.isNaN(delivered) || Number.isNaN(sent)
            ? "not recorded"
            : (delivered - sent) / 1000,
      };
    });
  // One span for each step.started: a step started again in a rework round is a second span; a start with no finish stays open.
  const spans = stepWindows(events).map((window): ConversationSpan => ({
    step: window.id,
    role: window.role,
    group: groupOfRole(window.role),
    agent: workers.find((worker) => worker.step === window.id)?.id ?? null,
    start: new Date(window.start).toISOString(),
    end: window.end === null ? null : new Date(window.end).toISOString(),
  }));
  return {
    run,
    project,
    agents: [...agents.values()],
    spans,
    answers,
    questions,
    messages: view,
  };
}

const byCreated = (left: InboxMessage, right: InboxMessage) =>
  (left.created_at ?? "").localeCompare(right.created_at ?? "");

/** The conversation of one run (with bodies and every event) or of every run in a window (no bodies). Pure: the worker thread runs it. */
export function buildConversation(
  input: ConversationInput,
  runs: RunEvents[],
  query: ConversationQuery,
): RunAnswer | ProjectAnswer {
  const index = indexFor(input);
  const ownedBy = new Map<string, InboxMessage[]>();
  const other: InboxMessage[] = [];
  const inWindow = (message: InboxMessage) =>
    query.kind === "run" ||
    (timeOf(message.created_at) >= query.since && timeOf(message.created_at) < query.until);
  for (const message of [...input.messages].sort(byCreated)) {
    if (!inWindow(message)) continue;
    const { arkRuns } = index.byMessage.get(message.id)!;
    if (arkRuns.length === 0) other.push(message);
    for (const run of arkRuns) ownedBy.set(run, [...(ownedBy.get(run) ?? []), message]);
  }
  if (query.kind === "run") {
    const found = runs.find((candidate) => candidate.run === query.run);
    if (!found) return null;
    return {
      ...runConversation(input, index, found, ownedBy.get(found.run) ?? [], true),
      events: found.events,
    };
  }
  const answered = runs
    .filter((candidate) => ownedBy.has(candidate.run))
    .map((candidate) =>
      runConversation(input, index, candidate, ownedBy.get(candidate.run) ?? [], false),
    );
  const otherAgents = new Map<string, ConversationAgent>();
  const otherView = other.map((message): ConversationMessage => {
    const { from, to } = index.byMessage.get(message.id)!;
    for (const resolved of [from, to]) otherAgents.set(resolved.agent.id, resolved.agent);
    const { body: _body, payload: _payload, ...rest } = message;
    return { ...rest, from: from.agent.id, to: to.agent.id };
  });
  return { runs: answered, other: { agents: [...otherAgents.values()], messages: otherView } };
}
