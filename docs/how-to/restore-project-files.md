# Restore a project file from git

The project folder `~/.ark/projects/<project>` holds your tickets, `ROADMAP.md`, `ark.yml` and `learnings.md`. When the `project-autocommit` service runs, the folder is its own git repository and the service commits every change in it. A file that a script or an agent emptied or overwrote is then in the history, and you restore it from there. `ARK_HOME` moves the `~/.ark` part.

## Start the job

The service is not installed by default. Run this once for each project:

```sh
ark services install --project <project>
```

Within 120 seconds the first pass runs `git init` in the project folder and makes the first commit. Check it:

```sh
git -C ~/.ark/projects/<project> log --oneline
```

Each commit has the message `autocommit: <count> changed files` and the author `Ark autocommit`. [Run Ark's background services](background-services.md) describes the other three services.

## What is in the repository

- **Tracked:** everything in the project folder except the ignored paths below. That includes `tickets/`, `ROADMAP.md`, `ark.yml`, `learnings.md` and files such as `ark.yml.bak`.
- **Ignored:** `runs/`, `services/`, `test-cache/`, `qe/`, `audit/` and `prototypes/`. They hold large or machine-written files, and the service log is in `services/`. This repository cannot restore anything in them.
- The service writes `.gitignore` only when the folder has none. Edit your own `.gitignore` to ignore more; the service never changes it.

## Read the history of a file

```sh
git -C ~/.ark/projects/<project> log --oneline -- ROADMAP.md
git -C ~/.ark/projects/<project> log -p -- ROADMAP.md
git -C ~/.ark/projects/<project> show <revision>:ROADMAP.md
```

`log --oneline -- <file>` lists the commits that changed the file. `log -p` adds each diff. `show <revision>:<file>` prints the file as it was in that commit.

## Restore a file

The service commits within two minutes, so the newest commit of a file can already hold the emptied version. Find the last good commit with `log --oneline -- <file>`, check it with `show <revision>:<file>`, then:

```sh
git -C ~/.ark/projects/<project> restore --source=<revision> -- ROADMAP.md
```

`git -C ~/.ark/projects/<project> checkout <revision> -- ROADMAP.md` does the same. The restored file is a change like any other: the next pass commits it.

Right after a bad write, before the next pass, `git -C ~/.ark/projects/<project> restore ROADMAP.md` is enough: it takes the file from the last commit.

## Check that commits run

Compare two dates. The first is the last line of `~/.ark/projects/<project>/services/project-autocommit.log`. The second is the date of the last commit, from `git log -1`:

```sh
tail -n 1 ~/.ark/projects/<project>/services/project-autocommit.log
git -C ~/.ark/projects/<project> log -1 --format=%cd
```

A pass that made a commit writes `autocommit committed at <date> in <folder>`. A pass that failed writes `autocommit failed at <date> in <folder>, will retry on the next pass`. A pass with no change writes nothing. The last line of the log should be about as new as the last commit.

If the log shows `autocommit failed` every two minutes and the last commit is old, a stale `.git/index.lock` is the usual cause. A git process that died left that file, and git never clears it. The service never removes it either. Check that no git process runs in the folder:

```sh
ps aux | grep '[g]it'
lsof ~/.ark/projects/<project>/.git/index.lock
```

If both show nothing for this folder, remove the lock:

```sh
rm ~/.ark/projects/<project>/.git/index.lock
```

The next pass, within 120 seconds, makes the commit and logs a new dated line.

## Limits

- Nothing from before the first commit can be restored. A file that was lost before `ark services install` ran is not in the history.
- Two changes between two passes make one commit, and a change that is undone between two passes is not recorded.
- The repository has no remote, and the service never pushes. A copy of the folder is a backup only if you make one.
- `ark services uninstall` stops the commits and leaves the repository and its history in place.
- When your own `.gitignore` has no `services/` line, the log is a tracked file. Each `autocommit committed` line then changes it, so the next pass commits again. Add `services/` to your `.gitignore` to stop that.
