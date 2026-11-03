import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ArkError } from "./errors.ts";
import { planHash } from "./plan.ts";
import { now } from "./clock.ts";
import { assertAllowed } from "./transitions.ts";

// Event payloads differ per type (see the contract), so `data` stays loosely typed.
export type EventData = Record<string, any>;
export type ArkEvent = { seq: number; time: string; type: string; data: EventData };

export type Phase =
  | "awaiting_criteria"
  | "awaiting_strategy"
  | "planning"
  | "building"
  | "escalation"
  | "merge_requests_open"
  | "closed";
export type CriterionStatus = "pending" | "passing" | "failing" | "missing";
export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "stopped";

export type RunState = {
  run: string;
  project: string;
  ticket: { id: string; title: string };
  phase: Phase;
  round: number;
  round_budget: number;
  criteria: { id: string; status: CriterionStatus }[];
  /** Each amended criterion: the text before its first amendment and the latest text. */
  amended_criteria: { id: string; old: string; new: string }[];
  gates: { criteria?: string; strategy?: string; plan?: string; escalation?: string };
  post_mr_escalation_answered: boolean;
  evaluation: { blockers: string[]; risks: string[]; surfaces: string[] } | null;
  /** The latest strategy.recorded; `chosen` is the card the human picked, or the only card. */
  strategy: {
    count: number;
    recommended: string;
    cards: string[];
    reason: string;
    card_text: Record<string, string>;
    chosen: string | null;
  } | null;
  plan: {
    checked: boolean;
    valid: boolean;
    plan_hash: string;
    open_decisions: number;
  } | null;
  steps: { id: string; role: string; repo: string; status: StepStatus }[];
  current_step: string | null;
  worktrees: { repo: string; path: string; branch: string }[];
  sync_conflicts: string[];
  last_test: { passed: boolean; heads: Record<string, string> } | null;
  merge_requests: { repo: string; url: string; number: number }[];
  outcome: string | null;
  implementer?: "human";
  events: number;
};

export function readEvents(runDirectory: string): ArkEvent[] {
  const file = join(runDirectory, "events.ndjson");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, i) => {
      try {
        return JSON.parse(line) as ArkEvent;
      } catch {
        throw new ArkError(`${file}: line ${i + 1} is not valid JSON`);
      }
    });
}

export function appendEvent(runDirectory: string, type: string, data: EventData): ArkEvent {
  const events = readEvents(runDirectory);
  const state = deriveState(events);
  assertAllowed(state, type, data);
  if (
    type === "gate.answered" &&
    data.gate === "plan" &&
    data.answer === "approve" &&
    planHash(runDirectory) !== state.plan?.plan_hash
  ) {
    throw new ArkError(
      "plan.yml changed after plan.checked: run ark plan check again before gate.answered plan approve",
    );
  }
  const event: ArkEvent = {
    seq: (events.at(-1)?.seq ?? 0) + 1,
    time: new Date(now()).toISOString(),
    type,
    data,
  };
  appendFileSync(join(runDirectory, "events.ndjson"), `${JSON.stringify(event)}\n`);
  writeState(runDirectory);
  return event;
}

export function writeState(runDirectory: string): RunState {
  const state = deriveState(readEvents(runDirectory));
  writeFileSync(join(runDirectory, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export function deriveState(events: ArkEvent[]): RunState {
  let run = "";
  let project = "";
  let ticket = { id: "", title: "" };
  let startedWithoutCriteria = false;
  let evaluation: RunState["evaluation"] = null;
  let strategy: RunState["strategy"] = null;
  let blocked = false;
  let round = 1;
  // Rounds of the non-merge starts, so a finish with not_started can take its start back.
  const startedRounds: { step: string; round: number }[] = [];
  let roundBudget = 0;
  let criteriaIds: string[] = [];
  let criteriaStatus: Record<string, CriterionStatus> = {};
  const gates: Record<string, string> = {};
  let plan: RunState["plan"] = null;
  const amendments = new Map<string, { id: string; old: string; new: string }>();
  let planApproved = false;
  let approvedPlanHash: string | null = null;
  let planSteps: { id: string; role: string; repo: string }[] = [];
  const stepStatus = new Map<string, StepStatus>();
  const startedSteps: { id: string; role: string; repo: string }[] = [];
  const worktrees: RunState["worktrees"] = [];
  const syncConflicts = new Set<string>();
  let lastTest: RunState["last_test"] = null;
  let escalationAnswered = false;
  let escalationRequested = false;
  const mergeRequests: RunState["merge_requests"] = [];
  let outcome: string | null = null;
  let human = false;

  for (const { type, data } of events) {
    switch (type) {
      case "run.started":
        run = data.run ?? "";
        project = data.project;
        ticket = { id: data.ticket.id, title: data.ticket.title };
        criteriaIds = data.criteria;
        startedWithoutCriteria = criteriaIds.length === 0;
        roundBudget = data.round_budget ?? 0;
        break;
      case "criteria.updated":
        criteriaIds = data.criteria;
        criteriaStatus = {};
        break;
      case "criteria.amended": {
        const first = amendments.get(data.criterion);
        amendments.set(data.criterion, {
          id: data.criterion,
          old: first?.old ?? data.old,
          new: data.new,
        });
        // The amendment changes what plan.md must show, so the plan needs a new check.
        plan = null;
        planApproved = false;
        break;
      }
      case "evaluation.recorded":
        evaluation = { blockers: data.blockers, risks: data.risks, surfaces: data.surfaces ?? [] };
        if (data.blockers.length > 0) blocked = true;
        break;
      case "plan.checked":
        plan = {
          checked: true,
          valid: data.valid,
          plan_hash: data.plan_hash,
          open_decisions: data.open_decisions ?? 0,
        };
        planApproved = planApproved && data.valid && data.plan_hash === approvedPlanHash;
        if (data.valid)
          planSteps = data.steps.map(
            ({ id, role, repo }: { id: string; role: string; repo: string }) => ({
              id,
              role,
              repo,
            }),
          );
        break;
      case "strategy.recorded":
        strategy = {
          count: data.count,
          recommended: data.recommended,
          cards: data.cards,
          reason: data.reason ?? "",
          card_text: data.card_text ?? {},
          chosen: data.count === 1 ? data.cards[0] : null,
        };
        break;
      case "gate.answered":
        gates[data.gate] = data.answer;
        if (data.gate === "strategy" && strategy && strategy.cards.includes(data.answer))
          strategy.chosen = data.answer;
        if (data.gate === "criteria" && data.answer === "accept") blocked = false;
        if (data.gate === "plan" && data.answer === "approve") {
          planApproved = true;
          approvedPlanHash = plan?.plan_hash ?? null;
        }
        // A change answer sends the plan back for edits, so the old check no longer stands.
        if (data.gate === "plan" && data.answer === "change") plan = null;
        if (data.answer === "abort") outcome = "aborted";
        if (data.gate === "escalation") {
          escalationAnswered = true;
          escalationRequested = false;
          if (data.answer === "one_more_round") roundBudget += 1;
          if (data.answer === "take_over") human = true;
        }
        break;
      case "worktree.created": {
        const known = worktrees.findIndex((worktree) => worktree.repo === data.repo);
        const worktree = { repo: data.repo, path: data.path, branch: data.branch };
        if (known === -1) worktrees.push(worktree);
        else worktrees[known] = worktree;
        break;
      }
      case "worktree.synced":
        if (data.conflict) syncConflicts.add(data.repo);
        else syncConflicts.delete(data.repo);
        break;
      case "step.started":
        stepStatus.set(data.step, "running");
        if (!data.merge) startedRounds.push({ step: data.step, round: data.round });
        round = Math.max(round, data.round);
        if (!startedSteps.some((step) => step.id === data.step))
          startedSteps.push({ id: data.step, role: data.role, repo: data.repo });
        if (mergeRequests.length > 0 && data.role === "implementer") escalationAnswered = false;
        break;
      case "step.finished": {
        stepStatus.set(data.step, data.outcome);
        // A merge start never moved the round, so its not_started finish has no round to restore.
        if (data.not_started && !data.merge) {
          const last = startedRounds.findLastIndex((started) => started.step === data.step);
          if (last !== -1) startedRounds.splice(last, 1);
          round = Math.max(1, ...startedRounds.map((started) => started.round));
        }
        const finishedStep = startedSteps.find((step) => step.id === data.step);
        if (data.merge && data.outcome === "succeeded" && finishedStep)
          syncConflicts.delete(finishedStep.repo);
        break;
      }
      case "test.completed":
        criteriaStatus = data.criteria;
        lastTest = { passed: data.passed, heads: data.heads };
        escalationAnswered = false;
        break;
      case "escalation.requested":
        escalationRequested = true;
        escalationAnswered = false;
        break;
      case "merge_request.opened":
        if (mergeRequests.length === 0) escalationAnswered = false;
        mergeRequests.push({ repo: data.repo, url: data.url, number: data.number });
        break;
      case "run.closed":
        outcome = data.outcome;
        break;
    }
  }

  const steps = [
    ...planSteps,
    ...startedSteps.filter((started) => !planSteps.some((planned) => planned.id === started.id)),
  ].map(({ id, role, repo }) => ({
    id,
    role,
    repo,
    // A closed run runs nothing: a step the log left running was cut off.
    status:
      outcome !== null && stepStatus.get(id) === "running"
        ? ("stopped" as StepStatus)
        : (stepStatus.get(id) ?? ("pending" as StepStatus)),
  }));

  let phase: Phase;
  if (outcome !== null) phase = "closed";
  else if (mergeRequests.length > 0) phase = "merge_requests_open";
  else if (blocked || (startedWithoutCriteria && gates.criteria !== "accept"))
    phase = "awaiting_criteria";
  else if (strategy && strategy.count >= 2 && strategy.chosen === null) phase = "awaiting_strategy";
  else if (!planApproved) phase = "planning";
  else if (
    round >= roundBudget &&
    (escalationRequested || (lastTest && !lastTest.passed)) &&
    !escalationAnswered &&
    !human
  )
    phase = "escalation";
  else phase = "building";

  return {
    run,
    project,
    ticket,
    phase,
    round,
    round_budget: roundBudget,
    criteria: criteriaIds.map((id) => ({
      id,
      status: criteriaStatus[id] ?? (lastTest ? "missing" : "pending"),
    })),
    amended_criteria: [...amendments.values()],
    gates: {
      ...(gates.criteria === undefined ? {} : { criteria: gates.criteria }),
      ...(gates.strategy === undefined ? {} : { strategy: gates.strategy }),
      ...(gates.plan === undefined ? {} : { plan: gates.plan }),
      ...(gates.escalation === undefined ? {} : { escalation: gates.escalation }),
    },
    post_mr_escalation_answered: escalationAnswered && mergeRequests.length > 0,
    evaluation,
    strategy,
    plan,
    steps,
    current_step: steps.find((step) => step.status !== "succeeded")?.id ?? null,
    worktrees,
    sync_conflicts: [...syncConflicts],
    last_test: lastTest,
    merge_requests: mergeRequests,
    outcome,
    ...(human ? { implementer: "human" as const } : {}),
    events: events.length,
  };
}
