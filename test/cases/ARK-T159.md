---
id: ARK-T159
title: ARK-T159 tempGitRepo gives each call an independent, faithful repo from one template per file set and starts no git process after the first build
level: integration
technique: equivalence classes (same file set, different file set), state transition (first call builds, later calls copy), process counting through a git shim
priority: high
risk: "the template is handed out itself or shared by link, so a commit in one test repo leaks into another; or a second call with the same files still starts git; or a different file set reuses a template with the wrong files; or the copy loses .git, config or symlinks so tests on it fail"
status: active
changed_by: 2026-11-09-ARK-398-1
---

## Objective

Prove that `tempGitRepo` in `test/helpers.ts` builds a repo once for each distinct set of files in a process and copies it for each call, and that the copies are independent and complete.

Expected: When `tempGitRepo` is called again with the same files, the system shall copy the built repo and start no git process; each call shall return a separate working repo.

## Preconditions

- A file set no other test in the process uses (unique file content), so the first call here builds the template.
- A git shim on PATH (`writeFakeCommand`) that appends each call to a log file and runs the real git. The test restores PATH afterward.

## Steps

1. Call `tempGitRepo(files)` once with the shim on PATH. Record the shim log length (the build may start git).
2. Call `tempGitRepo(files)` a second time. Assert the shim log length did not change.
3. Assert the two paths differ, and each has `.git`, the files given, a clean `git status` and the same `HEAD` (read with the real git, after the shim count is taken).
4. Commit a file in repo A. Assert repo B's `HEAD` is unchanged and the commit is absent from repo B (`git cat-file -e` fails there).
5. Rename repo A with `renameSync` and assert repo B still works (a template is never handed out).
6. Call `tempGitRepo(otherFiles)` with a different file set. Assert it has `otherFiles`, not `files`, and that the shim log grew (a new build).

## Expected results

- Step 2: zero new git processes.
- Step 3: two distinct, complete repos with the same head.
- Step 4: the commit exists only in repo A.
- Step 5: repo B is intact.
- Step 6: a different file set gives a different repo with its own files.

## Screenshot checkpoints

none: a helper with no visual surface.
