import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
