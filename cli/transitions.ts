// Run lifecycle as data (PRD "Run state and resume"). Row: state -> { event -> next state }.
// Gate events are `gate.packet` and `gate.answered`, written only by `ark gate`; their row key is `<type>:<gate>[:<answer>]` (see eventKey).
export const transitions = {
  intake: { "analysis.completed": "analyzed", "g0.opened": "awaiting_g0", "gate.packet:G0": "awaiting_g0", abort: "aborted" },
  awaiting_g0: {
    "gate.packet:G0": "awaiting_g0",
    "gate.answered:G0:accept": "intake",
    "gate.answered:G0:edit": "intake",
    "gate.answered:G0:abort": "aborted",
    abort: "aborted",
  },
  analyzed: { "gate.packet:G1": "awaiting_g1", abort: "aborted" },
  awaiting_g1: {
    "gate.answered:G1:approve": "approved",
    "gate.answered:G1:change": "analyzed",
    "gate.answered:G1:abort": "aborted",
    abort: "aborted",
  },
  approved: { "build.started": "building", "ws.created": "approved", abort: "aborted" },
  building: {
    "build.completed": "judging",
    "ws.created": "building",
    "implementer.completed": "building",
    "test.result": "building",
    "test.red_green": "building",
    abort: "aborted",
  },
  judging: {
    "fix_round.started": "building",
    "ge.opened": "awaiting_ge",
    "gate.packet:G2": "awaiting_g2",
    "test.result": "judging",
    "test.red_green": "judging",
    abort: "aborted",
  },
  awaiting_ge: { "ge.answered": "building", abort: "aborted" },
  awaiting_g2: {
    "gate.answered:G2:approve": "mrs_open",
    "gate.answered:G2:send_back": "building",
    "gate.answered:G2:abort": "aborted",
    abort: "aborted",
  },
  mrs_open: { "run.completed": "done", abort: "aborted" },
  done: {},
  aborted: {},
} as const satisfies Record<string, Record<string, string>>;

export type State = keyof typeof transitions;

// PRD state table: next action and who acts. Closed states have none.
export const nextActions: Record<State, { kind: string; agent: "orchestrator" | "human" } | null> = {
  intake: { kind: "write_ac", agent: "orchestrator" },
  awaiting_g0: { kind: "answer_g0", agent: "human" },
  analyzed: { kind: "write_plan", agent: "orchestrator" },
  awaiting_g1: { kind: "answer_g1", agent: "human" },
  approved: { kind: "spawn", agent: "orchestrator" },
  building: { kind: "continue_build", agent: "orchestrator" },
  judging: { kind: "judge", agent: "orchestrator" },
  awaiting_ge: { kind: "answer_ge", agent: "human" },
  awaiting_g2: { kind: "answer_g2", agent: "human" },
  mrs_open: { kind: "merge", agent: "human" },
  done: null,
  aborted: null,
};

// The table key of a ledger event: gate events are keyed by gate and answer, everything else by type.
export const eventKey = (e: { type: string; data: Record<string, unknown> }) =>
  e.type.startsWith("gate.") ? `${e.type}:${e.data.gate}${e.type === "gate.answered" ? `:${e.data.answer}` : ""}` : e.type;
