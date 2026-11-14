---
id: ARK-T663
title: ARK-T663 project-autocommit.sh makes the project folder a git repository and commits a changed ticket, once per change, without a push, and its loop outlives a failed commit
level: integration
technique: state transition (no repo, clean repo, dirty repo, committed, index locked, lock released) and equivalence classes of paths (tracked project files, ignored directories) and of ARK_PROJECT (set, other project, missing folder, empty, unset)
priority: high
risk: the job runs git in a parent repository instead of the project folder and commits there; with ARK_PROJECT empty or unset it runs git init in `projects/` and commits every project into one repository; it commits runs/, services/, test-cache/, qe/, audit/ or prototypes/ (GBs, and its own log is a change every pass); it makes an empty commit every pass, or none after a change; it overwrites an existing .gitignore; a missing git identity, a signing key or a held index.lock stops the commit silently or deletes the lock; the loop exits on the first failed commit, so launchd restarts it and the failure is lost; it pushes to a remote; it writes into another project's folder or into the real ~/.ark
status: active
changed_by: 2026-11-14-ARK-482-1
---

## Objective

`scripts/project-autocommit.sh <workspace> <interval> [--once]`, run with `ARK_HOME` and `ARK_PROJECT`, turns `$ARK_HOME/projects/$ARK_PROJECT` into a git repository with a `.gitignore`, commits a changed ticket, `ROADMAP.md`, `ark.yml` or `learnings.md` with a message that names the autocommit job, makes no commit when nothing changed, and never pushes. `--once` runs one pass and exits (0 for a pass, 1 for a failed commit or a bad `ARK_PROJECT`). Without `--once`, as launchd runs it, the script loops every `<interval>` seconds, logs a failed commit to `services/project-autocommit.log`, does not exit, and commits on the next pass. This is the AC1 case: a ticket changes and its commit is found. The interval value that launchd passes (under 300 s) is owned by ARK-T294; this case shows that the loop honors the interval it gets.

## Preconditions

- A scratch `ARK_HOME` under a scratch directory that is itself a git repository (`tempGitRepo`, branch named with `--initial-branch=main`), so a script that asks `git rev-parse` instead of looking for `.git` in the project folder acts on the parent. A project `ark` with `tickets/ARK-1.md` (front matter `status: todo`), `ROADMAP.md`, `ark.yml` and `learnings.md`, and no `.git`.
- Ignored directories with a file each: `runs/`, `services/`, `test-cache/`, `qe/`, `audit/`, `prototypes/`.
- A second project `other` in the same `ARK_HOME` with its own ticket and no `.git`.
- `HOME` is a scratch directory with a global git config that has no `user.name` or `user.email`, sets `init.defaultBranch=main` and `push.autoSetupRemote=true`, and sets `commit.gpgsign=true` with a signing program that fails. launchd gives the job only `HOME`, `PATH`, `ARK_HOME`, `ARK_PROJECT` and `TMPDIR`.
- A bare repository set as `origin` after step 1, as the push target to test against. In step 6 the project branch also gets `branch.main.remote=origin` and `branch.main.merge=refs/heads/main`, so that `git push`, `git push origin` and `git push origin HEAD` each land a ref in it.
- Real `git`; no fake commands. The script's stdout and stderr are captured apart. The real `~/.ark` and the real LaunchAgents are never read or written: the case runs the script only, and the install of the plist is owned by ARK-T294.

## Steps

1. Run the script with `--once`. Record the exit code. List `git -C <project> log --format=%s%n%b --name-only`, `git ls-files`, and the content of `.gitignore`.
2. Run it with `--once` again with no change. Count the commits.
3. Change the ticket to `status: in_progress`. Run it with `--once`. Show the last commit with `git show --stat` and `git show` of the ticket.
4. Change `ROADMAP.md`, `ark.yml` and `learnings.md`, and write a new file in each ignored directory and a new line in `services/project-autocommit.log`. Run it with `--once`.
5. Replace `.gitignore` with a user version (an extra line `mine/`, no `audit/` line). Change the ticket. Run it with `--once`.
6. Add `origin` (the bare repository) and set the upstream of `main` as in the preconditions. Change the ticket again, as in step 3. Run the script with `--once`. List the refs of the bare repository.
7. Hold the lock: start a real process that creates `<project>/.git/index.lock` and sleeps. Change the ticket. Run the script with `--once` while it sleeps. Record the exit code, stdout, stderr, and check the lock file. End the process, remove its lock as its owner, run the script with `--once`.
8. The loop: start a real process that holds `<project>/.git/index.lock`. Change the ticket. Start the script without `--once` and with interval 1 in the background, its stdout and stderr appended to `services/project-autocommit.log`, as the plist does. Wait 4 seconds. Check the process is alive, read the log, count the commits, check the lock file. End the lock holder and remove its lock as its owner. Wait up to 10 seconds. Count the commits, check the process is alive. Wait 3 more seconds with no change. Count the commits. Change `learnings.md`, wait up to 10 seconds. Kill the loop.
9. Change the ticket again. Start two copies of the script with `--once` at the same moment. Wait for both. Count the new commits.
10. Run the script with `ARK_PROJECT=other`. List the log of `ark` and of `other`, and the log of the parent repository.
11. Run it with `ARK_PROJECT=missing` (no such folder).
12. Run it with `--once` and `ARK_PROJECT` set to the empty string, then with `--once` and `ARK_PROJECT` removed from the environment, then both again without `--once`. Look for `.git` under `$ARK_HOME/projects/` and in each project folder, and list the log of the parent repository.

## Expected results

- Step 1: exit code 0. `<project>/.git` exists, and the parent repository has no new commit and does not track the project. One commit. Its subject contains the word `autocommit`. It holds `tickets/ARK-1.md`, `ROADMAP.md`, `ark.yml`, `learnings.md` and `.gitignore`. `git ls-files` lists no path under `runs/`, `services/`, `test-cache/`, `qe/`, `audit/` or `prototypes/`. `.gitignore` has a line for each of the six. The commit succeeds with no `user.name`, no `user.email` and a failing signing program in the global config.
- Step 2: exit code 0, still one commit, `git status --porcelain` empty.
- Step 3: exactly one new commit whose changed files are only `tickets/ARK-1.md`; the ticket diff shows `status: todo` replaced by `status: in_progress`. Its subject names the autocommit job. A later `--once` makes no further commit.
- Step 4: one new commit with `ROADMAP.md`, `ark.yml` and `learnings.md` only. No ignored path is in it, and `git status --porcelain` is empty afterwards, so the log file is not a change.
- Step 5: the user `.gitignore` is byte-identical to what the user wrote (the script does not add its lines back); the ticket change is committed.
- Step 6: one new commit; the bare repository has no refs. With the upstream set, any push form would have landed a ref, so no push ran.
- Step 7: exit code 1 under `--once`. stderr holds the git error of the failed commit (it names `index.lock`), and stdout and stderr are not both empty. No new commit while the lock is held. The lock file is still there and still the process's own; the script does not delete it. After the owner removes the lock, the next `--once` exits 0 and commits the ticket change in one new commit.
- Step 8: after 4 seconds the loop process is alive, `services/project-autocommit.log` has a line that names the failed commit, no new commit exists, and the lock file is untouched. After the lock is released, the loop is still alive and, within 10 seconds, one new commit holds the ticket change (the loop honors interval 1 and commits on the next pass). Three seconds later, with no change, the commit count is the same, so there is no empty commit. The `learnings.md` change is committed within 10 seconds by the same process, with the same pid as before.
- Step 9: exactly one new commit for the change, no empty commit, no broken index, `git fsck` clean, and each copy exits 0 or 1 (a copy that finds the index locked by the other may fail its commit with 1; it never leaves a lock behind).
- Step 10: `other` has one commit with its ticket, `ark` has no new commit, the parent repository has no new commit.
- Step 11: exit code 1 and a message that names the missing folder; no folder `missing` is created under `projects/`.
- Step 12: each of the four runs exits 1 at once (the looping runs do not stay alive) with a message on stderr that names `ARK_PROJECT`. No `.git` appears under `$ARK_HOME/projects/`, and the parent repository has no new commit.

## Screenshot checkpoints

none: script and git output only, no UI.
