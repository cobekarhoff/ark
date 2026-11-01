import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { ArkError } from "./errors.ts";
import { appendEvent } from "./events.ts";
import { findRun } from "./paths.ts";

/**
 * evaluation.md has a "Blockers" heading and a "Risks" heading. Each heading is followed by a
 * bullet list, which may be empty. Any other text is ignored.
 */
export function parseEvaluation(content: string): { blockers: string[]; risks: string[] } {
  const lists: Record<string, string[]> = {};
  let current: string[] | null = null;
  for (const line of content.split("\n")) {
    const heading = line.match(/^#{1,6}\s+(.*?)\s*$/);
    if (heading) {
      const name = heading[1].toLowerCase();
      current = name === "blockers" || name === "risks" ? (lists[name] ??= []) : null;
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.*\S)\s*$/);
    if (current && bullet) current.push(bullet[1]);
  }
  for (const name of ["blockers", "risks"]) {
    if (!lists[name])
      throw new ArkError(`evaluation.md has no "${name}" list: add a "## ${name}" heading`);
  }
  return { blockers: lists.blockers, risks: lists.risks };
}

export function evaluationRecord(runId: string): void {
  const { project, directory } = findRun(runId);
  if (!loadConfig(project).roles.evaluator) {
    throw new ArkError(
      `ark.yml of project ${project} has no roles.evaluator: add its harness and model`,
    );
  }
  const file = join(directory, "evaluation.md");
  if (!existsSync(file)) throw new ArkError(`evaluation.md not found in ${directory}`);
  const { blockers, risks } = parseEvaluation(readFileSync(file, "utf8"));
  appendEvent(directory, "evaluation.recorded", { blockers, risks });
  console.log(
    `recorded evaluation: ${blockers.length} blocker${blockers.length === 1 ? "" : "s"}, ${risks.length} risk${risks.length === 1 ? "" : "s"}`,
  );
}
