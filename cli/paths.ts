import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ArkError } from "./errors.ts";

export function arkHome(): string {
  return process.env.ARK_HOME || join(homedir(), ".ark");
}

export function projectDirectory(project: string): string {
  return join(arkHome(), "projects", project);
}

export function runsDirectory(project: string): string {
  return join(projectDirectory(project), "runs");
}

/** Names of the projects that have a folder under `$ARK_HOME/projects`, sorted. */
export function listProjects(): string[] {
  const projectsDirectory = join(arkHome(), "projects");
  if (!existsSync(projectsDirectory)) return [];
  return readdirSync(projectsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function findRun(runId: string): { project: string; directory: string } {
  const matches = listProjects()
    .map((project) => ({ project, directory: join(runsDirectory(project), runId) }))
    .filter((candidate) => existsSync(candidate.directory));
  if (matches.length === 0) throw new ArkError(`run not found: ${runId}`);
  if (matches.length > 1) {
    throw new ArkError(`run id ${runId} exists in several projects: ${matches.map((match) => match.project).join(", ")}`);
  }
  return matches[0];
}
