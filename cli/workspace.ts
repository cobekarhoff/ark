import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type ProjectConfig } from "./config.ts";
import { ArkError } from "./errors.ts";
import { deriveState, readEvents } from "./events.ts";
import { findRun } from "./paths.ts";

const maximumDepth = 4;

/** Repo paths relative to the workspace: "." when the root is a repo, plus every nested repo, sorted. */
export function discoverRepos(workspace: string): string[] {
  const repos: string[] = [];
  const visit = (relative: string, depth: number) => {
    const directory = join(workspace, relative);
    if (existsSync(join(directory, ".git"))) repos.push(relative === "" ? "." : relative);
    if (depth === maximumDepth) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
        visit(join(relative, entry.name), depth + 1);
      }
    }
  };
  visit("", 0);
  return repos.sort();
}

export function mirrorRoot(runDirectory: string): string {
  return join(runDirectory, "workspace");
}

export function git(directory: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", directory, ...args]);
  if (result.exitCode !== 0)
    throw new ArkError(
      `git ${args.join(" ")} failed in ${directory}: ${result.stderr.toString().trim()}`,
    );
  return result.stdout.toString().trim();
}

/** The base and target branch the project configures for `repo` (`repos.<repo>.base`), or undefined. The key is the repo path exactly, with no normalising. */
export function repoBase(config: ProjectConfig, repo: string): string | undefined {
  return config.repos?.[repo]?.base;
}

/** `base` when the repo has one, else the branch origin's HEAD points at, for example `main`. */
export function targetBranch(repoPath: string, base?: string): string {
  if (base !== undefined) return base;
  return git(repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").replace(
    /^origin\//,
    "",
  );
}

/** Fast-forwards the workspace checkout's target branch of each repo the run touched to origin. */
export function workspaceSync(runId: string, inProject?: string): void {
  const { project, directory } = findRun(runId, inProject);
  const config = loadConfig(project);
  const workspace = config.workspace;
  for (const { repo } of deriveState(readEvents(directory)).worktrees) {
    const path = join(workspace, repo);
    try {
      git(path, "fetch", "origin");
      const target = targetBranch(path, repoBase(config, repo));
      if (git(path, "branch", "--show-current") === target)
        git(path, "merge", "--ff-only", `origin/${target}`);
      else git(path, "fetch", "origin", `${target}:${target}`); // not checked out: git moves the ref only if it fast-forwards
      console.log(`${repo}  ${target}  ${git(path, "rev-parse", target)}`);
    } catch (err) {
      if (err instanceof ArkError) throw new ArkError(`repo ${repo}: ${err.message}`);
      throw err;
    }
  }
}
