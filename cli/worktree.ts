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
import { basename, dirname, join } from "node:path";
import { loadConfig, type ProjectConfig } from "./config.ts";
import { ArkError } from "./errors.ts";
import { appendEvent, deriveState, readEvents, type RunState } from "./events.ts";
import { findRun } from "./paths.ts";
import { assertAllowed } from "./transitions.ts";
import {
  discoverRepos,
  git,
  mirrorRoot,
  repoBase,
  submodulesOf,
  targetBranch,
} from "./workspace.ts";
import { mergeRequestState } from "./merge-request.ts";

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

/** `ark/<ticket id>-<slug>`. The slug is the title, lowercase, hyphenated, at most 40 characters. */
function baseBranchName(ticket: { id: string; title: string }): string {
  const slug = ticket.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `ark/${ticket.id}${slug ? `-${slug}` : ""}`;
}

/** Where the branch `name` exists in `source`: `locally`, `on origin`, or undefined when free. A repo without an origin remote, or with an unreachable one, falls back to the local refs. */
function branchTakenAt(source: string, name: string): string | undefined {
  const has = (ref: string) =>
    Bun.spawnSync(["git", "-C", source, "show-ref", "--verify", "--quiet", ref]).exitCode === 0;
  if (has(`refs/heads/${name}`)) return "locally";
  if (has(`refs/remotes/origin/${name}`)) return "on origin";
  const listed = Bun.spawnSync(["git", "-C", source, "ls-remote", "--heads", "origin", name]);
  const onOrigin = listed.stdout
    .toString()
    .split("\n")
    .some((line) => line.endsWith(`\trefs/heads/${name}`));
  return onOrigin ? "on origin" : undefined;
}

/** The base name, or the lowest `-<n>` from 2 that is free locally and on origin. `taken` says why the base name was not used. */
function freeBranchName(source: string, base: string): { branch: string; taken?: string } {
  const where = branchTakenAt(source, base);
  if (where === undefined) return { branch: base };
  for (let suffix = 2; ; suffix++) {
    const branch = `${base}-${suffix}`;
    if (branchTakenAt(source, branch) === undefined)
      return { branch, taken: `${base} exists ${where}` };
  }
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

/** The commit a new worktree of `repo` starts from: origin/<base> after a fetch when the project sets a base, else the clone HEAD. */
function resolveBase(config: ProjectConfig, repo: string): string {
  const source = join(config.workspace, repo);
  const configured = repoBase(config, repo);
  if (configured === undefined) return git(source, "rev-parse", "HEAD");
  try {
    git(source, "fetch", "origin", configured);
    return git(source, "rev-parse", `origin/${configured}`);
  } catch (err) {
    if (err instanceof ArkError) throw new ArkError(`repo ${repo}: ${err.message}`);
    throw err;
  }
}

const SKILL_DIRECTORIES = [".claude/skills", ".agents/skills", ".omp/skills"];

/** The `--allow-dirty` warning text: one header and up to 10 changed paths. */
function dirtyWarning(repo: string, source: string, lines: string[]): string {
  const shown = 10;
  return [
    `warning  ${repo.padEnd(8)} ${source} has ${lines.length} uncommitted ${lines.length === 1 ? "change" : "changes"}, not in the worktree`,
    ...lines.slice(0, shown).map((line) => `             ${line}`),
    ...(lines.length > shown ? [`             ... and ${lines.length - shown} more`] : []),
  ].join("\n");
}

/** Makes the worktree of one repo in the run's mirror: branch, `git worktree add`, `setup`, then the worktree.created event. Does nothing when the repo already has a recorded worktree. A new root worktree warns on stderr about root changes the mirror lacks; `checkClean` never refuses the root. */
function addRepoWorktree(
  directory: string,
  config: ProjectConfig,
  state: RunState,
  repo: string,
  log: (line: string) => void,
  resolvedBase?: string,
): void {
  const { workspace, setup } = config;
  const mirror = mirrorRoot(directory);
  mkdirSync(mirror, { recursive: true });
  const path = repo === "." ? mirror : join(mirror, repo);
  const isSymlink = pathExists(path) && lstatSync(path).isSymbolicLink();
  const source = join(workspace, repo);
  if (!isSymlink && existsSync(join(path, ".git"))) {
    if (state.worktrees.some((worktree) => worktree.repo === repo)) {
      log(`exists   ${repo}`);
      return; // create still runs the submodule step on it
    }
    // no worktree.created event: an earlier create failed and its cleanup failed too.
    // Its branch is the one checked out there; a new name search would not find it.
    const oldBranch = Bun.spawnSync(["git", "-C", path, "symbolic-ref", "--short", "HEAD"])
      .stdout.toString()
      .trim();
    const left = removeWorktree(source, path, oldBranch, 2);
    if (left.length > 0)
      throw new ArkError(
        `could not remove the stale leftover in repo "${repo}"\n${left.join("\n")}`,
      );
    log(`removed  ${repo} (stale leftover of an earlier failed create)`);
  }
  if (isSymlink) unlinkSync(path); // an earlier call left this repo untouched
  mkdirSync(dirname(path), { recursive: true });
  const { branch, taken } = freeBranchName(source, baseBranchName(state.ticket));
  const base = resolvedBase ?? resolveBase(config, repo);
  git(source, "worktree", "add", "-b", branch, path, base);
  log(`created  ${repo} -> ${path}`);
  // yolo: lower tools.approvalMode values stopped a worker at its first shell call (findings/permission-modes.md).
  // `.omp/.gitignore` ("*") hides the folder, itself included, from status and `git add`; it touches no shared git file.
  mkdirSync(join(path, ".omp"), { recursive: true });
  const skillDirectories =
    repo === "." ? [] : SKILL_DIRECTORIES.filter((name) => existsSync(join(workspace, name)));
  const settings = {
    tools: { approvalMode: "yolo" },
    // omp reads <cwd>/.claude/skills natively, so only a nested worktree needs the root's folders.
    ...(skillDirectories.length > 0 && {
      skills: {
        customDirectories: skillDirectories.map((name) => join(mirror, name)),
      },
    }),
  };
  writeFileSync(join(path, ".omp", "config.yml"), `${Bun.YAML.stringify(settings, null, 2)}\n`);
  writeFileSync(join(path, ".omp", ".gitignore"), "*\n");
  log(`setting  ${repo}: .omp/config.yml`);
  if (taken) log(`branch   ${repo}  ${branch} (${taken})`);
  // before setup, so install and build commands find their libraries; a failure keeps the worktree, recorded
  const recorded = { repo, path, branch, base };
  try {
    composeSubmodules(
      config,
      [...deriveState(readEvents(directory)).worktrees, recorded],
      recorded,
      log,
    );
  } catch (err) {
    if (err instanceof ArkError) appendEvent(directory, "worktree.created", recorded);
    throw err;
  }
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
  if (repo === ".") {
    const nested = discoverRepos(workspace).map((name) => join(workspace, name));
    const lines = dirtyLines(workspace, nested);
    if (lines.length > 0) console.error(dirtyWarning(repo, workspace, lines));
  }
}

const submoduleFlag = "protocol.file.allow=always";

/** The line `ark status` and create print for a submodule checked out at the head of the run's library worktree. */
function submoduleLine(consumer: string, path: string, library: string, head: string): string {
  return `submodule ${consumer}/${path} at run head of ${library} ${head.slice(0, 8)}`;
}

const withoutGit = (url: string): string => url.replace(/\/+$/, "").replace(/\.git$/, "");

/** The run worktree a submodule is checked out from: the repo whose origin URL equals the .gitmodules URL, else the repo with the same basename as the URL (or the submodule folder). A consumer is never its own library. */
function libraryOf(
  config: ProjectConfig,
  worktrees: RunState["worktrees"],
  consumer: string,
  submodule: { path: string; url: string },
): RunState["worktrees"][number] | undefined {
  const others = worktrees.filter((worktree) => worktree.repo !== consumer);
  const originOf = (repo: string) =>
    Bun.spawnSync(["git", "-C", join(config.workspace, repo), "config", "remote.origin.url"])
      .stdout.toString()
      .trim();
  const byUrl = others.find((worktree) => {
    const origin = originOf(worktree.repo);
    return origin !== "" && withoutGit(origin) === withoutGit(submodule.url);
  });
  if (byUrl) return byUrl;
  const names = [basename(withoutGit(submodule.url)), basename(submodule.path)];
  return others.find((worktree) => names.includes(basename(worktree.repo)));
}

/** Fills one submodule folder at the commit the index records. Tries each local source that exists as the clone URL (git objects stay reachable when the remote is not), then the `.gitmodules` URL; the last failure is thrown. */
export function initSubmodule(
  consumerPath: string,
  submodule: { name: string; path: string },
  sources: string[],
): void {
  const attempts: (string | undefined)[] = [
    ...sources.filter((source) => existsSync(join(source, ".git"))),
    undefined,
  ];
  for (const [index, source] of attempts.entries()) {
    try {
      git(
        consumerPath,
        "-c",
        submoduleFlag,
        ...(source ? ["-c", `submodule.${submodule.name}.url=${source}`] : []),
        "submodule",
        "update",
        "--init",
        "--",
        submodule.path,
      );
      // the -c override is not stored: record the .gitmodules URL so git status still sees the submodule
      git(consumerPath, "submodule", "init", "--", submodule.path);
      return;
    } catch (err) {
      if (!(err instanceof ArkError) || index === attempts.length - 1) throw err;
    }
  }
}

/** Fills each submodule of a worktree at the commit its index records, cloned from the run's library worktree or the source clone's module when they exist, then, for a submodule whose repo the run also has a worktree of, checks it out at the committed HEAD of that worktree. Never stages: the index pointer stays. A failure names the consumer, the submodule and the git cause; the worktree stays. */
function composeSubmodules(
  config: ProjectConfig,
  worktrees: RunState["worktrees"],
  consumer: { repo: string; path: string },
  log: (line: string) => void,
): void {
  const submodules = submodulesOf(consumer.path);
  if (submodules.length === 0) return;
  const stage = () => git(consumer.path, "ls-files", "--stage");
  const before = stage();
  for (const submodule of submodules) {
    try {
      const library = libraryOf(config, worktrees, consumer.repo, submodule);
      initSubmodule(consumer.path, submodule, [
        ...(library ? [library.path] : []),
        join(config.workspace, consumer.repo, submodule.path),
      ]);
      if (!library) continue;
      const head = git(library.path, "rev-parse", "HEAD");
      const folder = join(consumer.path, submodule.path);
      git(folder, "-c", submoduleFlag, "fetch", library.path, "HEAD");
      git(folder, "checkout", "--detach", head);
      log(submoduleLine(consumer.repo, submodule.path, library.repo, head));
    } catch (err) {
      if (!(err instanceof ArkError)) throw err;
      throw new ArkError(`submodule ${consumer.repo}/${submodule.path} failed: ${err.message}`);
    }
  }
  if (stage() !== before)
    throw new ArkError(`submodule step changed the index of ${consumer.repo}: pointers must stay`);
}

/** One status line per submodule that sits at the head of the run's library worktree, recomputed from git now. A submodule at another commit prints nothing. */
export function submoduleLines(config: ProjectConfig, worktrees: RunState["worktrees"]): string[] {
  const lines: string[] = [];
  for (const consumer of worktrees) {
    try {
      for (const submodule of submodulesOf(consumer.path)) {
        const library = libraryOf(config, worktrees, consumer.repo, submodule);
        if (!library) continue;
        const head = git(library.path, "rev-parse", "HEAD");
        if (git(join(consumer.path, submodule.path), "rev-parse", "HEAD") === head)
          lines.push(submoduleLine(consumer.repo, submodule.path, library.repo, head));
      }
    } catch (err) {
      if (!(err instanceof ArkError)) throw err; // an unreadable worktree prints no line
    }
  }
  return lines;
}

/** Early worktree of the first repo of the workspace, so the run lead and its first workers have their own folder. Prints `path:<absolute path>`; a second call prints the same line and records nothing. */
export function worktreeAnchor(runId: string, inProject?: string): void {
  const { project, directory } = findRun(runId, inProject);
  const config = loadConfig(project);
  const repo = discoverRepos(config.workspace)[0];
  if (repo === undefined) throw new ArkError(`workspace ${config.workspace} has no git repo`);
  const state = deriveState(readEvents(directory));
  assertAllowed(state, "worktree.created", {}); // refuse before git changes anything
  addRepoWorktree(directory, config, state, repo, () => {});
  const created = deriveState(readEvents(directory)).worktrees;
  const anchor = created.find((entry) => entry.repo === repo);
  if (anchor) composeSubmodules(config, created, anchor, () => {});
  const mirror = mirrorRoot(directory);
  console.log(`path:${repo === "." ? mirror : join(mirror, repo)}`);
}

/** Checks every nested repo that still needs a worktree for uncommitted changes before any worktree is added. The root `.` is skipped: its worktree warns on stderr instead. Throws and names the changed paths, or with `allowDirty` prints a warning per repo. */
function checkClean(
  workspace: string,
  knownRepos: string[],
  repos: string[],
  state: RunState,
  allowDirty: boolean,
): void {
  const nested = knownRepos.map((repo) => join(workspace, repo));
  const dirty = repos
    .filter((repo) => repo !== "." && !state.worktrees.some((worktree) => worktree.repo === repo))
    .map((repo) => ({
      repo,
      source: join(workspace, repo),
      lines: [] as string[],
    }))
    .map((entry) => ({ ...entry, lines: dirtyLines(entry.source, nested) }))
    .filter(({ lines }) => lines.length > 0);
  if (dirty.length === 0) return;
  const shown = 10;
  if (allowDirty) {
    for (const { repo, source, lines } of dirty) console.log(dirtyWarning(repo, source, lines));
    return;
  }
  const report = dirty.flatMap(({ repo, source, lines }) => [
    `  dirty    ${repo.padEnd(8)} ${source}  (${lines.length} changed ${lines.length === 1 ? "file" : "files"})`,
    ...lines.slice(0, shown).map((line) => `             ${line}`),
    ...(lines.length > shown ? [`             ... and ${lines.length - shown} more`] : []),
  ]);
  throw new ArkError(
    [
      `refusing to create worktrees, ${dirty.length} ${dirty.length === 1 ? "repo has" : "repos have"} uncommitted changes:`,
      ...report,
      "Commit or stash them, or pass --allow-dirty to branch from HEAD without those changes.",
    ].join("\n"),
  );
}

export function worktreeCreate(
  runId: string,
  repos: string[],
  inProject?: string,
  allowDirty = false,
): void {
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
  checkClean(workspace, knownRepos, touched, state, allowDirty);

  // every fetch happens before the first worktree add or event: one bad base leaves nothing behind
  const bases = new Map(
    touched
      .filter((repo) => !state.worktrees.some((worktree) => worktree.repo === repo))
      .map((repo) => [repo, resolveBase(config, repo)]),
  );
  for (const repo of touched)
    addRepoWorktree(directory, config, state, repo, console.log, bases.get(repo));

  linkUntouched(workspace, mirrorRoot(directory), knownRepos);
  // after every worktree exists, so a library created later than its consumer is found
  const { worktrees } = deriveState(readEvents(directory));
  for (const repo of touched) {
    const worktree = worktrees.find((entry) => entry.repo === repo);
    if (worktree) composeSubmodules(config, worktrees, worktree, console.log);
  }
}

/** Links every root entry and repo of the workspace that the mirror does not hold yet. A single-repo workspace needs none: the worktree is the mirror. */
export function linkUntouched(workspace: string, mirror: string, knownRepos: string[]): void {
  if (knownRepos.length === 1 && knownRepos[0] === ".") return;
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

/** Ids of test/cases entries the branch added since the merge-base that origin/<target> holds with other content. */
function takenCaseIds(path: string, target: string): string[] {
  const run = (...args: string[]) => Bun.spawnSync(["git", "-C", path, ...args]);
  const base = run("merge-base", "HEAD", `origin/${target}`);
  if (base.exitCode !== 0) return [];
  const added = run(
    "diff",
    "--name-only",
    "--no-renames",
    "--diff-filter=A",
    base.stdout.toString().trim(),
    "HEAD",
    "--",
    "test/cases",
  );
  return added.stdout
    .toString()
    .split("\n")
    .filter((file) => /^test\/cases\/[^/]+\.md$/.test(file))
    .filter((file) => {
      const theirs = run("rev-parse", "--verify", "-q", `origin/${target}:${file}`);
      return (
        theirs.exitCode === 0 &&
        theirs.stdout.toString() !== run("rev-parse", `HEAD:${file}`).stdout.toString()
      );
    })
    .map((file) => file.slice("test/cases/".length, -".md".length));
}

/** Merges origin/<target> into every worktree and pushes the branch of each repo with an open MR. A conflicting repo is recorded and skipped; after the last repo one error names every conflicting repo. */
export function worktreeSync(runId: string, inProject?: string): void {
  const { project, directory } = findRun(runId, inProject);
  const state = deriveState(readEvents(directory));
  if (state.worktrees.length === 0) throw new ArkError(`${runId} has no worktrees`);
  const config = loadConfig(project);
  const mayPush = config.merge_requests !== "none";
  assertAllowed(state, "worktree.synced", {
    repo: state.worktrees[0].repo,
    conflict: false,
  });
  const conflicts: string[] = [];
  for (const worktree of state.worktrees) {
    git(worktree.path, "fetch", "origin");
    const target = targetBranch(worktree.path, repoBase(config, worktree.repo));
    const taken = takenCaseIds(worktree.path, target);
    if (taken.length > 0) {
      appendEvent(directory, "worktree.synced", {
        repo: worktree.repo,
        conflict: true,
      });
      conflicts.push(...taken.map((id) => `test case id taken on the target branch: ${id}`));
      continue;
    }
    // a library head left in a submodule makes the merge see a changed pointer: put the recorded commit back first
    if (submodulesOf(worktree.path).length > 0)
      git(worktree.path, "-c", submoduleFlag, "submodule", "update", "--init");
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
    const pushed = mayPush && state.merge_requests.some((merge) => merge.repo === worktree.repo);
    if (pushed) git(worktree.path, "push", "origin", worktree.branch);
    console.log(
      `${worktree.repo}  ${target}  ${git(worktree.path, "rev-parse", "HEAD")}${pushed ? "  pushed" : ""}`,
    );
  }
  // after every merge, so a library merged later in the loop is the head the consumer gets
  for (const worktree of state.worktrees) {
    try {
      composeSubmodules(config, state.worktrees, worktree, console.log);
    } catch (err) {
      if (!(err instanceof ArkError)) throw err;
      conflicts.push(err.message);
    }
  }
  if (conflicts.length > 0) throw new ArkError(conflicts.join("\n"));
}

/** Entries of `git status` for a worktree, minus untracked entries Ark made itself: a symlink of the mirror, and a nested worktree of the run. Any other untracked or modified entry counts. `composedHead` names the commit Ark checked a submodule folder out at: a submodule at that commit with a clean tree is not dirty. */
function dirtyLines(
  path: string,
  worktreePaths: string[],
  composedHead?: (folder: string) => string | undefined,
): string[] {
  // not git(): its trim would eat the leading space of the first record
  const status = Bun.spawnSync([
    "git",
    "-C",
    path,
    "status",
    "--porcelain",
    "-z",
    "--untracked-files=all",
  ]);
  if (status.exitCode !== 0)
    throw new ArkError(`git status failed in ${path}: ${status.stderr.toString().trim()}`);
  const records = status.stdout
    .toString()
    .split("\0")
    .filter((record) => record !== "");
  const isComposed = (record: string): boolean => {
    if (!composedHead || !record.startsWith(" M ")) return false;
    const folder = record.slice(3);
    const expected = composedHead(folder);
    if (!expected) return false;
    try {
      if (!git(path, "ls-files", "--stage", "--", folder).startsWith("160000")) return false;
      const inside = join(path, folder);
      return (
        git(inside, "rev-parse", "HEAD") === expected &&
        git(inside, "status", "--porcelain", "--untracked-files=all") === ""
      );
    } catch (err) {
      if (err instanceof ArkError) return false; // unreadable submodule: keep the worktree
      throw err;
    }
  };
  const dirty: string[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record[0] === "R" || record[0] === "C") index++; // a rename or copy carries its source path as the next record
    if (!record.startsWith("?? ")) {
      if (!isComposed(record)) dirty.push(record);
      continue;
    }
    const entry = join(path, record.slice(3).replace(/\/$/, ""));
    if (lstatSync(entry).isSymbolicLink() || worktreePaths.includes(entry)) continue;
    dirty.push(record);
  }
  return dirty;
}

/** Commits of `branch` beyond `base`, counted in the source repo; undefined when the count fails. */
export function commitsAhead(source: string, branch: string, base?: string): number | undefined {
  if (!base) return undefined;
  const counted = Bun.spawnSync(["git", "-C", source, "rev-list", "--count", `${base}..${branch}`]);
  return counted.exitCode === 0 ? Number(counted.stdout.toString().trim()) : undefined;
}

/** Why the branch of a handed_off or aborted run must stay: commits beyond its base, or a count that failed. Counted in the source repo, so it works with the worktree gone. */
function handedOffReason(
  outcome: string | null,
  source: string,
  branch: string,
  base?: string,
): string | undefined {
  if (outcome !== "handed_off" && outcome !== "aborted") return undefined;
  const label = outcome === "aborted" ? "aborted" : "handed off";
  const ahead = commitsAhead(source, branch, base);
  if (ahead === undefined) return `${label}, could not count the commits ahead of its base`;
  if (ahead > 0)
    return `${label}, ${ahead} ${ahead === 1 ? "commit" : "commits"} ahead of ${base?.slice(0, 8)}`;
}

/** Removes each worktree of a closed run and its local branch. Keeps a dirty worktree, for a merged run an unmerged branch, and for a handed_off or aborted run a branch with commits beyond its base; prints the repo and the reason. */
export function worktreeCleanup(runId: string, inProject?: string): void {
  const { project, directory } = findRun(runId, inProject);
  const state = deriveState(readEvents(directory));
  const config = loadConfig(project);
  const workspace = config.workspace;
  let kept = false;
  for (const { repo, path, branch, base } of [...state.worktrees].reverse()) {
    // newest first: the anchor of a root repo holds the nested worktrees
    const source = join(workspace, repo);
    const keep = (reason: string) => {
      kept = true;
      console.log(`kept     ${repo}  ${branch}: ${reason}`);
    };
    if (!existsSync(path)) {
      Bun.spawnSync(["git", "-C", source, "worktree", "prune"]);
      const handedOff = handedOffReason(state.outcome, source, branch, base);
      if (handedOff !== undefined) {
        console.log(`kept     ${repo}  ${branch}: ${handedOff}`);
        continue;
      }
    } else {
      const composedHead = (folder: string): string | undefined => {
        const submodule = submodulesOf(path).find((entry) => entry.path === folder);
        const library = submodule && libraryOf(config, state.worktrees, repo, submodule);
        if (!library) return undefined;
        const head = existsSync(library.path)
          ? Bun.spawnSync(["git", "-C", library.path, "rev-parse", "HEAD"])
          : Bun.spawnSync([
              "git",
              "-C",
              join(workspace, library.repo),
              "rev-parse",
              library.branch,
            ]);
        return head.exitCode === 0 ? head.stdout.toString().trim() : undefined;
      };
      if (
        dirtyLines(
          path,
          state.worktrees.map((other) => other.path),
          composedHead,
        ).length > 0
      ) {
        keep("uncommitted changes");
        continue;
      }
      if (state.outcome === "merged") {
        // before the worktree is removed: the host call runs inside it
        const mergeRequest = state.merge_requests.find((merge) => merge.repo === repo);
        const mergeState = mergeRequest ? mergeRequestState(mergeRequest, path) : "none";
        if (mergeState !== "merged") {
          // a squash or rebase merge leaves the branch out of the target, so only a merged MR proves it
          const fetched = Bun.spawnSync(["git", "-C", source, "fetch", "origin"]);
          const target = targetBranch(source, repoBase(config, repo));
          const inTarget =
            Bun.spawnSync([
              "git",
              "-C",
              source,
              "merge-base",
              "--is-ancestor",
              branch,
              `origin/${target}`,
            ]).exitCode === 0;
          if (!inTarget) {
            const unknown = mergeState === "none" || mergeState === "unknown";
            if (fetched.exitCode !== 0 && unknown) {
              const reason = fetched.stderr.toString().trim().split("\n").join(" ");
              keep(`could not fetch origin (${reason}), cannot tell if the MR merged`);
            } else keep(`branch is not in ${target}`);
            continue;
          }
        }
      }
      // count in the source repo, before the worktree goes; an unknown count keeps the branch
      const handedOff = handedOffReason(state.outcome, source, branch, base);
      git(source, "worktree", "remove", "--force", path); // clean but for Ark's own symlinks
      if (handedOff !== undefined) {
        // the worktree is gone, so the mirror folder may go too: no kept = true
        console.log(`kept     ${repo}  ${branch}: ${handedOff}`);
        continue;
      }
    }
    Bun.spawnSync(["git", "-C", source, "branch", "-D", branch]);
    console.log(`removed  ${repo}  ${branch}`);
  }
  // What is left of workspace/ is Ark's own symlinks and empty folders; rmSync does not follow links.
  if (!kept) rmSync(mirrorRoot(directory), { recursive: true, force: true });
}
