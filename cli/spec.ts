import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

/** `Reviewed head:` of the newest findings file that has one; undefined before the first review. */
function lastReviewedHead(runDirectory: string): string | undefined {
  const folder = join(runDirectory, "findings");
  if (!existsSync(folder)) return undefined;
  const reviews = readdirSync(folder)
    .map((name) => join(folder, name))
    .map((file) => ({
      time: statSync(file).mtimeMs,
      head: /^Reviewed head:\s*(\S+)/m.exec(readFileSync(file, "utf8"))?.[1],
    }))
    .filter((review) => review.head !== undefined)
    .sort((left, right) => right.time - left.time);
  return reviews[0]?.head;
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
}): string {
  const { run, directory, state, step, interrupted } = options;
  const lines = [
    `/skill:ark worker ${run} ${step.id}`,
    `You are the ${step.role.toUpperCase()} for step ${step.id} of run ${run}.`,
  ];
  if (interrupted)
    lines.push(
      "An earlier worker of this step was interrupted. Its changes are still in the worktree. Before you go on, read `git status` and `git diff`, and keep the work that is there.",
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
    const head = lastReviewedHead(directory);
    if (head) lines.push(`Last reviewed head: ${head}`);
  }
  const rules = join(directory, "rules.md");
  if (existsSync(rules)) lines.push("Rules:", readFileSync(rules, "utf8").trimEnd());
  return lines.join("\n");
}
