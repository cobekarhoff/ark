import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.ts";
import { ArkError } from "./errors.ts";
import { appendEvent, deriveState, readEvents, type RunState } from "./events.ts";
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

/** Removes the worktree and its branch, then returns one "left behind" line for each that is still there. */
function removeWorktree(source: string, path: string, branch: string, forces: number): string[] {
  const force = Array<string>(forces).fill("--force");
  Bun.spawnSync(["git", "-C", source, "worktree", "remove", ...force, path]);
  Bun.spawnSync(["git", "-C", source, "branch", "-D", branch]);
  const left: string[] = [];
  if (pathExists(path)) left.push(`left behind  worktree  ${path}`);
  const branches = Bun.spawnSync(["git", "-C", source, "branch", "--list", branch]);
  if (branches.stdout.toString().trim() !== "") left.push(`left behind  branch    ${branch}`);
  if (left.length > 0)
    left.push(
      `Remove them with: git -C ${source} worktree remove --force --force ${path} && git -C ${source} branch -D ${branch}`,
    );
  return left;
}

/** Makes the worktree of one repo in the run's mirror: branch, `git worktree add`, `setup`, then the worktree.created event. Does nothing when the repo already has a recorded worktree. */
function addRepoWorktree(
  runId: string,
  directory: string,
  workspace: string,
  setup: string | undefined,
  state: RunState,
  repo: string,
  log: (line: string) => void,
): void {
  const mirror = mirrorRoot(directory);
  mkdirSync(mirror, { recursive: true });
  const path = repo === "." ? mirror : join(mirror, repo);
  const isSymlink = pathExists(path) && lstatSync(path).isSymbolicLink();
  const source = join(workspace, repo);
  const branch = branchName(runId, state.ticket);
  if (!isSymlink && existsSync(join(path, ".git"))) {
    if (state.worktrees.some((worktree) => worktree.repo === repo)) {
      log(`exists   ${repo}`);
      return;
    }
    // no worktree.created event: an earlier create failed and its cleanup failed too
    const left = removeWorktree(source, path, branch, 2);
    if (left.length > 0)
      throw new ArkError(
        `could not remove the stale leftover in repo "${repo}"\n${left.join("\n")}`,
      );
    log(`removed  ${repo} (stale leftover of an earlier failed create)`);
  }
  if (isSymlink) unlinkSync(path); // an earlier call left this repo untouched
  mkdirSync(dirname(path), { recursive: true });
  const base = git(source, "rev-parse", "HEAD");
  git(source, "worktree", "add", "-b", branch, path, base);
  log(`created  ${repo} -> ${path}`);
  // yolo: lower tools.approvalMode values stopped a worker at its first shell call (findings/permission-modes.md).
  // `.omp/.gitignore` ("*") hides the folder, itself included, from status and `git add`; it touches no shared git file.
  mkdirSync(join(path, ".omp"), { recursive: true });
  writeFileSync(join(path, ".omp", "config.yml"), "tools:\n  approvalMode: yolo\n");
  writeFileSync(join(path, ".omp", ".gitignore"), "*\n");
  log(`setting  ${repo}: .omp/config.yml`);
  if (setup) {
    const result = Bun.spawnSync(["sh", "-c", setup], { cwd: path });
    if (result.exitCode !== 0) {
      const left = removeWorktree(source, path, branch, 1);
      if (left.length === 0) log(`removed  ${repo} (setup failed, worktree and branch deleted)`);
      // stderr wins when it has text; otherwise the cause is on stdout
      const stderr = result.stderr.toString().trim();
      const cause = (stderr || result.stdout.toString().trim()).split("\n").slice(-10).join("\n");
      throw new ArkError(
        [
          `setup failed in repo "${repo}": \`${setup}\` exited ${result.exitCode}`,
          ...(cause ? [cause] : []),
          ...left,
        ].join("\n"),
      );
    }
    log(`setup    ${repo}: ${setup}`);
  }
  appendEvent(directory, "worktree.created", { repo, path, branch, base });
}

/** Early worktree of the first repo of the workspace, so the run lead and its first workers have their own folder. Prints `path:<absolute path>`; a second call prints the same line and records nothing. */
export function worktreeAnchor(runId: string, inProject?: string): void {
  const { project, directory } = findRun(runId, inProject);
  const config = loadConfig(project);
  const repo = discoverRepos(config.workspace)[0];
  if (repo === undefined) throw new ArkError(`workspace ${config.workspace} has no git repo`);
  const state = deriveState(readEvents(directory));
  assertAllowed(state, "worktree.created", {}); // refuse before git changes anything
  addRepoWorktree(runId, directory, config.workspace, config.setup, state, repo, () => {});
  const mirror = mirrorRoot(directory);
  console.log(`path:${repo === "." ? mirror : join(mirror, repo)}`);
}

export function worktreeCreate(runId: string, repos: string[], inProject?: string): void {
  const { project, directory } = findRun(runId, inProject);
  const config = loadConfig(project);
  const workspace = config.workspace;
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

  for (const repo of touched)
    addRepoWorktree(runId, directory, workspace, config.setup, state, repo, console.log);

  const mirror = mirrorRoot(directory);
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

/** Merges origin/<target> into every worktree and pushes the branch of each repo with an open MR. A conflicting repo is recorded and skipped; after the last repo one error names every conflicting repo. */
export function worktreeSync(runId: string, inProject?: string): void {
  const { directory } = findRun(runId, inProject);
  const state = deriveState(readEvents(directory));
  if (state.worktrees.length === 0) throw new ArkError(`${runId} has no worktrees`);
  assertAllowed(state, "worktree.synced", { repo: state.worktrees[0].repo, conflict: false });
  const conflicts: string[] = [];
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
    appendEvent(directory, "worktree.synced", {
      repo: worktree.repo,
      conflict: merged.exitCode !== 0,
    });
    if (merged.exitCode !== 0) {
      Bun.spawnSync(["git", "-C", worktree.path, "merge", "--abort"]);
      conflicts.push(
        `repo ${worktree.repo}: merging origin/${target} failed, worktree left unchanged: ${merged.stdout.toString().trim()}${merged.stderr.toString().trim()}`,
      );
      continue;
    }
    const pushed = state.merge_requests.some((merge) => merge.repo === worktree.repo);
    if (pushed) git(worktree.path, "push", "origin", worktree.branch);
    console.log(
      `${worktree.repo}  ${target}  ${git(worktree.path, "rev-parse", "HEAD")}${pushed ? "  pushed" : ""}`,
    );
  }
  if (conflicts.length > 0) throw new ArkError(conflicts.join("\n"));
}

/** Entries of `git status` for a worktree, minus untracked entries Ark made itself: a symlink of the mirror, and a nested worktree of the run. Any other untracked or modified entry counts. */
function dirtyLines(path: string, worktreePaths: string[]): string[] {
  const records = git(path, "status", "--porcelain", "-z", "--untracked-files=all")
    .split("\0")
    .filter((record) => record !== "");
  const dirty: string[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record[0] === "R" || record[0] === "C") index++; // a rename or copy carries its source path as the next record
    if (!record.startsWith("?? ")) {
      dirty.push(record);
      continue;
    }
    const entry = join(path, record.slice(3).replace(/\/$/, ""));
    if (lstatSync(entry).isSymbolicLink() || worktreePaths.includes(entry)) continue;
    dirty.push(record);
  }
  return dirty;
}

/** Removes each worktree of a closed run and its local branch. Keeps a dirty worktree, and for a merged run an unmerged branch, and prints the repo and the reason. */
export function worktreeCleanup(runId: string, inProject?: string): void {
  const { project, directory } = findRun(runId, inProject);
  const state = deriveState(readEvents(directory));
  const workspace = loadConfig(project).workspace;
  let kept = false;
  for (const { repo, path, branch } of [...state.worktrees].reverse()) {
    // newest first: the anchor of a root repo holds the nested worktrees
    const source = join(workspace, repo);
    const keep = (reason: string) => {
      kept = true;
      console.log(`kept     ${repo}  ${branch}: ${reason}`);
    };
    if (!existsSync(path)) {
      Bun.spawnSync(["git", "-C", source, "worktree", "prune"]);
    } else {
      if (
        dirtyLines(
          path,
          state.worktrees.map((other) => other.path),
        ).length > 0
      ) {
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
      git(source, "worktree", "remove", "--force", path); // clean but for Ark's own symlinks
    }
    Bun.spawnSync(["git", "-C", source, "branch", "-D", branch]);
    console.log(`removed  ${repo}  ${branch}`);
  }
  // What is left of workspace/ is Ark's own symlinks and empty folders; rmSync does not follow links.
  if (!kept) rmSync(mirrorRoot(directory), { recursive: true, force: true });
}
