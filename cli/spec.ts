import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { canonicalCriterion } from "./criterion-id.ts";
import { parseEvaluation } from "./evaluation.ts";
import type { RunState } from "./events.ts";
import type { PlanStep } from "./plan.ts";
import { frontmatter } from "./ticket.ts";

/** The lines of the top comment of plan.yml that start at `# Learnings applied`, verbatim. */
function appliedLearnings(runDirectory: string): string[] {
  const file = join(runDirectory, "plan.yml");
  if (!existsSync(file)) return [];
  const comment: string[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.startsWith("#")) break;
    comment.push(line);
  }
  const first = comment.findIndex((line) => /^#\s*Learnings applied/.test(line));
  if (first < 0) return [];
  const rest = comment.slice(first + 1);
  const end = rest.findIndex((line) => /^#\s*Learnings read/.test(line));
  return [comment[first], ...(end < 0 ? rest : rest.slice(0, end))];
}

/** Each backticked string, with its backticks, of the ACs the step serves. An amended AC counts with its new text. */
function literalStrings(runDirectory: string, state: RunState, step: PlanStep): string[] {
  const file = join(runDirectory, "ticket.md");
  if (!existsSync(file)) return [];
  const fields = frontmatter(readFileSync(file, "utf8")).fields ?? {};
  const texts = new Map<string, string>();
  const list = Array.isArray(fields.acceptance_criteria) ? fields.acceptance_criteria : [];
  for (const entry of list)
    if (typeof entry?.id === "string" && typeof entry?.text === "string")
      texts.set(canonicalCriterion(entry.id, state.ticket.id), entry.text);
  for (const amended of state.amended_criteria) texts.set(amended.id, amended.new);
  const strings = step.criteria.flatMap((criterion) =>
    [...(texts.get(canonicalCriterion(criterion, state.ticket.id)) ?? "").matchAll(/`[^`]+`/g)].map(
      (match) => match[0],
    ),
  );
  return [...new Set(strings)];
}

/**
 * Where a reviewer's range starts: the `Reviewed head:` of the newest findings file of another-or-same reviewer step
 * in the step's repo, else the run's base for that repo (undefined for a run created before bases were recorded).
 * Other findings files (rounds, test-case reviews) are not reviews of the code and are ignored. `includeOwn` is
 * false at finish, when the step's own file already holds the head it just reviewed.
 */
export function reviewRangeStart(
  runDirectory: string,
  state: RunState,
  step: Pick<PlanStep, "id" | "repo">,
  includeOwn: boolean,
): string | undefined {
  const reviews = state.steps
    .filter(
      (other) =>
        other.role === "reviewer" &&
        other.repo === step.repo &&
        (includeOwn || other.id !== step.id),
    )
    .map((other) => join(runDirectory, "findings", `${other.id}.md`))
    .filter((file) => existsSync(file))
    .map((file) => ({
      time: statSync(file).mtimeMs,
      head: /^Reviewed head:\s*(\S+)/m.exec(readFileSync(file, "utf8"))?.[1],
    }))
    .filter((review) => review.head !== undefined)
    .sort((left, right) => right.time - left.time);
  return reviews[0]?.head ?? state.worktrees.find((entry) => entry.repo === step.repo)?.base;
}

/**
 * The text a worker starts from. It names the role and the step in words (a bare skill line once produced the
 * wrong role) and copies, so the run lead need not: the risks of evaluation.md, the applied learnings of plan.yml,
 * the backticked strings of the step's ACs and the run's rules.md. `interrupted` adds the brief for a worker that
 * takes over from a dead one.
 */
export function buildSpec(options: {
  run: string;
  directory: string;
  state: RunState;
  step: PlanStep;
  interrupted: boolean;
  /** The target branch (not a commit) to merge from origin into the worktree: this start only resolves that merge. */
  mergeBase?: string;
}): string {
  const { run, directory, state, step, interrupted, mergeBase } = options;
  const lines = [
    `/skill:ark worker ${run} ${step.id}`,
    `You are the ${step.role.toUpperCase()} for step ${step.id} of run ${run}.`,
  ];
  if (interrupted)
    lines.push(
      "An earlier worker of this step was interrupted. Its changes are still in the worktree. Before you go on, read `git status` and `git diff`, and keep the work that is there.",
    );
  if (mergeBase)
    lines.push(
      `This start is a merge, not a new round. Merge origin/${mergeBase} into the worktree branch (git fetch origin, then git merge origin/${mergeBase}), fix the conflict and keep the work of the step. Do not rebase.`,
    );
  const evaluation = join(directory, "evaluation.md");
  const risks = existsSync(evaluation)
    ? parseEvaluation(readFileSync(evaluation, "utf8")).risks
    : [];
  if (risks.length > 0) lines.push("Risks:", ...risks.map((risk) => `- ${risk}`));
  const learnings = appliedLearnings(directory);
  if (learnings.length > 0) lines.push(...learnings);
  const strings = literalStrings(directory, state, step);
  if (strings.length > 0) lines.push(`Literal strings: ${strings.join(", ")}`);
  if (step.skills.length > 0) lines.push(`UI skills: ${step.skills.join(", ")}`);
  if (step.role === "reviewer") {
    const head = reviewRangeStart(directory, state, step, true);
    if (head) lines.push(`Last reviewed head: ${head}`);
  }
  const rules = join(directory, "rules.md");
  if (existsSync(rules)) lines.push("Rules:", readFileSync(rules, "utf8").trimEnd());
  return lines.join("\n");
}
