import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ProjectConfig } from "./config.ts";
import { ArkError } from "./errors.ts";

const maximumDepth = 4;

/** The submodules a repo declares in its `.gitmodules`: name, folder (relative to the repo) and URL. Empty when it has none. */
export function submodulesOf(repoPath: string): { name: string; path: string; url: string }[] {
  if (!existsSync(join(repoPath, ".gitmodules"))) return [];
  const result = Bun.spawnSync([
    "git",
    "-C",
    repoPath,
    "config",
    "-f",
    ".gitmodules",
    "--get-regexp",
    "^submodule\\..*\\.(path|url)$",
  ]);
  const byName = new Map<string, { path?: string; url?: string }>();
  for (const line of result.stdout.toString().split("\n")) {
    const match = /^submodule\.(.+)\.(path|url) (.*)$/.exec(line);
    if (!match) continue;
    const entry = byName.get(match[1]) ?? {};
    entry[match[2] as "path" | "url"] = match[3];
    byName.set(match[1], entry);
  }
  return [...byName.entries()].flatMap(([name, entry]) =>
    entry.path !== undefined && entry.url !== undefined
      ? [{ name, path: entry.path, url: entry.url }]
      : [],
  );
}

/** Repo paths relative to the workspace: "." when the root is a repo, plus every nested repo, sorted. A submodule is part of its consumer, not a repo of its own, so it is skipped. */
export function discoverRepos(workspace: string): string[] {
  const repos: string[] = [];
  const submodulePaths = new Set<string>();
  const visit = (relative: string, depth: number) => {
    const directory = join(workspace, relative);
    if (existsSync(join(directory, ".git"))) {
      repos.push(relative === "" ? "." : relative);
      for (const submodule of submodulesOf(directory))
        submodulePaths.add(join(directory, submodule.path));
    }
    if (depth === maximumDepth) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        entry.name !== "node_modules" &&
        entry.name !== ".git" &&
        !submodulePaths.has(join(directory, entry.name))
      ) {
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
