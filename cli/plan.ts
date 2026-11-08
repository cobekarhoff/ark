import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ProjectConfig, loadConfig } from "./config.ts";
import { ArkError, yamlQuoteHint } from "./errors.ts";
import { runCriteria, type TicketCriterion } from "./criteria.ts";
import { canonicalCriterion, isCaseId } from "./criterion-id.ts";
import { type RunState, appendEvent, deriveState, readEvents } from "./events.ts";
import type { TicketKind } from "./lifecycle.ts";
import { findRun } from "./paths.ts";
import { assertAllowed } from "./transitions.ts";
import { readWorkspaceCases, type CaseEntry } from "./test-case.ts";
import { discoverRepos } from "./workspace.ts";
import { allowedUiSkills, uiSkillsFor } from "./ui-skills.ts";

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

const edgeKinds = ["submodule", "package", "compose", "api"];

const roles = ["implementer", "validator", "reviewer"];
const levels = ["integration", "e2e"];
const actions = ["add", "update", "reuse", "retire"];
const caseLevels = ["unit", "integration", "e2e"];

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
  if (multiRepo(plan)) {
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

const multiRepo = (plan: Plan): boolean => new Set(plan.steps.map((step) => step.repo)).size > 1;

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

/** Problems of the `repos` block. Each names the repo and the edge as `<downstream> -> <upstream>, <kind>`. */
function repoProblems(plan: Plan, workspaceRepos: string[]): string[] {
  const problems: string[] = [];
  const edgeName = (repo: string, edge: PlanRepoEdge) => `${repo} -> ${edge.repo}, ${edge.kind}`;
  const inWorkspace = (repo: string) => workspaceRepos.includes(repo);
  const stepById = new Map(plan.steps.map((step) => [step.id, step]));
  const listed = new Set<string>();
  for (const entry of plan.repos) {
    if (listed.has(entry.repo)) problems.push(`repos: ${entry.repo} is listed twice`);
    listed.add(entry.repo);
    if (!inWorkspace(entry.repo))
      problems.push(`repos: ${entry.repo} is not a repo of the workspace`);
    for (const edge of entry.depends_on) {
      const name = edgeName(entry.repo, edge);
      if (!inWorkspace(edge.repo))
        problems.push(`repos: ${edge.repo} is not a repo of the workspace (${name})`);
      if (!edgeKinds.includes(edge.kind))
        problems.push(`repos: kind "${edge.kind}" is not ${edgeKinds.join(", ")} (${name})`);
      if (!edge.pin) problems.push(`repos: edge has no pin (${name})`);
      if (!edge.evidence) problems.push(`repos: edge has no evidence (${name})`);
      if (edge.bump) {
        const step = stepById.get(edge.bump);
        if (!step) problems.push(`repos: bump ${edge.bump} names no step (${name})`);
        else if (step.repo !== entry.repo)
          problems.push(
            `repos: bump ${edge.bump} is a step of ${step.repo}, not of ${entry.repo} (${name})`,
          );
      }
    }
  }
  const reported = new Set<string>();
  for (const step of plan.steps) {
    if (step.repo && !listed.has(step.repo) && !reported.has(step.repo)) {
      reported.add(step.repo);
      problems.push(`repos: step ${step.id} is in ${step.repo}, which is not in the repos list`);
    }
  }

  const dependsOn = new Map(plan.repos.map((entry) => [entry.repo, entry.depends_on]));
  const finished = new Set<string>();
  const path: string[] = [];
  const visit = (repo: string) => {
    const start = path.indexOf(repo);
    if (start >= 0) {
      const cycle = [...path.slice(start), repo];
      const from = cycle.at(-2)!;
      const closing = dependsOn.get(from)!.find((edge) => edge.repo === repo)!;
      problems.push(`repos: repo cycle ${cycle.join(" -> ")} (${edgeName(from, closing)})`);
      return;
    }
    if (finished.has(repo) || !dependsOn.has(repo)) return;
    path.push(repo);
    for (const edge of dependsOn.get(repo)!) visit(edge.repo);
    path.pop();
    finished.add(repo);
  };
  for (const entry of plan.repos) visit(entry.repo);

  // A step of a downstream repo must follow, through needs, an implementer step of an upstream repo.
  // Only an implementer counts as a change: validator and reviewer steps make no demand.
  // The bump step of an edge must follow an implementer of that edge's repo; any other step of the
  // downstream repo must follow an implementer of one of its upstream repos.
  const ancestors = (id: string, seen = new Set<string>()): Set<string> => {
    for (const need of stepById.get(id)?.needs ?? [])
      if (!seen.has(need)) {
        seen.add(need);
        ancestors(need, seen);
      }
    return seen;
  };
  const implementers = (repo: string) =>
    plan.steps.filter((step) => step.repo === repo && step.role === "implementer");
  const follows = (stepId: string, repo: string) => {
    const before = ancestors(stepId);
    return implementers(repo).some((upstreamStep) => before.has(upstreamStep.id));
  };
  for (const entry of plan.repos) {
    const edges = entry.depends_on.filter(
      (edge) => edge.repo !== entry.repo && implementers(edge.repo).length > 0,
    );
    const bumps = new Set(edges.map((edge) => edge.bump));
    const downstream = plan.steps.filter((candidate) => candidate.repo === entry.repo);
    // Each changed upstream edge needs its own path: through its bump step, or else any step of the repo.
    for (const edge of edges) {
      const bump = edge.bump && stepById.get(edge.bump)?.repo === entry.repo ? edge.bump : "";
      const reached = bump
        ? follows(bump, edge.repo)
        : downstream.some((step) => follows(step.id, edge.repo));
      if (!reached)
        problems.push(
          `repos: no needs path from an implementer of ${edge.repo} to ${bump ? `${entry.repo} step ${bump}` : `a step of ${entry.repo}`} (${edgeName(entry.repo, edge)})`,
        );
    }
    if (edges.length === 0) continue;
    for (const step of plan.steps.filter((candidate) => candidate.repo === entry.repo)) {
      if (bumps.has(step.id) || edges.some((edge) => follows(step.id, edge.repo))) continue;
      problems.push(
        `repos: no needs path from an implementer of ${edges.map((edge) => edge.repo).join(", ")} to ${entry.repo} step ${step.id} (${edgeName(entry.repo, edges[0])})`,
      );
    }
  }
  return problems;
}

export function findProblems(
  plan: Plan,
  ticketCriteria: string[],
  surfaces: string[],
  configuredRoles: ProjectConfig["roles"],
  manual: string[] = [],
  kind: TicketKind = "feature",
  links: { criteria: TicketCriterion[]; entries: CaseEntry[] } = { criteria: [], entries: [] },
  workspaceRepos: string[] = [],
): string[] {
  const allowedPairs = [
    ...new Set(Object.values(configuredRoles).map((role) => `${role.harness}/${role.model}`)),
  ];
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
    if (step.harness && step.model && !allowedPairs.includes(`${step.harness}/${step.model}`)) {
      problems.push(
        `step ${name} uses ${step.harness}/${step.model}, which is not in ark.yml roles: ${allowedPairs.join(", ")}`,
      );
    }
  });
  for (const step of plan.steps) {
    for (const need of step.needs) {
      if (!stepIds.has(need)) problems.push(`step ${step.id} needs "${need}", which is not a step`);
    }
  }
  for (const cycle of findCycles(plan)) problems.push(`cycle in needs: ${cycle.join(" -> ")}`);

  const proven = new Set<string>();
  const entryById = new Map(links.entries.map((entry) => [entry.id, entry]));
  const planById = new Map<string, PlanTestCase>();
  for (const testCase of plan.test_cases) {
    const name = testCase.id || "(no id)";
    const modern = testCase.action !== "";
    if (modern && !actions.includes(testCase.action)) {
      problems.push(
        `test case ${name} has action "${testCase.action}": use add, update, reuse or retire`,
      );
      continue;
    }
    if (modern) {
      if (!isCaseId(testCase.id))
        problems.push(`test case ${name} has an id that is not a test case id <KEY>-T<n>`);
      if (planById.has(testCase.id)) problems.push(`duplicate test case id: ${testCase.id}`);
      planById.set(testCase.id, testCase);
    }
    const scenario = !modern || testCase.action === "add" || testCase.action === "update";
    if (scenario) {
      for (const group of ["when", "then"] as const) {
        if (testCase[group].length === 0)
          problems.push(`test case ${name} has an empty ${group} list`);
      }
      if (!testCase.expected.trim()) problems.push(`test case ${name} has no expected sentence`);
    }
    if (modern && testCase.action === "retire" && !testCase.reason.trim())
      problems.push(`test case ${name} is retired with no reason`);
    if (modern && testCase.action !== "add" && !entryById.has(testCase.id))
      problems.push(
        `test case ${name} is ${testCase.action}, but no entry ${testCase.id}.md is in test/cases/ of a repo of the workspace`,
      );
    const allowedLevels = modern ? caseLevels : levels;
    if (testCase.level === "" && modern && !scenario) continue;
    if (!allowedLevels.includes(testCase.level)) {
      problems.push(
        `test case ${name} has level "${testCase.level}": use ${allowedLevels.join(", ").replace(/, ([^,]*)$/, " or $1")}`,
      );
      continue;
    }
    if (modern && testCase.criterion === "") continue;
    if (!ticketCriteria.includes(testCase.criterion)) {
      problems.push(
        `test case ${name} is for criterion "${testCase.criterion}", which is not in the ticket`,
      );
      continue;
    }
    if (levels.includes(testCase.level)) proven.add(testCase.criterion);
  }
  // A new-scheme AC with method test is proved through verified_by; the others keep the old rule.
  const throughCases = links.criteria.filter(
    (criterion) =>
      criterion.newScheme && criterion.method === "test" && ticketCriteria.includes(criterion.id),
  );
  for (const criterion of throughCases) {
    let integration = false;
    for (const id of criterion.verified_by) {
      const planned = planById.get(id);
      const entry = entryById.get(id);
      if (planned?.action === "retire")
        problems.push(`criterion ${criterion.id} verified_by ${id}, which the plan retires`);
      else if (planned?.action !== "add" && entry?.status !== "active")
        problems.push(
          `criterion ${criterion.id} verified_by ${id}, which is no active entry in test/cases/ and no add entry of the plan`,
        );
      if (levels.includes(planned?.level || entry?.level || "")) integration = true;
    }
    if (!integration)
      problems.push(`criterion ${criterion.id} has no integration or e2e test case in verified_by`);
  }
  // A manual criterion is proved by the manual gate: a test case for it is allowed, never required.
  for (const criterion of ticketCriteria) {
    if (
      !proven.has(criterion) &&
      !manual.includes(criterion) &&
      !throughCases.some((through) => through.id === criterion)
    )
      problems.push(`criterion ${criterion} has no integration or e2e test case`);
  }
  if (!plan.summary.why) problems.push("plan.yml has no summary.why: add a summary block");
  if (plan.summary.changes.length === 0)
    problems.push("plan.yml has no summary.changes: add a summary block");
  plan.summary.changes.forEach((change, i) => {
    for (const field of ["criterion", "where", "now", "fix"] as const) {
      if (!change[field]) problems.push(`summary change #${i + 1} has no ${field}`);
    }
  });
  const summarized = new Set<string>();
  for (const change of plan.summary.changes) {
    if (!change.criterion) continue;
    summarized.add(change.criterion);
    if (!ticketCriteria.includes(change.criterion)) {
      problems.push(
        `summary change is for criterion "${change.criterion}", which is not in the ticket`,
      );
    }
  }
  for (const criterion of ticketCriteria) {
    if (!summarized.has(criterion))
      problems.push(`criterion ${criterion} has no row in summary.changes`);
  }
  if (plan.design.interfaces.length === 0)
    problems.push("plan.yml has no design.interfaces: add a design block");
  plan.design.interfaces.forEach((entry, i) => {
    if (!entry.name) problems.push(`design interface #${i + 1} has no name`);
    if (entry.callers.length === 0) {
      problems.push(`design interface ${entry.name || `#${i + 1}`} has no callers`);
    } else if (entry.callers.includes("")) {
      problems.push(`design interface ${entry.name || `#${i + 1}`} has a blank caller`);
    }
  });
  const decisionIds = new Set<string>();
  plan.decisions.forEach((decision, i) => {
    const name = decision.id || `#${i + 1}`;
    if (!decision.id) problems.push(`decision #${i + 1} has no id`);
    else if (decisionIds.has(decision.id)) problems.push(`duplicate decision id: ${decision.id}`);
    decisionIds.add(decision.id);
    if (!decision.question) problems.push(`decision ${name} has no question`);
    const labels = decision.options.map((option) => option.label);
    if (decision.options.length < 2 || decision.options.length > 4) {
      problems.push(`decision ${name} has ${decision.options.length} options: use 2 to 4`);
    }
    if (labels.includes("")) problems.push(`decision ${name} has an option with no label`);
    if (!labels.includes(decision.recommended)) {
      problems.push(`decision ${name} recommended "${decision.recommended}" is not an option`);
    }
    if (decision.chosen && !labels.includes(decision.chosen)) {
      problems.push(`decision ${name} chosen "${decision.chosen}" is not an option`);
    }
  });
  const first = plan.steps[0];
  const last = plan.steps.at(-1);
  if (kind === "bug") {
    if (first?.role !== "validator" || !ticketCriteria.every((id) => first.criteria.includes(id)))
      problems.push("bug run: the first step must be a validator step that serves every criterion");
  }
  if (kind === "perf") {
    if (!first?.goal.includes("results/baseline.md"))
      problems.push("perf run: the first step goal must name results/baseline.md");
    if (!last?.goal.includes("results/compare.md"))
      problems.push("perf run: the last step goal must name results/compare.md");
  }
  const required = uiSkillsFor(surfaces);
  if (required.length > 0) {
    if (plan.steps.every((step) => step.skills.length === 0))
      problems.push("no step has a skills list: add one with the skills of `ark ui-skills <run>`");
    const allowed = allowedUiSkills(surfaces);
    for (const step of plan.steps) {
      for (const skill of step.skills.filter((skill) => !allowed.includes(skill)))
        problems.push(
          `step ${step.id} skills has "${skill}", which \`ark ui-skills <run>\` does not list`,
        );
      const missing = required.filter((skill) => !step.skills.includes(skill));
      if (step.skills.length > 0 && missing.length > 0)
        problems.push(`step ${step.id} skills lacks ${missing.join(", ")}`);
    }
  }
  if (plan.repos.length > 0) problems.push(...repoProblems(plan, workspaceRepos));
  else if (multiRepo(plan)) {
    try {
      repoGraph(plan);
    } catch (err) {
      problems.push(`repos: ${(err as Error).message}; add a repos list`);
    }
  }
  return problems;
}

/** The ACs a case serves: those whose `verified_by` lists it, and the old-shape `criterion`. */
function servedBy(testCase: PlanTestCase, criteria: TicketCriterion[]): string[] {
  return [
    ...new Set([
      ...criteria
        .filter((criterion) => criterion.verified_by.includes(testCase.id))
        .map((criterion) => criterion.id),
      ...(testCase.criterion ? [testCase.criterion] : []),
    ]),
  ];
}

// Stable output. Markdown table cells cannot hold a pipe or a newline.
export function renderPlanMarkdown(
  plan: Plan,
  risks: string[],
  strategy: RunState["strategy"] = null,
  amendments: RunState["amended_criteria"] = [],
  withSkills = false,
  criteria: TicketCriterion[] = [],
): string {
  const tableCell = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ");
  const openDecisions = plan.decisions.filter((decision) => !decision.chosen).length;
  const lines = openDecisions
    ? [`${openDecisions} decisions need an answer before approval`, ""]
    : [];
  lines.push("# Plan", "", "## Summary", "", plan.summary.why, "", "## Changes", "");
  lines.push("| Criterion | Where | Now | Fix |", "| --- | --- | --- | --- |");
  for (const change of plan.summary.changes) {
    lines.push(
      `| ${[change.criterion, change.where, change.now, change.fix].map(tableCell).join(" | ")} |`,
    );
  }
  if (amendments.length > 0) {
    lines.push(
      "",
      "## Amended criteria",
      "",
      "The human approved these amendments. Judge the new text, not the original.",
    );
    for (const amendment of amendments) {
      lines.push(
        "",
        `### ${amendment.id}`,
        "",
        `- **Old:** ${amendment.old.replaceAll("\n", " ")}`,
        `- **New:** ${amendment.new.replaceAll("\n", " ")}`,
        ...(amendment.reason ? [`- **Reason:** ${amendment.reason}`] : []),
      );
    }
  }
  if (strategy) {
    lines.push("", "## Strategy", "");
    if (strategy.count === 1) {
      lines.push(
        strategy.card_text[strategy.cards[0]] ?? strategy.cards[0],
        "",
        `Only one strategy considered, because ${strategy.reason}`,
      );
    } else {
      lines.push(
        `Chosen: ${strategy.chosen ?? "none yet"} (recommended: ${strategy.recommended}; cards: ${strategy.cards.join(", ")})`,
      );
      if (strategy.chosen) lines.push("", strategy.card_text[strategy.chosen] ?? strategy.chosen);
    }
  }
  lines.push("", "## Design", "", plan.design.approach.trim() || "No approach given.", "");
  lines.push("| Interface | Callers |", "| --- | --- |");
  for (const entry of plan.design.interfaces) {
    lines.push(`| ${tableCell(entry.name)} | ${entry.callers.map(tableCell).join("<br>")} |`);
  }
  lines.push("");
  if (plan.design.example.trim()) {
    const longestRun = Math.max(
      0,
      ...(plan.design.example.match(/`+/g) ?? []).map((run) => run.length),
    );
    const fence = "`".repeat(Math.max(3, longestRun + 1));
    lines.push(`${fence}text`, plan.design.example.trimEnd(), fence);
  } else lines.push("No example given.");
  if (plan.decisions.length > 0) {
    lines.push("", "## Decisions", "");
    for (const decision of plan.decisions) {
      lines.push(":::question", `${decision.question.replaceAll("\n", " ")} (${decision.id})`, "");
      for (const option of decision.options) {
        const tradeoffs = option.tradeoffs.replaceAll("\n", " ");
        lines.push(
          `- [${option.label === decision.chosen ? "x" : " "}] ${option.label}${tradeoffs ? ` — ${tradeoffs}` : ""}`,
        );
      }
      lines.push("", `Recommended: ${decision.recommended}`, ":::", "");
    }
  }
  lines.push("", "## Evaluation", "");
  if (risks.length === 0) lines.push("No risks.");
  else for (const risk of risks) lines.push(`- ${risk.replaceAll("\n", " ")}`);
  lines.push("", "## Steps", "");
  if (multiRepo(plan)) {
    const { order } = repoGraph(plan);
    lines.push(`Merge order: ${order.map((repo, i) => `${i + 1} ${repo}`).join(" → ")}`, "");
  }
  lines.push("```mermaid", renderMermaid(plan).trimEnd(), "```", "");
  lines.push(
    `| Step | Role | Repo | Needs | Criteria |${withSkills ? " Skills |" : ""}`,
    `| --- | --- | --- | --- | --- |${withSkills ? " --- |" : ""}`,
  );
  for (const step of plan.steps) {
    const cells = [
      step.id,
      step.role,
      step.repo,
      step.needs.join(", ") || "none",
      step.criteria.join(", "),
    ];
    if (withSkills) cells.push(step.skills.join(", "));
    lines.push(`| ${cells.map(tableCell).join(" | ")} |`);
  }
  if (multiRepo(plan)) {
    const { order } = repoGraph(plan);
    lines.push("", "## Repos", "");
    lines.push(
      "| Order | Repo | Why | Depends on | Kind | Pin | Evidence | Bump |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    order.forEach((repo, i) => {
      const entry = plan.repos.find((candidate) => candidate.repo === repo);
      const edges = entry?.depends_on ?? [];
      const rows =
        edges.length > 0
          ? edges.map((edge, j) => [
              j === 0 ? (entry?.why ?? "") : "",
              edge.repo,
              edge.kind,
              edge.pin,
              edge.evidence,
              edge.bump,
            ])
          : [[entry?.why ?? "", "none", "", "", "", ""]];
      for (const row of rows)
        lines.push(`| ${[String(i + 1), repo, ...row].map(tableCell).join(" | ")} |`);
    });
  }
  lines.push("", "## Test cases", "");
  if (plan.test_cases.some((testCase) => testCase.action !== "")) {
    lines.push(
      "| Case | Action | Level | Serves | Title | Reason |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const testCase of plan.test_cases) {
      const serves = testCase.action === "retire" ? [] : servedBy(testCase, criteria);
      lines.push(
        `| ${[testCase.id, testCase.action || "-", testCase.level, serves.join(", ") || "none", testCase.title, testCase.reason].map(tableCell).join(" | ")} |`,
      );
    }
    lines.push("");
  }
  for (const testCase of plan.test_cases) {
    if (testCase.action === "reuse" || testCase.action === "retire") continue;
    lines.push(
      `### ${testCase.id} (${testCase.action || testCase.criterion}, ${testCase.level})`,
      "",
      "```gherkin",
    );
    for (const [group, keyword] of [
      ["given", "Given"],
      ["when", "When"],
      ["then", "Then"],
    ] as const) {
      testCase[group].forEach((line, i) => lines.push(`${i === 0 ? keyword : "And"} ${line}`));
    }
    lines.push("```", "", `Expected: ${testCase.expected}`, "");
  }
  return `${lines.join("\n")}\n`;
}

export function planCheck(runId: string, inProject?: string): void {
  const { project, directory } = findRun(runId, inProject);
  const state = deriveState(readEvents(directory));
  // Refuse a run that is not ready for a plan check before reading plan.yml.
  assertAllowed(state, "plan.checked", {});
  const plan = loadPlan(directory, state.ticket.id);
  const ticketCriteria = runCriteria(directory);
  const config = loadConfig(project);
  const cases = readWorkspaceCases(config.workspace);
  const surfaces = state.evaluation?.surfaces ?? ["none"];
  const problems = findProblems(
    plan,
    state.criteria.map((criterion) => criterion.id),
    surfaces,
    config.roles,
    ticketCriteria
      .filter((criterion) => criterion.method !== "test")
      .map((criterion) => criterion.id),
    state.kind,
    { criteria: ticketCriteria, entries: cases.entries },
    discoverRepos(config.workspace),
  );
  problems.unshift(...cases.problems);
  const valid = problems.length === 0;
  const openDecisions = plan.decisions.filter((decision) => !decision.chosen).length;
  appendEvent(directory, "plan.checked", {
    valid,
    problems,
    plan_hash: planHash(directory),
    open_decisions: openDecisions,
    steps: plan.steps.map(({ id, role, repo, needs, criteria }) => ({
      id,
      role,
      repo,
      needs,
      criteria,
    })),
  });
  if (!valid) {
    console.log(`plan refused: ${problems.length} problem${problems.length === 1 ? "" : "s"}`);
    for (const problem of problems) console.log(`  ${problem}`);
    process.exitCode = 1;
    return;
  }
  writeFileSync(
    join(directory, "plan.md"),
    renderPlanMarkdown(
      plan,
      state.evaluation?.risks ?? [],
      state.strategy,
      state.amended_criteria,
      uiSkillsFor(surfaces).length > 0,
      ticketCriteria,
    ),
  );
  const { order, upstream } = repoGraph(plan);
  console.log(
    `plan ok: ${plan.steps.length} steps, ${order.length} repo${order.length === 1 ? "" : "s"}, ${plan.test_cases.length} test cases`,
  );
  if (order.length > 1) {
    const width = Math.max(...order.map((repo) => repo.length)) + 3;
    console.log("Merge order:");
    order.forEach((repo, i) => {
      const waits = order.filter((other) => upstream.get(repo)!.has(other));
      const line = `  ${i + 1}  ${repo}`;
      console.log(
        waits.length > 0 ? `${line.padEnd(width + 5)}waits for: ${waits.join(", ")}` : line,
      );
    });
  }
  if (config.gates.plan === "auto" && openDecisions === 0) {
    appendEvent(directory, "gate.answered", { gate: "plan", answer: "approve", by: "auto" });
    console.log("gates.plan is auto: recorded plan approve by auto");
  }
}
