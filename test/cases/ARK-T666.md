---
id: ARK-T666
title: ARK-T666 ark test-case new refuses in the project folder and every folder under it that is not a run worktree
level: integration
technique: equivalence classes (project folder, runs/, runs/<run>/, deeper folder, run worktree) with a state check that a refusal writes nothing
priority: high
risk: with the project folder a git repository, ark test-case new run from it (or from runs/, runs/<run>/, a deeper folder) takes the project repo as the code repo and writes a test/ folder and a counter and lock file into the project, which the autocommit pass commits; or the refusal is checked after the lock; or the guard also blocks the run's worktree, a nested repo inside the project folder
status: active
changed_by: 2026-11-14-ARK-494-1
---

## Objective

Prove that `ark test-case new <KEY>` without `--run` refuses when the nearest git repository is the project folder (`ARK_HOME/projects/<project>`), from any folder that resolves to it, names the `--run <run>` form, and leaves the project folder and its `.git` untouched. Prove that the run worktree, a nested repo under the project folder, still works.

## Preconditions

- A temporary `ARK_HOME` whose path goes through a symlink (as macOS `/var` to `/private/var` does). It holds a project `demo` with an `ark.yml` that names a `workspace:` main checkout (a temporary git repo with a commit) and a `runs/<run>/` folder.
- The project folder is a git repository (`git init`, `.gitignore` holding `runs/`, one commit), as the autocommit pass makes it.
- A run worktree of the main checkout at `runs/<run>/workspace` (made by `git worktree add`), recorded as the run's worktree. It is a nested repo: `git rev-parse --show-toplevel` there prints the worktree, not the project folder.
- Variant B: a second project folder `ARK_HOME/projects/other`, a git repository (one commit) with no `ark.yml` and an empty or missing `runs/`.

## Steps

1. Run `ark test-case new <KEY>` with no `--run` from the project folder. Record stdout, stderr, exit code.
2. Repeat from `runs/`, from `runs/<run>/`, from `runs/<run>/results` (create it) and from a deeper folder under the run folder that is not inside the worktree. Record the exit code and stderr of each.
3. Repeat from the variant B project folder `ARK_HOME/projects/other`. Record the exit code.
4. After the refusals, list the project folder's top level, check that no `test/` folder exists there, and list `.git` of the project folder for any `ark-test-case-<KEY>.counter` or `ark-test-case.lock` file. Run `git status --porcelain` in the project folder.
5. Run `ark test-case new <KEY>` with no `--run` from the run worktree `runs/<run>/workspace`, and from a subfolder of it. Record stdout, stderr, exit code, and list `test/cases/` there.
6. Run `ark test-case new <KEY> --run <run>` from the project folder. Record exit code and the path of the new file.

## Expected results

- When `ark test-case new <KEY>` runs without `--run` in the project folder, in `runs/`, in `runs/<run>/`, in `runs/<run>/results` or in a deeper folder, the system shall exit with code 1 and print nothing on stdout. The symlinked `ARK_HOME` does not change the result.
- When it refuses, the system shall print on stderr a message that names the project folder and contains `ark test-case new <KEY> --run <run>`.
- When the project folder has no `ark.yml` and no runs, the system shall still refuse with exit code 1 (the guard does not read `ark.yml`).
- When it refuses, the system shall create no `test/` folder in the project folder, no counter or lock file in its `.git`, and `git status --porcelain` there is empty.
- When `ark test-case new <KEY>` runs without `--run` in the run worktree or a subfolder of it, the system shall exit with code 0, print the new id alone on stdout, and create the file under that worktree's `test/cases/`.
- When `ark test-case new <KEY> --run <run>` runs from the project folder, the system shall exit with code 0 and write the file into the run worktree, not the project folder.

## Screenshot checkpoints

none: integration case on CLI output, exit code and files; no UI surface.
