import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ArkError, yamlQuoteHint } from "./errors.ts";
import { canonicalCriterion } from "./criterion-id.ts";

export type PlanStep = {
  id: string;
  role: string;
  repo: string;
  harness: string;
  model: string;
  needs: string[];
  criteria: string[];
  skills: string[];
  /** Optional text of what the step does. A perf plan names `results/baseline.md` and `results/compare.md` here. */
  goal: string;
};

export type PlanTestCase = {
  /** A test case id `<KEY>-T<n>`. An old plan (before ARK-311) has a free id here. */
  id: string;
  /** `add`, `update`, `reuse` or `retire`. Empty in the old shape: free id, one `criterion`, no action. */
  action: string;
  /** Old shape only: the one AC the case proves. A new-shape case serves the ACs whose `verified_by` lists it. */
  criterion: string;
  title: string;
  /** Why a `retire` case goes. */
  reason: string;
  level: string;
  given: string[];
  when: string[];
  then: string[];
  expected: string;
};

export type PlanInterface = { name: string; callers: string[] };
export type PlanDesign = { approach: string; interfaces: PlanInterface[]; example: string };

export type PlanSummaryChange = { criterion: string; where: string; now: string; fix: string };
export type PlanDecision = {
  id: string;
  question: string;
  options: { label: string; tradeoffs: string }[];
  recommended: string;
  /** Empty while the human has not answered. */
  chosen: string;
};
/** An edge of the repo graph: the repo of the entry depends on `repo`. `evidence` is a file and line; `bump` a step id. */
export type PlanRepoEdge = {
  repo: string;
  kind: string;
  pin: string;
  evidence: string;
  bump: string;
};
export type PlanRepo = { repo: string; why: string; depends_on: PlanRepoEdge[] };
export type Plan = {
  summary: { why: string; changes: PlanSummaryChange[] };
  design: PlanDesign;
  decisions: PlanDecision[];
  repos: PlanRepo[];
  steps: PlanStep[];
  test_cases: PlanTestCase[];
};

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const textList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => (item == null ? "" : String(item))) : [];
const objectList = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.map((item) =>
        item && typeof item === "object" ? (item as Record<string, unknown>) : {},
      )
    : [];

export function planHash(runDirectory: string): string {
  const file = join(runDirectory, "plan.yml");
  if (!existsSync(file)) throw new ArkError(`plan.yml not found in ${runDirectory}`);
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** `ticketId` turns `AC1` and the old `<ticket>-AC1` into `<ticket>/AC1` in the AC ids of the plan. */
export function loadPlan(runDirectory: string, ticketId?: string): Plan {
  const file = join(runDirectory, "plan.yml");
  if (!existsSync(file)) throw new ArkError(`plan.yml not found in ${runDirectory}`);
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ArkError(`plan.yml is not valid YAML: ${(err as Error).message} (${yamlQuoteHint})`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ArkError("plan.yml must be a mapping with steps and test_cases");
  }
  const { steps, test_cases, summary, design, decisions, repos } = raw as Record<string, unknown>;
  const criterionId = (value: string) => canonicalCriterion(value.trim(), ticketId);
  const designBlock =
    design && typeof design === "object" ? (design as Record<string, unknown>) : {};
  const summaryBlock =
    summary && typeof summary === "object" ? (summary as Record<string, unknown>) : {};
  return {
    summary: {
      why: text(summaryBlock.why),
      changes: objectList(summaryBlock.changes).map((change) => ({
        criterion: criterionId(text(change.criterion)),
        where: text(change.where),
        now: text(change.now),
        fix: text(change.fix),
      })),
    },
    design: {
      approach: text(designBlock.approach),
      interfaces: objectList(designBlock.interfaces).map((entry) => ({
        name: text(entry.name),
        callers: textList(entry.callers).map((caller) => caller.trim()),
      })),
      example: text(designBlock.example),
    },
    decisions: objectList(decisions).map((decision) => ({
      id: text(decision.id),
      question: text(decision.question),
      options: (Array.isArray(decision.options) ? decision.options : []).map((option: unknown) =>
        typeof option === "string"
          ? { label: option, tradeoffs: "" }
          : {
              label: text((option as Record<string, unknown>)?.label),
              tradeoffs: text((option as Record<string, unknown>)?.tradeoffs),
            },
      ),
      recommended: text(decision.recommended),
      chosen: text(decision.chosen),
    })),
    repos: objectList(repos).map((entry) => ({
      repo: text(entry.repo),
      why: text(entry.why),
      depends_on: objectList(entry.depends_on).map((edge) => ({
        repo: text(edge.repo),
        kind: text(edge.kind),
        pin: text(edge.pin),
        evidence: text(edge.evidence),
        bump: text(edge.bump),
      })),
    })),
    steps: objectList(steps).map((step) => ({
      id: text(step.id),
      role: text(step.role),
      repo: text(step.repo),
      harness: text(step.harness),
      model: text(step.model),
      needs: textList(step.needs),
      criteria: textList(step.criteria).map(criterionId),
      skills: textList(step.skills),
      goal: text(step.goal),
    })),
    test_cases: objectList(test_cases).map((testCase) => {
      const name = text(testCase.id) || "(no id)";
      if (Object.hasOwn(testCase, "steps")) {
        throw new ArkError(`test case ${name} has the old steps field: use given, when and then`);
      }
      const action = text(testCase.action);
      // A reuse or retire entry has no scenario; an unknown action is refused by the check, not here.
      const needsScenario = action === "" || action === "add" || action === "update";
      for (const group of ["given", "when", "then"] as const) {
        if (
          needsScenario &&
          (!Array.isArray(testCase[group]) ||
            !testCase[group].every((line) => typeof line === "string"))
        ) {
          throw new ArkError(`test case ${name} ${group} must be a list of strings`);
        }
      }
      return {
        id: text(testCase.id),
        action,
        criterion: criterionId(text(testCase.criterion)),
        title: text(testCase.title),
        reason: text(testCase.reason),
        level: text(testCase.level),
        given: textList(testCase.given),
        when: textList(testCase.when),
        // oxlint-disable-next-line unicorn/no-thenable -- plan test-case field `then: string[]`, not a Promise-like
        then: textList(testCase.then),
        expected: text(testCase.expected),
      };
    }),
  };
}

// Stable output: nodes in file order, then edges in file order. Node names are
// positional so step ids such as "end" or ids with punctuation cannot break the diagram.
// A plan with steps in several repos draws one subgraph per repo, in merge order.
export function renderMermaid(plan: Plan): string {
  const nodeName = new Map(plan.steps.map((step, i) => [step.id, `step${i + 1}`]));
  const lines = ["flowchart LR"];
  if (hasMultipleRepos(plan)) {
    const { order, upstream } = repoGraph(plan);
    const quote = (value: string) => value.replaceAll('"', "#quot;");
    const drawn = new Set(plan.steps.map((step) => step.repo));
    order.forEach((repo, r) => {
      if (!drawn.has(repo)) return;
      lines.push(`  subgraph repo${r + 1}["${quote(`${r + 1} ${repo}`)}"]`);
      plan.steps.forEach((step, i) => {
        if (step.repo === repo)
          lines.push(`    step${i + 1}["${quote(`${step.id}: ${step.role}`)}"]`);
      });
      lines.push("  end");
    });
    plan.steps.forEach((step) => {
      plan.steps.forEach((target, j) => {
        if (!target.needs.includes(step.id)) return;
        const arrow = step.repo === target.repo ? "-->" : "==>";
        lines.push(`  ${nodeName.get(step.id)} ${arrow} step${j + 1}`);
      });
    });
    order.forEach((repo, r) => {
      order.forEach((downstream, d) => {
        if (!upstream.get(downstream)!.has(repo) || !drawn.has(repo) || !drawn.has(downstream))
          return;
        const entry = plan.repos.find((candidate) => candidate.repo === downstream);
        for (const edge of entry?.depends_on.filter((candidate) => candidate.repo === repo) ?? [])
          lines.push(`  repo${r + 1} -.->|"${quote(`${edge.kind} ${edge.pin}`)}"| repo${d + 1}`);
      });
    });
    return `${lines.join("\n")}\n`;
  }
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

export const hasMultipleRepos = (plan: Pick<Plan, "steps">): boolean =>
  new Set(plan.steps.map((step) => step.repo)).size > 1;

/**
 * The repos of a plan in merge order, and the upstream repos each one waits for. With a `repos` list the edges come
 * from it and step `needs` make none; with no list (an old plan) they come from step `needs`.
 * Ties go by first step of the repo in the plan, then by name, so the order does not depend on the list order.
 */
export function repoGraph(plan: {
  steps: { id: string; repo: string; needs: string[] }[];
  repos?: PlanRepo[];
}): { order: string[]; upstream: Map<string, Set<string>> } {
  const upstream = new Map<string, Set<string>>();
  const stepRepos = [...new Set(plan.steps.map((step) => step.repo))];
  for (const repo of stepRepos) upstream.set(repo, new Set());
  if (plan.repos && plan.repos.length > 0) {
    const extras = new Set<string>();
    for (const entry of plan.repos) {
      extras.add(entry.repo);
      for (const edge of entry.depends_on) extras.add(edge.repo);
    }
    for (const repo of [...extras].filter((repo) => !upstream.has(repo)).sort())
      upstream.set(repo, new Set());
    for (const entry of plan.repos)
      for (const edge of entry.depends_on) upstream.get(entry.repo)!.add(edge.repo);
  } else {
    const repoOfStep = new Map(plan.steps.map((step) => [step.id, step.repo]));
    for (const step of plan.steps)
      for (const needed of step.needs) {
        const neededRepo = repoOfStep.get(needed);
        if (neededRepo !== undefined && neededRepo !== step.repo)
          upstream.get(step.repo)!.add(neededRepo);
      }
  }
  const repos = [...upstream.keys()];
  const order: string[] = [];
  while (order.length < repos.length) {
    const next = repos.find(
      (repo) =>
        !order.includes(repo) &&
        [...upstream.get(repo)!].every((dependency) => order.includes(dependency)),
    );
    if (next === undefined) {
      const remaining = repos.filter((repo) => !order.includes(repo));
      throw new ArkError(`the plan has a dependency cycle between repos: ${remaining.join(", ")}`);
    }
    order.push(next);
  }
  return { order, upstream };
}
