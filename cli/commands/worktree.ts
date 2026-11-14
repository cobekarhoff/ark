import { worktreeAnchor, worktreeCreate, worktreeSync, workspaceSync } from "../worktree.ts";
import type { Command } from "./types.ts";

export const worktreeAnchorCommand: Command = {
  usage: "worktree anchor <run> [--project <name>]",
  description:
    "Makes the run's worktree early, for the first repo of the workspace, with the same branch, `setup` and `worktree.created` event as `worktree create`. It prints one line, `path:<absolute path>`, the folder to start the run lead and its first workers in. A second call prints the same line and records nothing. A later `worktree create` prints `exists` for that repo. A repo with `repos.<repo>.base` in ark.yml starts from `origin/<base>` after `git fetch origin <base>`, not from the clone's HEAD; a failed fetch exits 1, names the repo and makes no worktree. If `setup` exits non-zero it removes the worktree and exits 1, as `worktree create` does. It refuses a closed run.",
  flags: { "--project": true },
  minimum: 1,
  maximum: 1,
  run: ([runId], flags) => worktreeAnchor(runId, flags["--project"] as string | undefined),
};

export const worktreeCreateCommand: Command = {
  usage: "worktree create <run> [<repo>...] [--allow-dirty] [--project <name>]",
  description:
    "Builds the run's workspace mirror. A repo with `repos.<repo>.base` in ark.yml gets its worktree from `origin/<base>` after `git fetch origin <base>`, not from the clone's HEAD; if that fetch fails the command exits 1, names the repo and the fetch error, and makes no worktree for it. Each named repo, or every repo the plan uses, gets a worktree on the branch `ark/<ticket id>-<slug>`, or on the lowest free `-2`, `-3`, ... suffix when that name exists locally or on origin; `worktree.created` records the branch. Before it adds any worktree it checks every nested repo that has none yet for uncommitted changes: it prints the changed paths and exits 1, and makes nothing. With `--allow-dirty` it prints the paths as a warning and branches from HEAD without those changes. The root repo `.` is never refused and needs no flag: when the command makes the root worktree and the root has uncommitted changes, it prints `warning  .        <workspace> has <n> uncommitted changes, not in the worktree` and the paths on stderr, once per run, and exits 0. Every other path is a symlink to the workspace. When `ark.yml` sets `setup`, the command runs it with `sh -c` in each new worktree. If `setup` exits non-zero, the command removes that worktree and its branch, prints the repo, the exit code and the last 10 lines of stderr (of stdout when stderr is empty), and exits 1. If the removal fails, the output names each `left behind` worktree path and branch. It records the worktree only after `setup` passes. A repo folder with a `.git` and no recorded worktree is a stale leftover: the next create removes it, then runs `setup` again.",
  flags: { "--allow-dirty": false, "--project": true },
  minimum: 1,
  maximum: Infinity,
  run: ([runId, ...repos], flags) =>
    worktreeCreate(
      runId,
      repos,
      flags["--project"] as string | undefined,
      flags["--allow-dirty"] === true,
    ),
};

export const worktreeSyncCommand: Command = {
  usage: "worktree sync <run> [--project <name>]",
  description:
    "Fetches and merges origin's target branch (`repos.<repo>.base` when set, else the branch origin/HEAD names) into each worktree of the run, and pushes the branch of each repo that has an MR (never for a project with `merge_requests: none`). It records worktree.synced for each repo, with `conflicts`, the sorted repo-relative paths that conflicted (omitted for a clean merge); a merge that succeeded also records `target_commit`, the origin tip it merged, and `ark test` runs the base side at it. A finished `--merge` step records the same event. Before the merge it checks that no `test/cases/<id>.md` the branch added since the merge-base exists on the target with other content; if one does, it records a conflict, skips the merge and the push, and goes on to the next repo. On a merge conflict it reads the conflicted paths first. When every one is listed under `generated` in ark.yml, it runs the command of each with `sh -c` in the worktree, checks that no listed file still holds a conflict marker and that the commands changed no other file, commits the result as the merge, records no conflict (`conflicts` still lists the paths) and goes on as after a clean merge, printing a `regenerate:` line on stderr; such a merge is not a clean sync merge, so the head counts as changed since the last test and `ark merge-request open` needs a new `ark test`. When any other path conflicts, no path conflicts (git refused the merge), a command fails, a marker stays, another file changes or the commit fails, it records the conflict, undoes the merge and goes on to the next repo. After the last repo it exits 1, printing `test case id taken on the target branch: <id>` for each taken id and naming every conflicting repo. After a successful merge, when `setup` is set in ark.yml and the merge changed `package.json` or `bun.lock`, or the marker `.omp/setup-pending` exists in the worktree (also when the merge changes nothing), it runs `setup` with `sh -c` in the worktree before the push. The marker is written before setup and removed when setup succeeds. If setup fails it keeps the marker, skips the push for that repo, records no conflict, goes on to the next repo, and after the last repo exits 1 naming the repo; the next sync retries setup. Setup lines and output go to stderr. With no `setup`, it runs nothing and writes no marker. A closed run gets a phase error and its worktrees stay unchanged. It never merges an MR.",
  flags: { "--project": true },
  minimum: 1,
  maximum: 1,
  run: ([runId], flags) => worktreeSync(runId, flags["--project"] as string | undefined),
};

export const workspaceSyncCommand: Command = {
  usage: "workspace sync <run> [--project <name>]",
  description:
    "Fetches and fast-forwards the target branch (`repos.<repo>.base` when set, else the branch origin/HEAD names) of the workspace checkout of each repo the run touched. It exits 1 and names the repo when git refuses, for example on a conflicting local change. It prints repo, branch and head.",
  flags: { "--project": true },
  minimum: 1,
  maximum: 1,
  run: ([runId], flags) => workspaceSync(runId, flags["--project"] as string | undefined),
};
