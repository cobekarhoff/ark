// PROTOTYPE, throwaway. Made-up scenario with real Ark data shapes.
// "now" is fixed so every variant renders the same moment.
window.HUB_DATA = {
  now: "2026-10-31T09:12:00",
  lastSeen: "2026-10-30T18:40:00",
  projects: [
    { id: "ark", name: "Ark", workspace: "~/Dev/abbott/ark", masterChief: { state: "live", terminal: "term-ark-chief", harness: "claude", model: "opus-5", since: "2026-10-31T07:58:00" } },
    { id: "clara", name: "Clara", workspace: "~/Dev/clara-agentic-environment", masterChief: { state: "missing" } },
  ],
  digest: {
    since: "2026-10-30T18:40:00",
    merged: ["ARK-169", "ARK-168"],
    aborted: ["ARK-166-1"],
    gatesOpened: 3,
    agentsDied: 1,
    costUsd: 14.2,
  },
  needsMe: [
    { id: "gate-ark173-strategy", kind: "gate", gate: "strategy", source: "ark", project: "ark", ticket: "ARK-173", title: "Pick a strategy: 3 cards, 3 mockups", since: "2026-10-31T08:30:00", action: { label: "Open in Plannotator", key: "p" } },
    { id: "gate-clara512-plan", kind: "gate", gate: "plan", source: "ark", project: "clara", ticket: "CLARA-512", title: "Approve plan: 6 steps across 2 repos, 2 open decisions", since: "2026-10-31T09:00:00", action: { label: "Open in Plannotator", key: "p" } },
    { id: "escalation-ark171", kind: "escalation", source: "ark", project: "ark", ticket: "ARK-171", title: "Round budget spent: ARK-171-AC3 still failing", since: "2026-10-31T07:15:00", action: { label: "One more round / take over / abort", key: "e" } },
    { id: "merge-ark172", kind: "mergeRequest", source: "ark", project: "ark", ticket: "ARK-172", title: "Ready to merge: ark #33, tests pass, review clean", since: "2026-10-31T06:50:00", url: "https://github.com/cobekarhoff/ark/pull/33", action: { label: "Open MR", key: "o" } },
    { id: "inbox-docs", kind: "question", source: "plannotator", project: null, title: "docs-site agent asks: keep old URLs as redirects?", since: "2026-10-31T08:55:00", action: { label: "Answer in Inbox", key: "i" } },
    { id: "stuck-ark170-validator", kind: "stuckAgent", source: "orca", project: "ark", ticket: "ARK-170", title: "Validator idle 18 min, no output", since: "2026-10-31T08:54:00", action: { label: "Open in Orca", key: "o" } },
    { id: "approve-ark175", kind: "approval", source: "ark", project: "ark", ticket: "ARK-175", title: "Proposed ticket: Hub, slice 2 — steering", since: "2026-10-31T08:10:00", action: { label: "Approve and queue", key: "a" } },
    { id: "retro-ark169", kind: "retro", source: "ark", project: "ark", ticket: "ARK-169", title: "Retro: 3 close questions, 2 proposals", since: "2026-10-30T22:05:00", action: { label: "Answer retro", key: "r" } },
  ],
  runs: [
    {
      id: "2026-10-31-ARK-170-1", project: "ark", ticket: "ARK-170", title: "Evaluator checks the ticket before planning",
      phase: "building", round: 1, roundBudget: 2, costUsd: 6.4, startedAt: "2026-10-31T06:02:00",
      steps: [
        { id: "eval-cli", role: "implementer", status: "succeeded" },
        { id: "eval-playbook", role: "implementer", status: "succeeded" },
        { id: "eval-tests", role: "validator", status: "running" },
        { id: "review", role: "reviewer", status: "pending" },
      ],
      criteria: [
        { id: "ARK-170-AC1", status: "passing" }, { id: "ARK-170-AC2", status: "passing" },
        { id: "ARK-170-AC3", status: "pending" }, { id: "ARK-170-AC4", status: "failing" },
      ],
      mergeRequests: [],
    },
    {
      id: "2026-10-31-ARK-171-1", project: "ark", ticket: "ARK-171", title: "Plan has a design block",
      phase: "escalation", round: 2, roundBudget: 2, costUsd: 9.1, startedAt: "2026-10-30T21:40:00",
      steps: [
        { id: "design-schema", role: "implementer", status: "succeeded" },
        { id: "design-tests", role: "validator", status: "failed" },
        { id: "review", role: "reviewer", status: "pending" },
      ],
      criteria: [
        { id: "ARK-171-AC1", status: "passing" }, { id: "ARK-171-AC2", status: "passing" },
        { id: "ARK-171-AC3", status: "failing" }, { id: "ARK-171-AC4", status: "passing" },
      ],
      mergeRequests: [],
    },
    {
      id: "2026-10-31-ARK-173-1", project: "ark", ticket: "ARK-173", title: "Human chooses the strategy and the plan decisions",
      phase: "awaiting_strategy", round: 0, roundBudget: 2, costUsd: 3.8, startedAt: "2026-10-31T07:20:00",
      steps: [], criteria: [], mergeRequests: [],
      strategies: [
        { id: "A", name: "New gate in the event log", recommended: true },
        { id: "B", name: "Strategy inside the plan gate", recommended: false },
        { id: "C", name: "Playbook only, no CLI", recommended: false },
      ],
    },
    {
      id: "2026-10-31-CLARA-512-1", project: "clara", ticket: "CLARA-512", title: "Export files show units",
      phase: "planning", round: 0, roundBudget: 2, costUsd: 2.2, startedAt: "2026-10-31T08:15:00",
      steps: [], criteria: [{ id: "CLARA-512-AC1", status: "pending" }, { id: "CLARA-512-AC2", status: "pending" }], mergeRequests: [],
    },
    {
      id: "2026-10-30-ARK-172-1", project: "ark", ticket: "ARK-172", title: "plan.md renders test cases as valid Gherkin",
      phase: "merge_requests_open", round: 1, roundBudget: 2, costUsd: 4.7, startedAt: "2026-10-30T19:30:00",
      steps: [
        { id: "gherkin", role: "implementer", status: "succeeded" },
        { id: "gherkin-tests", role: "validator", status: "succeeded" },
        { id: "review", role: "reviewer", status: "succeeded" },
      ],
      criteria: [{ id: "ARK-172-AC1", status: "passing" }, { id: "ARK-172-AC2", status: "passing" }, { id: "ARK-172-AC3", status: "passing" }],
      mergeRequests: [{ repo: "ark", number: 33, url: "https://github.com/cobekarhoff/ark/pull/33", state: "open" }],
    },
  ],
  agents: [
    { id: "term-ark-chief", name: "Master Chief", project: "ark", run: null, role: "chief", harness: "claude", model: "opus-5", state: "idle", costUsd: 1.9, lastLine: "Waiting for your next message." },
    { id: "term-170-lead", name: "ARK-170 run lead", project: "ark", run: "2026-10-31-ARK-170-1", role: "run lead", harness: "claude", model: "opus-5", state: "waiting", costUsd: 1.1, lastLine: "Waiting on step eval-tests." },
    { id: "term-170-val", name: "ARK-170 validator", project: "ark", run: "2026-10-31-ARK-170-1", role: "validator", harness: "codex", model: "gpt-6", state: "stuck", costUsd: 2.3, lastLine: "Running bun test test/evaluation.test.ts …" },
    { id: "term-171-lead", name: "ARK-171 run lead", project: "ark", run: "2026-10-31-ARK-171-1", role: "run lead", harness: "claude", model: "opus-5", state: "waiting", costUsd: 1.4, lastLine: "Escalation sent to Master Chief." },
    { id: "term-173-lead", name: "ARK-173 run lead", project: "ark", run: "2026-10-31-ARK-173-1", role: "run lead", harness: "claude", model: "opus-5", state: "waiting", costUsd: 0.9, lastLine: "Strategy gate open: 3 cards." },
    { id: "term-173-designer", name: "ARK-173 designer", project: "ark", run: "2026-10-31-ARK-173-1", role: "designer", harness: "claude", model: "opus-5", state: "idle", costUsd: 2.6, lastLine: "Wrote mockups/A.html, B.html, C.html." },
    { id: "term-512-lead", name: "CLARA-512 run lead", project: "clara", run: "2026-10-31-CLARA-512-1", role: "run lead", harness: "omp", model: "sonnet-5", state: "working", costUsd: 2.2, lastLine: "Reading repos/platform/export/units.py" },
    { id: "term-docs", name: "docs-site refactor", project: null, run: null, role: "agent", harness: "claude", model: "sonnet-5", state: "waiting", costUsd: 3.1, lastLine: "Asked in Plannotator Inbox: keep old URLs?" },
    { id: "term-smartqc", name: "smart-qc spike", project: null, run: null, role: "agent", harness: "codex", model: "gpt-6", state: "working", costUsd: 0.8, lastLine: "Writing spike/notes.md" },
  ],
  backlog: [
    { id: "ARK-170", title: "Evaluator checks the ticket before planning", status: "in_progress", dependsOn: ["ARK-171"] },
    { id: "ARK-171", title: "Plan has a design block", status: "in_progress", dependsOn: ["ARK-172"] },
    { id: "ARK-172", title: "plan.md renders test cases as valid Gherkin", status: "in_progress", dependsOn: [] },
    { id: "ARK-173", title: "Human chooses the strategy and the plan decisions", status: "in_progress", dependsOn: ["ARK-170", "ARK-171"] },
    { id: "ARK-174", title: "Bootstrap gives a UI project PRODUCT.md and DESIGN.md", status: "ready", dependsOn: ["ARK-173"] },
    { id: "ARK-175", title: "Hub, slice 2 — steering", status: "proposed", dependsOn: [] },
  ],
  metrics: {
    week: { runs: 11, merged: 8, aborted: 2, costUsd: 61.4, medianWallMinutes: 74, gateWaitMinutes: 212, overrideRate: 0.18, designRounds: 4 },
    costByDay: [6.1, 9.4, 12.8, 4.2, 15.3, 0, 14.2],
  },
  notifications: [
    { at: "2026-10-31T09:00:00", text: "CLARA-512 plan is ready for review", handled: false },
    { at: "2026-10-31T08:54:00", text: "ARK-170 validator looks stuck", handled: false },
    { at: "2026-10-31T08:30:00", text: "ARK-173 strategy gate: 3 cards", handled: false },
    { at: "2026-10-31T07:15:00", text: "ARK-171 escalation", handled: false },
    { at: "2026-10-31T06:50:00", text: "ARK-172 MR #33 ready to merge", handled: false },
    { at: "2026-10-30T22:05:00", text: "ARK-169 retro ready", handled: true },
  ],
};
