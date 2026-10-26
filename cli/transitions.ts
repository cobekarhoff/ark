// Run lifecycle as data (PRD "Run state and resume"). Row: state -> { event -> next state }.
// Gate events are `gate.packet` and `gate.answered`, written only by `ark gate`; their row key is `<type>:<gate>[:<answer>]` (see eventKey). Gates: G0, G1, G2 and GE (escalation).
export const transitions = {
  intake: { "route.chosen": "intake", "analysis.completed": "analyzed", "g0.opened": "awaiting_g0", "gate.packet:G0": "awaiting_g0", abort: "aborted" },
  awaiting_g0: {
    "route.chosen": "awaiting_g0",
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
    "trace.checked": "building",
    abort: "aborted",
  },
  judging: {
    "fix_round.started": "building",
    "findings.recorded": "judging",
    "gate.packet:GE": "awaiting_ge",
    "gate.packet:G2": "awaiting_g2",
    "test.result": "judging",
    "test.red_green": "judging",
    "trace.checked": "judging",
    abort: "aborted",
  },
  awaiting_ge: {
    "gate.answered:GE:one_more_round": "building",
    "gate.answered:GE:take_over": "building",
    "gate.answered:GE:abort": "aborted",
    abort: "aborted",
  },
  awaiting_g2: {
    "gate.answered:G2:approve": "mrs_open",
    "gate.answered:G2:send_back": "building",
    "gate.answered:G2:abort": "aborted",
    abort: "aborted",
  },
  mrs_open: { "mr.opened": "mrs_open", "run.closed": "done", "run.completed": "done", abort: "aborted" },
  done: {},
  aborted: {},
} as const satisfies Record<string, Record<string, string>>;

// Event types written by a dedicated command, which `ark advance` refuses: the owner is what makes the ledger evidence trustworthy.
// A key ending in "." owns the whole family (test.* ...), any other key one type. Ownership holds in every state, before legality is asked.
// ge.* is retired: escalation is the GE gate, so a stray `advance ge.opened` is pointed at `ark gate`. `ark ac update` (ac.updated) arrives with ARK-117.
const owners: [prefix: string, command: string][] = [
  ["gate.", "gate"], ["ge.", "gate"], ["ws.", "ws"], ["test.", "test"], ["trace.", "trace-check"], ["mr.", "mr"],
  ["artifact.", "artifact record"], ["ac.", "ac update"],
  ["run.closed", "mr"], ["route.chosen", "log route"], ["findings.recorded", "findings record"],
];
export const ownerOf = (type: string) => owners.find(([p]) => (p.endsWith(".") ? type.startsWith(p) : type === p))?.[1];

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
