import { ArkError } from "./errors.ts";
import { deriveState, readEvents } from "./events.ts";
import { findRun } from "./paths.ts";

/** The only place that names the UI skills. Everything else imports from here or runs `ark ui-skills`. */
export const requiredUiSkills = ["impeccable", "emil-design-eng", "web-design-guidelines"];
export const reactSkill = "vercel-react-best-practices";

/** Required skills for a `Surfaces` list: none for `none` or an empty list. */
export function uiSkillsFor(surfaces: string[]): string[] {
  return surfaces.some((surface) => surface !== "none") ? requiredUiSkills : [];
}

/** Every skill `ark ui-skills` lists for these surfaces, required or optional. */
export function allowedUiSkills(surfaces: string[]): string[] {
  const required = uiSkillsFor(surfaces);
  return required.length > 0 ? [...required, reactSkill] : [];
}

export function uiSkills(runId: string, inProject?: string): void {
  const { directory } = findRun(runId, inProject);
  const { evaluation } = deriveState(readEvents(directory));
  if (!evaluation)
    throw new ArkError(`${runId} has no recorded evaluation: run ark evaluation record first`);
  const required = uiSkillsFor(evaluation.surfaces);
  if (required.length === 0) console.log("none");
  else
    console.log(
      [...required, `${reactSkill} (only when the change touches React code)`].join("\n"),
    );
}
