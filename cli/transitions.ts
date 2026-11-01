import { ArkError } from "./errors.ts";
import type { EventData, RunState } from "./events.ts";

export const outcomes = ["merged", "abandoned", "aborted", "handed_off"];

const gateAnswers: Record<string, string[]> = {
  criteria: ["accept", "edit", "abort"],
  plan: ["approve", "change", "abort"],
  escalation: ["one_more_round", "take_over", "abort"],
};

const buildPhases = ["building", "escalation"];

/** The event that moves a run out of `phase`, named in refusals. */
function missingEvent(state: RunState): string {
  if (state.phase === "awaiting_criteria")
    return state.evaluation?.blockers.length
      ? "gate.answered criteria accept (the evaluation has blockers)"
      : "gate.answered criteria accept";
  if (state.phase === "planning")
    return state.plan?.valid
      ? "gate.answered plan approve"
      : "plan.checked valid, then gate.answered plan approve";
  return `a run in phase ${state.phase}`;
}

function requirePhase(state: RunState, type: string, phases: string[]): void {
  if (phases.includes(state.phase)) return;
  throw new ArkError(
    `${type} refused: run is in phase ${state.phase}; missing ${missingEvent(state)}`,
  );
}

/** Throws an ArkError naming the missing event when `type` is not allowed in `state`. */
export function assertAllowed(state: RunState, type: string, data: EventData): void {
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
    case "evaluation.recorded":
      requirePhase(state, type, ["awaiting_criteria", "planning"]);
      for (const list of ["blockers", "risks"])
        if (!Array.isArray(data[list]) || !data[list].every((line) => typeof line === "string"))
          throw new ArkError(`evaluation.recorded refused: ${list} must be a list of strings`);
      return;
    case "plan.checked":
      requirePhase(state, type, ["planning", "building", "escalation"]);
      if (!state.evaluation)
        throw new ArkError(
          "plan.checked refused: missing evaluation.recorded (ark evaluation record)",
        );
      return;
    case "gate.answered":
      return assertGateAllowed(state, data);
    case "worktree.created":
      requirePhase(state, type, ["planning", ...buildPhases]);
      return;
    case "step.started":
      requirePhase(state, type, buildPhases);
      if (state.steps.find((step) => step.id === data.step)?.status === "running")
        throw new ArkError(`step.started refused: step ${data.step} is already running`);
      if (
        data.role === "implementer" &&
        data.round > 1 &&
        data.round > state.round_budget &&
        state.implementer !== "human"
      ) {
        throw new ArkError(
          "round budget spent: record gate escalation (one_more_round, take_over or abort)",
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
    case "test.completed":
      requirePhase(state, type, buildPhases);
      return;
    case "merge_request.opened":
      requirePhase(state, type, ["building", "merge_requests_open"]);
      return;
    case "run.closed":
      return assertCloseAllowed(state, data);
    default:
      throw new ArkError(`unknown event type: ${type}`);
  }
}

function assertGateAllowed(state: RunState, data: EventData): void {
  if (!Object.hasOwn(gateAnswers, data.gate))
    throw new ArkError(`unknown gate "${data.gate}": use ${Object.keys(gateAnswers).join(", ")}`);
  if (!gateAnswers[data.gate].includes(data.answer)) {
    throw new ArkError(
      `unknown answer "${data.answer}" for gate ${data.gate}: use ${gateAnswers[data.gate].join(", ")}`,
    );
  }
  const phaseOfGate = { criteria: "awaiting_criteria", plan: "planning", escalation: "escalation" }[
    data.gate as "criteria" | "plan" | "escalation"
  ];
  if (state.phase !== phaseOfGate) {
    throw new ArkError(
      `gate.answered ${data.gate} ${data.answer} refused: run is in phase ${state.phase}, the ${data.gate} gate opens in phase ${phaseOfGate}`,
    );
  }
  if (data.gate === "criteria" && data.answer === "accept" && state.criteria.length === 0) {
    throw new ArkError(
      "gate.answered criteria accept refused: the ticket has no criteria (criteria.updated needs at least one)",
    );
  }
  if (data.gate === "plan" && data.answer === "approve" && !state.plan?.valid) {
    throw new ArkError("gate.answered plan approve refused: missing plan.checked valid");
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
