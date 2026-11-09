import { hasTestCriterion } from "./criteria.ts";
import { ArkError } from "./errors.ts";
import type { EventData, RunState } from "./events.ts";
import { buildPhases, outcomes } from "./lifecycle.ts";

const gateAnswers: Record<string, string[]> = {
  criteria: ["accept", "edit", "abort"],
  plan: ["approve", "change", "abort"],
  escalation: ["one_more_round", "take_over", "abort"],
  manual: ["ok", "problem"],
};

/** The event that moves a run out of `phase`, named in refusals. */
function missingEvent(state: RunState): string {
  if (state.phase === "awaiting_criteria")
    return state.evaluation?.blockers.length
      ? "gate.answered criteria accept (the evaluation has blockers)"
      : "gate.answered criteria accept";
  if (state.phase === "awaiting_strategy")
    return `gate.answered strategy <card id> (${state.strategy?.cards.join(", ")}) or abort`;
  if (state.phase === "planning")
    return state.plan?.valid
      ? "gate.answered plan approve"
      : "plan.checked valid, then gate.answered plan approve";
  return `a run in phase ${state.phase}`;
}

function requirePhase(state: RunState, type: string, phases: readonly string[]): void {
  if (phases.includes(state.phase)) return;
  throw new ArkError(
    `${type} refused: run is in phase ${state.phase}; missing ${missingEvent(state)}`,
  );
}

/** Throws an ArkError naming the missing event when `type` is not allowed in `state`. */
export function assertAllowed(
  state: RunState,
  type: string,
  data: EventData,
  runDirectory?: string,
): void {
  if (type === "run.started") {
    if (state.events > 0) throw new ArkError("run.started refused: it must be the first event");
    return;
  }
  if (state.events === 0) throw new ArkError(`${type} refused: the run has no run.started event`);
  if (state.phase === "closed")
    throw new ArkError(`${type} refused: run is closed (${state.outcome})`);

  switch (type) {
    case "criteria.updated":
      requirePhase(state, type, ["awaiting_criteria"]);
      if (!Array.isArray(data.criteria) || data.criteria.length === 0)
        throw new ArkError("criteria.updated refused: the ticket has no criteria");
      return;
    case "criteria.amended": {
      // In awaiting_criteria the backlog file is the source: name the gate that moves the run on.
      if (state.phase === "awaiting_criteria") requirePhase(state, type, []);
      if (state.phase === "merge_requests_open")
        throw new ArkError(
          `${type} refused: run is in phase ${state.phase}; allowed before merge_requests_open`,
        );
      if (typeof data.reason !== "string" || data.reason.trim() === "")
        throw new ArkError(
          `${type} refused: --reason is required (the human's reason for the new text)`,
        );
      if (!state.criteria.some((criterion) => criterion.id === data.criterion))
        throw new ArkError(
          `${type} refused: ${data.criterion} is not a criterion of this run (${state.criteria.map((criterion) => criterion.id).join(", ")})`,
        );
      return;
    }
    case "evaluation.recorded":
      requirePhase(state, type, ["awaiting_criteria", "planning"]);
      for (const list of ["blockers", "risks", "surfaces"])
        if (!Array.isArray(data[list]) || !data[list].every((line) => typeof line === "string"))
          throw new ArkError(`evaluation.recorded refused: ${list} must be a list of strings`);
      return;
    case "strategy.recorded":
      requirePhase(state, type, ["planning", "awaiting_strategy"]);
      if (!state.evaluation)
        throw new ArkError(
          "strategy.recorded refused: missing evaluation.recorded (ark evaluation record)",
        );
      if (state.strategy && state.strategy.count >= 2 && state.strategy.chosen !== null)
        throw new ArkError(
          `strategy.recorded refused: the human already chose ${state.strategy.chosen}`,
        );
      if (
        !Array.isArray(data.cards) ||
        data.cards.length === 0 ||
        data.count !== data.cards.length ||
        !data.cards.includes(data.recommended)
      )
        throw new ArkError(
          "strategy.recorded refused: count must equal the card ids, and recommended must be one of them",
        );
      return;
    case "plan.checked":
      requirePhase(state, type, ["planning", "building", "escalation"]);
      if (!state.evaluation)
        throw new ArkError(
          "plan.checked refused: missing evaluation.recorded (ark evaluation record)",
        );
      if (state.phase === "planning" && !state.strategy)
        throw new ArkError("plan.checked refused: missing strategy.recorded (ark strategy record)");
      return;
    case "gate.answered":
      return assertGateAllowed(state, data);
    case "worktree.created":
      return; // every open phase: closed is refused above
    case "worktree.synced":
      requirePhase(state, type, ["planning", ...buildPhases]);
      return;
    case "step.started":
      requirePhase(state, type, buildPhases);
      if (state.steps.find((step) => step.id === data.step)?.status === "running")
        throw new ArkError(`step.started refused: step ${data.step} is already running`);
      if (
        state.kind === "bug" &&
        data.role === "implementer" &&
        !state.red_test &&
        (runDirectory === undefined || hasTestCriterion(runDirectory))
      )
        throw new ArkError(
          "step.started refused: bug run: record a failing ark test of the ACs before the fix",
        );
      if (
        state.phase === "merge_requests_open" &&
        data.role === "implementer" &&
        !state.post_mr_escalation_answered
      )
        throw new ArkError(
          "step.started refused: record gate escalation (one_more_round, take_over or abort)",
        );
      if (data.merge) {
        if (data.role !== "implementer")
          throw new ArkError(
            `step.started refused: --merge applies to an implementer step, not ${data.role}`,
          );
        if (!state.sync_conflicts.includes(data.repo))
          throw new ArkError(
            `step.started refused: --merge needs a failed ark worktree sync for repo ${data.repo}`,
          );
      }
      if (
        !data.merge &&
        data.role === "implementer" &&
        data.round > 1 &&
        data.round > state.round_budget &&
        state.implementer !== "human"
      ) {
        const choice = "one_more_round, take_over or abort";
        throw new ArkError(
          state.phase === "building"
            ? `round budget spent: run ark escalate ${state.run} --reason <text> first, then ask the human, then record the escalation gate (${choice})`
            : `round budget spent: record gate escalation with ark gate record (${choice})`,
        );
      }
      return;
    case "step.finished":
      requirePhase(state, type, buildPhases);
      if (!["succeeded", "failed"].includes(data.outcome))
        throw new ArkError(
          `step.finished refused: outcome must be succeeded or failed, not ${data.outcome}`,
        );
      if (state.steps.find((step) => step.id === data.step)?.status !== "running")
        throw new ArkError(`step.finished refused: missing step.started for ${data.step}`);
      return;
    case "escalation.requested":
      requirePhase(state, type, ["building"]);
      if (typeof data.reason !== "string" || data.reason.trim() === "")
        throw new ArkError("escalation.requested refused: a reason is required");
      if (state.round < state.round_budget)
        throw new ArkError(
          `escalation.requested refused: the round budget is not spent (round ${state.round} of ${state.round_budget}); reason given: ${data.reason}`,
        );
      return;
    case "test.completed":
      requirePhase(state, type, buildPhases);
      return;
    case "merge_request.opened":
      requirePhase(state, type, ["building", "merge_requests_open"]);
      if (data.order !== undefined && !(Number.isInteger(data.order) && data.order >= 1))
        throw new ArkError(`${type} refused: order must be a whole number from 1`);
      if (
        data.waits_for !== undefined &&
        !(Array.isArray(data.waits_for) && data.waits_for.every(Number.isInteger))
      )
        throw new ArkError(`${type} refused: waits_for must be a list of MR numbers`);
      return;
    case "run.closed":
      return assertCloseAllowed(state, data);
    default:
      throw new ArkError(`unknown event type: ${type}`);
  }
}

// Not in config.ts gateNames on purpose: the manual gate is always the human's.
export const gateNames = ["criteria", "strategy", "plan", "escalation", "manual"];

function assertGateAllowed(state: RunState, data: EventData): void {
  if (!gateNames.includes(data.gate))
    throw new ArkError(`unknown gate "${data.gate}": use ${gateNames.join(", ")}`);
  // The strategy gate takes the id of a card in the latest strategy.recorded, or abort.
  const answers =
    data.gate === "strategy" ? [...(state.strategy?.cards ?? []), "abort"] : gateAnswers[data.gate];
  if (!answers.includes(data.answer)) {
    throw new ArkError(
      `unknown answer "${data.answer}" for gate ${data.gate}: use ${answers.join(", ")}`,
    );
  }
  if (data.gate === "manual" && !state.criteria.some((c) => c.id === data.criterion))
    throw new ArkError(
      `gate.answered manual refused: criterion ${data.criterion} is not in the ticket`,
    );
  const phaseOfGate = {
    criteria: "awaiting_criteria",
    strategy: "awaiting_strategy",
    plan: "planning",
    escalation: "escalation",
    manual: "building",
  }[data.gate as "criteria" | "strategy" | "plan" | "escalation" | "manual"];
  if (
    state.phase !== phaseOfGate &&
    !(data.gate === "escalation" && state.phase === "merge_requests_open") &&
    // A spent budget at step start in building: only the auto path answers there.
    !(data.gate === "escalation" && state.phase === "building" && data.by === "auto") &&
    !(data.gate === "manual" && state.phase === "escalation")
  ) {
    throw new ArkError(
      `gate.answered ${data.gate} ${data.answer} refused: run is in phase ${state.phase}, the ${data.gate} gate opens in phase ${phaseOfGate}`,
    );
  }
  if (data.gate === "criteria" && data.answer === "accept" && state.criteria.length === 0) {
    throw new ArkError(
      "gate.answered criteria accept refused: the ticket has no criteria (criteria.updated needs at least one)",
    );
  }
  if (data.gate === "plan" && data.answer === "approve") {
    if (!state.plan?.valid)
      throw new ArkError("gate.answered plan approve refused: missing plan.checked valid");
    if (state.plan.open_decisions > 0) {
      throw new ArkError(
        `gate.answered plan approve refused: the plan has ${state.plan.open_decisions} open decision${state.plan.open_decisions === 1 ? "" : "s"}; write the human's answers into plan.yml chosen and run ark plan check again`,
      );
    }
  }
}

function assertCloseAllowed(state: RunState, data: EventData): void {
  if (!outcomes.includes(data.outcome))
    throw new ArkError(`unknown outcome "${data.outcome}": use ${outcomes.join(", ")}`);
  const hasMergeRequests = state.merge_requests.length > 0;
  if ((data.outcome === "merged" || data.outcome === "abandoned") && !hasMergeRequests) {
    throw new ArkError(`run.closed ${data.outcome} refused: missing merge_request.opened`);
  }
  if (data.outcome === "handed_off") {
    if (hasMergeRequests)
      throw new ArkError("run.closed handed_off refused: the run has merge requests");
    if (!state.last_test?.passed)
      throw new ArkError("run.closed handed_off refused: missing test.completed with passed true");
  }
}
