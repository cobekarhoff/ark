import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { ArkError } from "./errors.ts";
import { appendEvent } from "./events.ts";
import { findRun } from "./paths.ts";

export const surfaceNames = ["web_ui", "cli_output", "document", "none"];

/**
 * evaluation.md has a "Blockers", a "Risks" and a "Surfaces" heading. Each heading is followed by
 * a bullet list. Blockers and risks may be empty; surfaces needs at least one known value, and
 * "none" stands alone. Any other text is ignored.
 */
export function parseEvaluation(content: string): {
  blockers: string[];
  risks: string[];
  surfaces: string[];
} {
  const lists: Record<string, string[]> = {};
  let current: string[] | null = null;
  for (const line of content.split("\n")) {
    const heading = line.match(/^#{1,6}\s+(.*?)\s*$/);
    if (heading) {
      const name = heading[1].toLowerCase();
      current = ["blockers", "risks", "surfaces"].includes(name) ? (lists[name] ??= []) : null;
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.*\S)\s*$/);
    if (current && bullet) current.push(bullet[1]);
  }
  for (const name of ["blockers", "risks", "surfaces"]) {
    if (!lists[name])
      throw new ArkError(`evaluation.md has no "${name}" list: add a "## ${name}" heading`);
  }
  const surfaces = lists.surfaces.map((surface) => surface.replaceAll("`", "").trim());
  for (const surface of surfaces) {
    if (!surfaceNames.includes(surface))
      throw new ArkError(
        `evaluation.md has unknown surface "${surface}": use ${surfaceNames.join(", ")}`,
      );
  }
  if (surfaces.length === 0)
    throw new ArkError(
      `evaluation.md has an empty "surfaces" list: list ${surfaceNames.join(", ")}`,
    );
  if (surfaces.includes("none") && surfaces.length > 1)
    throw new ArkError('evaluation.md lists surface "none" with other surfaces: use none alone');
  return { blockers: lists.blockers, risks: lists.risks, surfaces };
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
  const { blockers, risks, surfaces } = parseEvaluation(readFileSync(file, "utf8"));
  appendEvent(directory, "evaluation.recorded", { blockers, risks, surfaces });
  console.log(
    `recorded evaluation: ${blockers.length} blocker${blockers.length === 1 ? "" : "s"}, ${risks.length} risk${risks.length === 1 ? "" : "s"}, surfaces ${surfaces.join(", ")}`,
  );
}
