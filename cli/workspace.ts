import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ProjectConfig } from "./config.ts";
import { ArkError } from "./errors.ts";

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
