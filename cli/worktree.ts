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
  const checked = readEvents(runDirectory).filter(
    (event) => event.type === "plan.checked" && event.data.valid,
  );
  const steps: { repo: string }[] = checked.at(-1)?.data.steps ?? [];
  return [...new Set(steps.map((step) => step.repo))];
}

/** `ark/<ticket id>-<slug>`, plus `-<run number>` from the second run on. The slug is the title, lowercase, hyphenated, at most 40 characters. */
function branchName(runId: string, ticket: { id: string; title: string }): string {
  const slug = ticket.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const number = Number(runId.match(/-(\d+)$/)?.[1] ?? 1);
  return `ark/${ticket.id}${slug ? `-${slug}` : ""}${number > 1 ? `-${number}` : ""}`;
}

export function worktreeCreate(runId: string, repos: string[]): void {
  const { project, directory } = findRun(runId);
  const workspace = loadConfig(project).workspace;
  const knownRepos = discoverRepos(workspace);

  const touched = [...new Set(repos.length > 0 ? repos : reposOfLastValidPlan(directory))].sort();
  if (touched.length === 0)
    throw new ArkError(
      `no repos named and ${runId} has no valid plan: name the repos or run ark plan check`,
    );
  for (const repo of touched) {
    if (!knownRepos.includes(repo))
      throw new ArkError(
        `repo ${repo} is not in workspace ${workspace} (found: ${knownRepos.join(", ") || "none"})`,
      );
  }

  const state = deriveState(readEvents(directory));
  assertAllowed(state, "worktree.created", {}); // refuse before git changes anything

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
    const branch = branchName(runId, state.ticket);
    git(source, "worktree", "add", "-b", branch, path, base);
    appendEvent(directory, "worktree.created", { repo, path, branch, base });
    console.log(`created  ${repo} -> ${path}`);
  }

  if (knownRepos.length === 1 && knownRepos[0] === ".") return; // single-repo workspace: the worktree is the mirror

  for (const entry of readdirSync(workspace)) {
    const link = join(mirror, entry);
    if (!skippedRootEntries.has(entry) && !pathExists(link))
      symlinkSync(join(workspace, entry), link);
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
    const merged = Bun.spawnSync([
      "git",
      "-C",
      worktree.path,
      "merge",
      "--no-edit",
      `origin/${target}`,
    ]);
    if (merged.exitCode !== 0) {
      Bun.spawnSync(["git", "-C", worktree.path, "merge", "--abort"]);
      throw new ArkError(
        `repo ${worktree.repo}: merging origin/${target} failed, worktree left unchanged: ${merged.stdout.toString().trim()}${merged.stderr.toString().trim()}`,
      );
    }
    const pushed = state.merge_requests.some((merge) => merge.repo === worktree.repo);
    if (pushed) git(worktree.path, "push", "origin", worktree.branch);
    console.log(
      `${worktree.repo}  ${target}  ${git(worktree.path, "rev-parse", "HEAD")}${pushed ? "  pushed" : ""}`,
    );
  }
}

/** Removes each worktree of a closed run and its local branch. Keeps a dirty worktree, and for a merged run an unmerged branch, and prints the repo and the reason. */
export function worktreeCleanup(runId: string): void {
  const { project, directory } = findRun(runId);
  const state = deriveState(readEvents(directory));
  const workspace = loadConfig(project).workspace;
  for (const { repo, path, branch } of state.worktrees) {
    const source = join(workspace, repo);
    const keep = (reason: string) => console.log(`kept     ${repo}  ${branch}: ${reason}`);
    if (!existsSync(path)) {
      Bun.spawnSync(["git", "-C", source, "worktree", "prune"]);
    } else {
      if (git(path, "status", "--porcelain") !== "") {
        keep("uncommitted changes");
        continue;
      }
      if (state.outcome === "merged") {
        Bun.spawnSync(["git", "-C", source, "fetch", "origin"]); // best effort: a stale origin ref only keeps the branch
        const target = targetBranch(source);
        if (
          Bun.spawnSync([
            "git",
            "-C",
            source,
            "merge-base",
            "--is-ancestor",
            branch,
            `origin/${target}`,
          ]).exitCode !== 0
        ) {
          keep(`branch is not in ${target}`);
          continue;
        }
      }
      git(source, "worktree", "remove", path);
    }
    Bun.spawnSync(["git", "-C", source, "branch", "-D", branch]);
    console.log(`removed  ${repo}  ${branch}`);
  }
}
