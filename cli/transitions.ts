// Run lifecycle as data (PRD "Run state and resume"). Row: state -> { event -> next state }.
// Gate events are `gate.packet` and `gate.answered`, written only by `ark gate`; their row key is `<type>:<gate>[:<answer>]` (see eventKey). Gates: criteria, plan, evidence and escalation.
export const transitions = {
  intake: { "route.chosen": "intake", "analysis.completed": "analyzed", "criteria.opened": "awaiting_criteria", "gate.packet:criteria": "awaiting_criteria", abort: "aborted" },
  awaiting_criteria: {
    "route.chosen": "awaiting_criteria",
    "gate.packet:criteria": "awaiting_criteria",
    "gate.answered:criteria:accept": "intake",
    "gate.answered:criteria:edit": "awaiting_criteria", // nothing past criteria is legal until criteria accept: the ACs are re-read (ark acceptance-criteria update) and a new packet answered
    "acceptance_criteria.updated": "awaiting_criteria",
    "gate.answered:criteria:abort": "aborted",
    abort: "aborted",
  },
  analyzed: { "gate.packet:plan": "awaiting_plan", abort: "aborted" },
  awaiting_plan: {
    "gate.answered:plan:approve": "approved",
    "gate.answered:plan:change": "analyzed",
    "gate.answered:plan:abort": "aborted",
    abort: "aborted",
  },
  approved: { "build.started": "building", "worktree.created": "approved", abort: "aborted" },
  building: {
    "build.completed": "judging",
    "implementer.refused": "building",
    "worktree.created": "building",
    "implementer.completed": "building",
    "test.result": "building",
    "test.red_green": "building",
    "test.preservation": "building",
    "trace.checked": "building",
    abort: "aborted",
  },
  judging: {
    "fix_round.started": "building",
    "findings.recorded": "judging",
    "gate.packet:escalation": "awaiting_escalation",
    "gate.packet:evidence": "awaiting_evidence",
    "test.result": "judging",
    "test.red_green": "judging",
    "test.preservation": "judging",
    "trace.checked": "judging",
    abort: "aborted",
  },
  escalating: { "gate.packet:escalation": "awaiting_escalation", abort: "aborted" }, // an evidence send-back past the round budget: only the escalation packet (or abort) is legal
  awaiting_escalation: {
    "gate.answered:escalation:one_more_round": "building",
    "gate.answered:escalation:take_over": "building",
    "gate.answered:escalation:abort": "aborted",
    abort: "aborted",
  },
  awaiting_evidence: {
    "gate.answered:evidence:approve": "merge_requests_open",
    "gate.answered:evidence:send_back": "building",
    "gate.answered:evidence:send_back:escalated": "escalating",
    "gate.answered:evidence:abort": "aborted",
    abort: "aborted",
  },
  merge_requests_open: { "merge_request.opened": "merge_requests_open", "run.closed": "done", abort: "aborted" }, // abort before any MR; after one opens, close it as merged or abandoned
  done: {},
  aborted: {},
} as const satisfies Record<string, Record<string, string>>;

// Event types written by a dedicated command, which `ark advance` refuses: the owner is what makes the ledger evidence trustworthy.
// A key ending in "." owns the whole family (test.* ...), any other key one type. Ownership holds in every state, before legality is asked.
// Escalation uses gate events only; retired event families have no owner alias.
const owners: [prefix: string, command: string][] = [
  ["gate.", "gate"], ["worktree.", "worktree create"], ["test.", "test"], ["trace.", "trace-check"], ["merge_request.", "merge-request open"],
  ["artifact.", "artifact record"], ["acceptance_criteria.", "acceptance-criteria update"], ["implementer.refused", "advance implementer.completed"],
  ["run.closed", "run close"], ["route.chosen", "log route"], ["findings.recorded", "findings record"],
];
export const ownerOf = (type: string) => owners.find(([prefix]) => (prefix.endsWith(".") ? type.startsWith(prefix) : type === prefix))?.[1];

export type State = keyof typeof transitions;

// PRD state table: next action and who acts. Closed states have none.
export const nextActions: Record<State, { kind: string; agent: "orchestrator" | "human" } | null> = {
  intake: { kind: "write_acceptance_criteria", agent: "orchestrator" },
  awaiting_criteria: { kind: "answer_criteria", agent: "human" },
  analyzed: { kind: "write_plan", agent: "orchestrator" },
  awaiting_plan: { kind: "answer_plan", agent: "human" },
  approved: { kind: "spawn", agent: "orchestrator" },
  building: { kind: "continue_build", agent: "orchestrator" },
  judging: { kind: "judge", agent: "orchestrator" },
  escalating: { kind: "open_escalation", agent: "orchestrator" },
  awaiting_escalation: { kind: "answer_escalation", agent: "human" },
  awaiting_evidence: { kind: "answer_evidence", agent: "human" },
  merge_requests_open: { kind: "merge", agent: "human" },
  done: null,
  aborted: null,
};

// The table key of a ledger event: gate events are keyed by gate and answer, everything else by type.
export const eventKey = (event: { type: string; data: Record<string, unknown> }) =>
  event.type.startsWith("gate.") ? `${event.type}:${event.data.gate}${event.type === "gate.answered" ? `:${event.data.answer}${event.data.gate === "evidence" && event.data.answer === "send_back" && event.data.escalated === true ? ":escalated" : ""}` : ""}` : event.type;
