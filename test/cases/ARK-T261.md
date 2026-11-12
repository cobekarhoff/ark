---
id: ARK-T261
title: ARK-T261 every git process of the suites, including those started by `ark worktree create`, `ark test` and Playwright, runs with automatic maintenance and gc off
level: integration
technique: equivalence classes over the entry points (bun test, ark CLI child, ark test, Playwright), observation at the point of git execution through a PATH shim
priority: high
risk: a test git process starts background maintenance (`maintenance.lock`, `gc.pid`) in a template or test repo, and a later cpSync of the template or a git call races it, so CI fails on ENOENT or exit 1 and passes on rerun. Checking config from the test process afterwards would pass even if the CLI or Playwright launcher dropped the settings
status: active
changed_by: 2026-11-11-ARK-423-1
---

## Objective

Prove that the git processes actually executed by each suite entry point, including descendants of the `ark` CLI, receive `maintenance.auto` false and `gc.auto` 0, and that no background maintenance starts.

## Preconditions

- A git shim on PATH (the `writeFakeCommand` pattern of ARK-T159). Each call it receives first runs the real git as `git config --get maintenance.auto` and `git config --get gc.auto` in the shim's own inherited environment, appends `<argv0 args> maintenance.auto=<v|unset> gc.auto=<v|unset>` to a log file, then runs the real git with the original arguments. PATH is restored afterward.
- The test sets no `GIT_CONFIG_*` variable, `maintenance.*` or `gc.*` setting itself and does not pass `-c`; settings must come from the project's own preload, config and launchers.
- Scratch ark project as in `test/worktree.test.ts`.

## Steps

1. Entry point `bun test`: with the shim on PATH call `tempGitRepo(files)` for a fresh file set (forces a build) and make a commit in it. Read the shim log.
2. Entry point `ark` CLI child: spawn the real `ark worktree create` as a child process (same way `test/worktree.test.ts` does) with the shim on PATH. Then make a real commit inside the created worktree and read the shim log lines for the child and for that commit.
3. Entry point `ark test`: run `ark test` against a scratch project whose test command is `git status` (through the shim) and read the log.
4. Entry point Playwright: launch it as an independent process the way the project's Playwright suite is launched, not as a descendant that inherits the Bun test process's protection. Its environment is built from scratch: only PATH (with the shim), HOME and what the launcher itself needs, with every `GIT_CONFIG_*`, `GIT_*` and Bun preload variable of the parent removed. It runs a one-test spec that executes `git rev-parse HEAD` in a scratch repo. Read the log.
5. After the commit in step 1 and the commit in step 2, resolve each repo's git directory (`git rev-parse --git-dir`; for the worktree this is its own gitdir) and list `maintenance.lock` and `gc.pid` in it and in the common git directory.

## Expected results

- Every shim log line from steps 1 to 4 shall show `maintenance.auto=false gc.auto=0`; each of the four entry points, and the commit in the created worktree, shall have at least one line (so an unobserved entry point fails the case).
- No `maintenance.lock` and no `gc.pid` file shall exist in the git directory of the temporary repo or of the created worktree after their commits.
- The case shall fail if the CLI child, `ark test` or the independent Playwright launch drops the settings. Because step 4 starts from a clean environment, protection set only in the Bun test process cannot satisfy it.

## Screenshot checkpoints

none: no UI; the proof is the shim log and the file listing.
