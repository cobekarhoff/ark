import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalCriterion } from "./criterion-id.ts";
import { ArkError } from "./errors.ts";
import { now } from "./clock.ts";
import type { CriterionStatus, Phase, StepStatus, TicketKind } from "./lifecycle.ts";
import { assertAllowed } from "./transitions.ts";

export type EventData = Record<string, any>;
export type ArkEvent = { seq: number; time: string; type: string; data: EventData };

export type RunState = {
  run: string;
  project: string;
  ticket: { id: string; title: string };
  /** From run.started; an event with no kind reads as feature. */
  kind: TicketKind;
  phase: Phase;
  round: number;
  round_budget: number;
  criteria: { id: string; status: CriterionStatus }[];
  /** Each amended criterion: the text before its first amendment and the latest text. */
  amended_criteria: { id: string; old: string; new: string; by: string; reason: string }[];
  /** The manual gate is answered once for each criterion: key `manual:<criterion>`. */
  gates: {
    criteria?: string;
    strategy?: string;
    plan?: string;
    escalation?: string;
    [manual: `manual:${string}`]: string;
  };
  post_mr_escalation_answered: boolean;
  /** escalation.requested is pending: no answer has followed it. */
  escalation_requested: boolean;
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
  worktrees: { repo: string; path: string; branch: string; base?: string }[];
  sync_conflicts: string[];
  /** Value of the last `bump.refreshed` of each bump step. */
  bump_refreshed: Record<string, string>;
  last_test: { passed: boolean; heads: Record<string, string> } | null;
  /** Some test.completed had every non-manual criterion failing: the bug run's proof that the tests fail before the fix. */
  red_test: boolean;
  /** Suites at the base commit of a refactor run: undefined until `ark test` ran them. */
  base_passed?: boolean;
  merge_requests: {
    repo: string;
    url: string;
    number: number;
    order?: number;
    waits_for?: number[];
  }[];
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
  assertAllowed(deriveState(events), type, data, runDirectory);
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
  // run.started has `criteria_gate: true` on every run since ARK-311; an older log keeps its old phase rule.
  let gateAlwaysOpen = false;
  // Old events name an AC `<ticket>-AC<k>` or `AC<k>`: read them as `<ticket>/AC<k>`.
  const alias = (id: string) => canonicalCriterion(id, ticket.id);
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
  const amendments = new Map<string, RunState["amended_criteria"][number]>();
  let planApproved = false;
  let approvedPlanHash: string | null = null;
  let planSteps: { id: string; role: string; repo: string }[] = [];
  const stepStatus = new Map<string, StepStatus>();
  const startedSteps: { id: string; role: string; repo: string }[] = [];
  const worktrees: RunState["worktrees"] = [];
  const syncConflicts = new Set<string>();
  const bumpRefreshed: Record<string, string> = {};
  let lastTest: RunState["last_test"] = null;
  let kind: TicketKind = "feature";
  const testRuns: Record<string, string>[] = [];
  let basePassed: boolean | undefined;
  let escalation: "none" | "requested" | "answered" = "none";
  const mergeRequests: RunState["merge_requests"] = [];
  let outcome: string | null = null;
  let human = false;

  for (const { type, data } of events) {
    switch (type) {
      case "run.started":
        run = data.run ?? "";
        kind = data.kind ?? "feature";
        project = data.project;
        ticket = { id: data.ticket.id, title: data.ticket.title };
        criteriaIds = data.criteria.map(alias);
        gateAlwaysOpen = data.criteria_gate === true;
        startedWithoutCriteria = criteriaIds.length === 0;
        roundBudget = data.round_budget ?? 0;
        break;
      case "criteria.updated":
        criteriaIds = data.criteria.map(alias);
        criteriaStatus = {};
        break;
      case "criteria.amended": {
        const id = alias(data.criterion);
        const first = amendments.get(id);
        amendments.set(id, {
          id,
          old: first?.old ?? data.old,
          new: data.new,
          by: data.by ?? "human",
          reason: data.reason ?? "",
        });
        // New text needs a new human decision: an earlier manual answer no longer stands.
        delete gates[`manual:${id}`];
        // The amendment changes what plan.md must show, so the plan needs a new check.
        if (!planApproved) plan = null;
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
        gates[data.gate === "manual" ? `manual:${alias(data.criterion)}` : data.gate] = data.answer;
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
          escalation = "answered";
          if (data.answer === "one_more_round") roundBudget += 1;
          if (data.answer === "take_over") human = true;
        }
        break;
      case "worktree.created": {
        const known = worktrees.findIndex((worktree) => worktree.repo === data.repo);
        const worktree = { repo: data.repo, path: data.path, branch: data.branch, base: data.base };
        if (known === -1) worktrees.push(worktree);
        else worktrees[known] = worktree;
        break;
      }
      case "bump.refreshed":
        bumpRefreshed[data.step] = data.value;
        break;
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
        if (mergeRequests.length > 0 && data.role === "implementer" && escalation === "answered")
          escalation = "none";
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
        criteriaStatus = Object.fromEntries(
          Object.entries((data.criteria ?? {}) as Record<string, CriterionStatus>).map(
            ([id, status]) => [alias(id), status],
          ),
        );
        lastTest = { passed: data.passed, heads: data.heads };
        basePassed = data.base_passed ?? basePassed;
        testRuns.push(criteriaStatus);
        if (mergeRequests.length === 0 && escalation === "answered") escalation = "none";
        break;
      case "escalation.requested":
        escalation = "requested";
        break;
      case "merge_request.opened":
        if (mergeRequests.length === 0 && escalation === "answered") escalation = "none";
        mergeRequests.push({
          repo: data.repo,
          url: data.url,
          number: data.number,
          ...(data.order === undefined ? {} : { order: data.order }),
          ...(data.waits_for === undefined ? {} : { waits_for: data.waits_for }),
        });
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
  else if (blocked || ((startedWithoutCriteria || gateAlwaysOpen) && gates.criteria !== "accept"))
    phase = "awaiting_criteria";
  else if (strategy && strategy.count >= 2 && strategy.chosen === null) phase = "awaiting_strategy";
  else if (!planApproved) phase = "planning";
  else if (
    round >= roundBudget &&
    (escalation === "requested" || (escalation === "none" && lastTest && !lastTest.passed)) &&
    !human
  )
    phase = "escalation";
  else phase = "building";

  // Red proof: one test run where every current non-manual criterion failed.
  const redTest = testRuns.some((statuses) => {
    const required = criteriaIds.filter((id) => !statuses[id]?.startsWith("manual"));
    return required.length > 0 && required.every((id) => statuses[id] === "failing");
  });

  return {
    run,
    project,
    ticket,
    kind,
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
      ...Object.fromEntries(Object.entries(gates).filter(([key]) => key.startsWith("manual:"))),
    },
    post_mr_escalation_answered: escalation === "answered" && mergeRequests.length > 0,
    escalation_requested: escalation === "requested",
    evaluation,
    strategy,
    plan,
    steps,
    current_step: steps.find((step) => step.status !== "succeeded")?.id ?? null,
    worktrees,
    sync_conflicts: [...syncConflicts],
    bump_refreshed: bumpRefreshed,
    last_test: lastTest,
    red_test: redTest,
    ...(basePassed === undefined ? {} : { base_passed: basePassed }),
    merge_requests: mergeRequests,
    outcome,
    ...(human ? { implementer: "human" as const } : {}),
    events: events.length,
  };
}

/** The gate a run waits on, or `none`. */
export function waitingGate(state: RunState): string {
  if (state.phase === "awaiting_criteria") return "criteria";
  if (state.phase === "awaiting_strategy") return "strategy";
  if (state.phase === "planning" && state.plan?.valid) return "plan";
  if (state.phase === "escalation") return "escalation";
  return "none";
}

export type StepWindow = {
  id: string;
  role: string;
  repo: string;
  start: number;
  end: number | null;
};

export type StageTimes = { evaluationEnd?: number; designStart?: number; designEnd?: number };

/** When each step ran, in milliseconds: one window per step.started, closed by its step.finished. */
export function stepWindows(events: ArkEvent[]): StepWindow[] {
  const windows: StepWindow[] = [];
  for (const event of events) {
    if (event.type === "step.started") {
      windows.push({
        id: event.data.step,
        role: event.data.role,
        repo: event.data.repo,
        start: Date.parse(event.time),
        end: null,
      });
    }
    if (event.type === "step.finished") {
      const open = windows.findLast(
        (window) => window.id === event.data.step && window.end === null,
      );
      if (open) open.end = Date.parse(event.time);
    }
  }
  return windows;
}

/**
 * When the evaluator and the Designer sessions ran, in milliseconds. The evaluator session ends at
 * the last evaluation.recorded (the run lead session outlasts it). The Designer session runs after
 * the first evaluation and ends by the last strategy record or strategy answer.
 */
export function stageTimes(events: ArkEvent[]): StageTimes {
  const time = (event: ArkEvent | undefined) => (event ? Date.parse(event.time) : undefined);
  return {
    evaluationEnd: time(events.findLast((event) => event.type === "evaluation.recorded")),
    designStart: time(events.find((event) => event.type === "evaluation.recorded")),
    designEnd: time(
      events.findLast(
        (event) =>
          event.type === "strategy.recorded" ||
          (event.type === "gate.answered" && event.data.gate === "strategy"),
      ),
    ),
  };
}
