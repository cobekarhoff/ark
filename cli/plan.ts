import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ArkError } from "./errors.ts";
import { appendEvent, deriveState, readEvents } from "./events.ts";
import { findRun } from "./paths.ts";

export type PlanStep = {
  id: string;
  role: string;
  repo: string;
  harness: string;
  model: string;
  needs: string[];
  criteria: string[];
};

export type PlanTestCase = {
  id: string;
  criterion: string;
  level: string;
  steps: string[];
  expected: string;
};

export type Plan = { steps: PlanStep[]; test_cases: PlanTestCase[] };

const roles = ["implementer", "validator", "reviewer"];
const levels = ["integration", "e2e"];

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const textList = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
const objectList = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : {})) : [];

export function planHash(runDirectory: string): string {
  const file = join(runDirectory, "plan.yml");
  if (!existsSync(file)) throw new ArkError(`plan.yml not found in ${runDirectory}`);
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function loadPlan(runDirectory: string): Plan {
  const file = join(runDirectory, "plan.yml");
  if (!existsSync(file)) throw new ArkError(`plan.yml not found in ${runDirectory}`);
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ArkError(`plan.yml is not valid YAML: ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ArkError("plan.yml must be a mapping with steps and test_cases");
  }
  const { steps, test_cases } = raw as Record<string, unknown>;
  return {
    steps: objectList(steps).map((step) => ({
      id: text(step.id),
      role: text(step.role),
      repo: text(step.repo),
      harness: text(step.harness),
      model: text(step.model),
      needs: textList(step.needs),
      criteria: textList(step.criteria),
    })),
    test_cases: objectList(test_cases).map((testCase) => ({
      id: text(testCase.id),
      criterion: text(testCase.criterion),
      level: text(testCase.level),
      steps: textList(testCase.steps),
      expected: text(testCase.expected),
    })),
  };
}

// Stable output: nodes in file order, then edges in file order. Node names are
// positional so step ids such as "end" or ids with punctuation cannot break the diagram.
export function renderMermaid(plan: Plan): string {
  const nodeName = new Map(plan.steps.map((step, i) => [step.id, `step${i + 1}`]));
  const lines = ["flowchart LR"];
  plan.steps.forEach((step, i) => {
    const label = `${step.id}: ${step.role} @ ${step.repo}`.replaceAll('"', "#quot;");
    lines.push(`  step${i + 1}["${label}"]`);
  });
  plan.steps.forEach((step, i) => {
    for (const need of step.needs) {
      const from = nodeName.get(need);
      if (from) lines.push(`  ${from} --> step${i + 1}`);
    }
  });
  return `${lines.join("\n")}\n`;
}

function findCycles(plan: Plan): string[][] {
  const needsById = new Map(plan.steps.map((step) => [step.id, step.needs]));
  const finished = new Set<string>();
  const path: string[] = [];
  const cycles: string[][] = [];
  const visit = (id: string) => {
    const onPath = path.indexOf(id);
    if (onPath >= 0) {
      cycles.push([...path.slice(onPath), id]);
      return;
    }
    if (finished.has(id) || !needsById.has(id)) return;
    path.push(id);
    for (const need of needsById.get(id)!) visit(need);
    path.pop();
    finished.add(id);
  };
  for (const step of plan.steps) visit(step.id);
  return cycles;
}

export function findProblems(plan: Plan, ticketCriteria: string[]): string[] {
  const problems: string[] = [];
  const stepIds = new Set<string>();
  plan.steps.forEach((step, i) => {
    const name = step.id || `#${i + 1}`;
    if (!step.id) problems.push(`step #${i + 1} has no id`);
    else if (stepIds.has(step.id)) problems.push(`duplicate step id: ${step.id}`);
    stepIds.add(step.id);
    if (!step.role) problems.push(`step ${name} has no role`);
    else if (!roles.includes(step.role)) {
      problems.push(`step ${name} has unknown role "${step.role}": use ${roles.join(", ")}`);
    }
    if (!step.repo) problems.push(`step ${name} has no repo`);
    if (!step.harness) problems.push(`step ${name} has no harness`);
    if (!step.model) problems.push(`step ${name} has no model`);
  });
  for (const step of plan.steps) {
    for (const need of step.needs) {
      if (!stepIds.has(need)) problems.push(`step ${step.id} needs "${need}", which is not a step`);
    }
  }
  for (const cycle of findCycles(plan)) problems.push(`cycle in needs: ${cycle.join(" -> ")}`);

  const proven = new Set<string>();
  for (const testCase of plan.test_cases) {
    const name = testCase.id || "(no id)";
    if (!levels.includes(testCase.level)) {
      problems.push(`test case ${name} has level "${testCase.level}": use integration or e2e`);
      continue;
    }
    if (!ticketCriteria.includes(testCase.criterion)) {
      problems.push(`test case ${name} is for criterion "${testCase.criterion}", which is not in the ticket`);
      continue;
    }
    proven.add(testCase.criterion);
  }
  for (const criterion of ticketCriteria) {
    if (!proven.has(criterion)) problems.push(`criterion ${criterion} has no integration or e2e test case`);
  }
  return problems;
}

export function planCheck(runId: string): void {
  const { directory } = findRun(runId);
  const plan = loadPlan(directory);
  const state = deriveState(readEvents(directory));
  const problems = findProblems(plan, state.criteria.map((criterion) => criterion.id));
  const valid = problems.length === 0;
  appendEvent(directory, "plan.checked", {
    valid,
    problems,
    plan_hash: planHash(directory),
    steps: plan.steps.map(({ id, role, repo, needs, criteria }) => ({ id, role, repo, needs, criteria })),
  });
  if (!valid) {
    for (const problem of problems) console.log(problem);
    throw new ArkError(`plan is invalid: ${problems.length} problem${problems.length === 1 ? "" : "s"}`);
  }
  writeFileSync(join(directory, "plan.mmd"), renderMermaid(plan));
  console.log(`plan is valid: ${plan.steps.length} steps, ${plan.test_cases.length} test cases; wrote plan.mmd`);
}
