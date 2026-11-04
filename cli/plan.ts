import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ProjectConfig, loadConfig } from "./config.ts";
import { ArkError } from "./errors.ts";
import { manualCriteria } from "./criteria.ts";
import { type RunState, type TicketKind, appendEvent, deriveState, readEvents } from "./events.ts";
import { findRun } from "./paths.ts";
import { assertAllowed } from "./transitions.ts";
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
  id: string;
  criterion: string;
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
export type Plan = {
  summary: { why: string; changes: PlanSummaryChange[] };
  design: PlanDesign;
  decisions: PlanDecision[];
  steps: PlanStep[];
  test_cases: PlanTestCase[];
};

const roles = ["implementer", "validator", "reviewer"];
const levels = ["integration", "e2e"];

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
  const { steps, test_cases, summary, design, decisions } = raw as Record<string, unknown>;
  const designBlock =
    design && typeof design === "object" ? (design as Record<string, unknown>) : {};
  const summaryBlock =
    summary && typeof summary === "object" ? (summary as Record<string, unknown>) : {};
  return {
    summary: {
      why: text(summaryBlock.why),
      changes: objectList(summaryBlock.changes).map((change) => ({
        criterion: text(change.criterion),
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
    steps: objectList(steps).map((step) => ({
      id: text(step.id),
      role: text(step.role),
      repo: text(step.repo),
      harness: text(step.harness),
      model: text(step.model),
      needs: textList(step.needs),
      criteria: textList(step.criteria),
      skills: textList(step.skills),
      goal: text(step.goal),
    })),
    test_cases: objectList(test_cases).map((testCase) => {
      const name = text(testCase.id) || "(no id)";
      if (Object.hasOwn(testCase, "steps")) {
        throw new ArkError(`test case ${name} has the old steps field: use given, when and then`);
      }
      for (const group of ["given", "when", "then"] as const) {
        if (
          !Array.isArray(testCase[group]) ||
          !testCase[group].every((line) => typeof line === "string")
        ) {
          throw new ArkError(`test case ${name} ${group} must be a list of strings`);
        }
      }
      return {
        id: text(testCase.id),
        criterion: text(testCase.criterion),
        level: text(testCase.level),
        given: testCase.given as string[],
        when: testCase.when as string[],
        // oxlint-disable-next-line unicorn/no-thenable -- plan test-case field `then: string[]`, not a Promise-like
        then: testCase.then as string[],
        expected: text(testCase.expected),
      };
    }),
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

export function findProblems(
  plan: Plan,
  ticketCriteria: string[],
  surfaces: string[],
  configuredRoles: ProjectConfig["roles"],
  manual: string[] = [],
  kind: TicketKind = "feature",
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
  for (const testCase of plan.test_cases) {
    const name = testCase.id || "(no id)";
    for (const group of ["when", "then"] as const) {
      if (testCase[group].length === 0)
        problems.push(`test case ${name} has an empty ${group} list`);
    }
    if (!testCase.expected.trim()) problems.push(`test case ${name} has no expected sentence`);
    if (!levels.includes(testCase.level)) {
      problems.push(`test case ${name} has level "${testCase.level}": use integration or e2e`);
      continue;
    }
    if (!ticketCriteria.includes(testCase.criterion)) {
      problems.push(
        `test case ${name} is for criterion "${testCase.criterion}", which is not in the ticket`,
      );
      continue;
    }
    proven.add(testCase.criterion);
  }
  // A manual criterion is proved by the manual gate: a test case for it is allowed, never required.
  for (const criterion of ticketCriteria) {
    if (!proven.has(criterion) && !manual.includes(criterion))
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
    const automated = ticketCriteria.filter((id) => !manual.includes(id));
    if (first?.role !== "validator" || !automated.every((id) => first.criteria.includes(id)))
      problems.push(
        "bug run: the first step must be a validator step that serves every non-manual criterion",
      );
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
  return problems;
}

// Stable output. Markdown table cells cannot hold a pipe or a newline.
export function renderPlanMarkdown(
  plan: Plan,
  risks: string[],
  strategy: RunState["strategy"] = null,
  amendments: RunState["amended_criteria"] = [],
  withSkills = false,
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
  lines.push("", "## Steps", "", "```mermaid", renderMermaid(plan).trimEnd(), "```", "");
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
  lines.push("", "## Test cases", "");
  for (const testCase of plan.test_cases) {
    lines.push(`### ${testCase.id} (${testCase.criterion}, ${testCase.level})`, "", "```gherkin");
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
  const plan = loadPlan(directory);
  const surfaces = state.evaluation?.surfaces ?? ["none"];
  const problems = findProblems(
    plan,
    state.criteria.map((criterion) => criterion.id),
    surfaces,
    loadConfig(project).roles,
    manualCriteria(directory),
    state.kind,
  );
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
    for (const problem of problems) console.log(problem);
    throw new ArkError(
      `plan is invalid: ${problems.length} problem${problems.length === 1 ? "" : "s"}`,
    );
  }
  writeFileSync(
    join(directory, "plan.md"),
    renderPlanMarkdown(
      plan,
      state.evaluation?.risks ?? [],
      state.strategy,
      state.amended_criteria,
      uiSkillsFor(surfaces).length > 0,
    ),
  );
  console.log(
    `plan is valid: ${plan.steps.length} steps, ${plan.test_cases.length} test cases; wrote plan.md`,
  );
  if (loadConfig(project).gates.plan === "auto" && openDecisions === 0) {
    appendEvent(directory, "gate.answered", { gate: "plan", answer: "approve", by: "auto" });
    console.log("gates.plan is auto: recorded plan approve by auto");
  }
}
