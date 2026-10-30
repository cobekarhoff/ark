import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.ts";
import { ArkError } from "./errors.ts";
import { appendEvent, deriveState, readEvents } from "./events.ts";
import { findRun } from "./paths.ts";
import { assertAllowed } from "./transitions.ts";
import { discoverRepos, git, mirrorRoot, targetBranch } from "./workspace.ts";

const skippedRootEntries = new Set([".git", ".DS_Store", "repos"]);

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function reposOfLastValidPlan(runDirectory: string): string[] {
  const checked = readEvents(runDirectory).filter((event) => event.type === "plan.checked" && event.data.valid);
  const steps: { repo: string }[] = checked.at(-1)?.data.steps ?? [];
  return [...new Set(steps.map((step) => step.repo))];
}

export function worktreeCreate(runId: string, repos: string[]): void {
  const { project, directory } = findRun(runId);
  const workspace = loadConfig(project).workspace;
  const knownRepos = discoverRepos(workspace);

  const touched = [...new Set(repos.length > 0 ? repos : reposOfLastValidPlan(directory))].sort();
  if (touched.length === 0) throw new ArkError(`no repos named and ${runId} has no valid plan: name the repos or run ark plan check`);
  for (const repo of touched) {
    if (!knownRepos.includes(repo)) throw new ArkError(`repo ${repo} is not in workspace ${workspace} (found: ${knownRepos.join(", ") || "none"})`);
  }

  assertAllowed(deriveState(readEvents(directory)), "worktree.created", {}); // refuse before git changes anything

  const mirror = mirrorRoot(directory);
  mkdirSync(mirror, { recursive: true });

  for (const repo of touched) {
    const path = repo === "." ? mirror : join(mirror, repo);
    const isSymlink = pathExists(path) && lstatSync(path).isSymbolicLink();
    if (!isSymlink && existsSync(join(path, ".git"))) {
      console.log(`exists   ${repo}`);
      continue;
    }
    if (isSymlink) unlinkSync(path); // an earlier call left this repo untouched
    mkdirSync(dirname(path), { recursive: true });
    const source = join(workspace, repo);
    const base = git(source, "rev-parse", "HEAD");
    const branch = `ark/${runId}`;
    git(source, "worktree", "add", "-b", branch, path, base);
    appendEvent(directory, "worktree.created", { repo, path, branch, base });
    console.log(`created  ${repo} -> ${path}`);
  }

  if (knownRepos.length === 1 && knownRepos[0] === ".") return; // single-repo workspace: the worktree is the mirror

  for (const entry of readdirSync(workspace)) {
    const link = join(mirror, entry);
    if (!skippedRootEntries.has(entry) && !pathExists(link)) symlinkSync(join(workspace, entry), link);
  }
  for (const repo of knownRepos) {
    const link = join(mirror, repo);
    if (repo === "." || pathExists(link)) continue;
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(workspace, repo), link);
  }
}

/** Merges origin/<target> into every worktree and pushes the branch of each repo with an open MR. */
export function worktreeSync(runId: string): void {
  const { directory } = findRun(runId);
  const state = deriveState(readEvents(directory));
  if (state.worktrees.length === 0) throw new ArkError(`${runId} has no worktrees`);
  for (const worktree of state.worktrees) {
    git(worktree.path, "fetch", "origin");
    const target = targetBranch(worktree.path);
    const merged = Bun.spawnSync(["git", "-C", worktree.path, "merge", "--no-edit", `origin/${target}`]);
    if (merged.exitCode !== 0) {
      Bun.spawnSync(["git", "-C", worktree.path, "merge", "--abort"]);
      throw new ArkError(`repo ${worktree.repo}: merging origin/${target} failed, worktree left unchanged: ${merged.stdout.toString().trim()}${merged.stderr.toString().trim()}`);
    }
    const pushed = state.merge_requests.some((merge) => merge.repo === worktree.repo);
    if (pushed) git(worktree.path, "push", "origin", worktree.branch);
    console.log(`${worktree.repo}  ${target}  ${git(worktree.path, "rev-parse", "HEAD")}${pushed ? "  pushed" : ""}`);
  }
}
