// Run lifecycle as data (PRD "Run state and resume"). Row: state -> { event -> next state }.
// Gate answer semantics (approver, packet hash) arrive with ARK-104; here gate events are plain moves.
export const transitions = {
  intake: { "analysis.completed": "analyzed", "g0.opened": "awaiting_g0", abort: "aborted" },
  awaiting_g0: { "g0.answered": "intake", abort: "aborted" },
  analyzed: { "g1.opened": "awaiting_g1", abort: "aborted" },
  awaiting_g1: { "g1.approved": "approved", "g1.changed": "analyzed", abort: "aborted" },
  approved: { "build.started": "building", abort: "aborted" },
  building: { "build.completed": "judging", abort: "aborted" },
  judging: {
    "fix_round.started": "building",
    "ge.opened": "awaiting_ge",
    "g2.opened": "awaiting_g2",
    abort: "aborted",
  },
  awaiting_ge: { "ge.answered": "building", abort: "aborted" },
  awaiting_g2: { "g2.approved": "mrs_open", "g2.rejected": "building", abort: "aborted" },
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
