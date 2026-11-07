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

/**
 * Names of the projects under `$ARK_HOME/projects`, sorted. A folder is a project when it has an
 * `ark.yml` or a run folder (a directory entry under `runs/`). A missing or empty `runs/`, or one
 * holding only files, is no run folder: such a leftover folder is skipped.
 */
export function listProjects(): string[] {
  const projectsDirectory = join(arkHome(), "projects");
  if (!existsSync(projectsDirectory)) return [];
  return readdirSync(projectsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isProject(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function isProject(project: string): boolean {
  if (existsSync(join(projectDirectory(project), "ark.yml"))) return true;
  const runsRoot = runsDirectory(project);
  return (
    existsSync(runsRoot) &&
    readdirSync(runsRoot, { withFileTypes: true }).some((entry) => entry.isDirectory())
  );
}

/** With `project`, looks for the run in that project only and refuses an unknown project. */
export function findRun(runId: string, project?: string): { project: string; directory: string } {
  const projects = listProjects();
  if (project !== undefined) {
    if (!projects.includes(project))
      throw new ArkError(`project ${project} does not exist under ${arkHome()}/projects`);
    const directory = join(runsDirectory(project), runId);
    if (!existsSync(directory)) throw new ArkError(`run not found in project ${project}: ${runId}`);
    return { project, directory };
  }
  const matches = projects
    .map((name) => ({ project: name, directory: join(runsDirectory(name), runId) }))
    .filter((candidate) => existsSync(candidate.directory));
  if (matches.length === 0) throw new ArkError(`run not found: ${runId}`);
  if (matches.length > 1) {
    throw new ArkError(
      `run id ${runId} exists in several projects: ${matches.map((match) => match.project).join(", ")}`,
    );
  }
  return matches[0];
}
