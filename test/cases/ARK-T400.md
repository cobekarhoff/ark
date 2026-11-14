---
id: ARK-T400
title: ARK-T400 a git or ark command that stalls in test/worktree-submodule.test.ts fails the case at its own time limit, below the 60 s test timeout, with the command line, the limit and what the command printed
level: integration
technique: equivalence classes (stalled with stderr, stalled with no output, fails fast, succeeds) over the two spawn helpers (the file's `git`, the shared `ark`), observed through real child processes behind a PATH shim
priority: high
risk: "a hung `git add` or `ark test` is not killed, so the case runs into the 60 s test timeout and CI reports only `timed out after 60000ms` with no command and no stderr (as on PR #224: 5 cases, 5 minutes, empty `git add ... failed:`); or the limit is at or above the per-test budget so the test timeout still wins; or the limit is set on `git` only and an `ark test` stall is still unbounded; or the error of a killed silent child has an empty stderr and names neither command nor limit; or a fast non-zero exit loses its command line, exit code or stderr"
status: active
changed_by: 2026-11-14-ARK-470-1
---

## Objective

Prove that every command `test/worktree-submodule.test.ts` runs through the file's `git` helper or the shared `ark()` helper of `test/helpers.ts` has a time limit below the file's 60 s test timeout, and that a command that exceeds it fails the case with its command line, the limit and `shim-git-stderr-marker`.

The authoring gate: the contract is an observable failure message of the two helpers at the real process boundary (a child that does not exit). The existing cases ARK-T111 and ARK-T112 start only commands that finish, so they cannot show it. No export, flag or hook is needed for the proof: the case calls the helpers as the file calls them, and the stall is a program of the case's own on PATH. If the helpers get a limit parameter for speed, the case must still run the default limit at least once (steps 1 and 3), because the default is what the 60 s test timeout races.

Out of scope, owned elsewhere: ARK-T111 and ARK-T112 own "the file passes under the bounded helpers". The claim that the shared `ark()` limit kills no legitimate call of another test file is checked by the full `ark test` / `bun test` run in the validator step, not by this case. The case's tests live in `test/worktree-submodule.test.ts` and must never start that file or `bun test` (that would recurse, and a whole-suite run cannot finish inside the 60 s per-test budget).

## Preconditions

- Real `git` and real `bun` binaries. No mock of the helpers.
- A shim directory first on `PATH` (the `writeFakeCommand` pattern of ARK-T159 and ARK-T358), restored in `finally`. Each shim is made for one command name and replaces it for the case only:
  - `git` shim A: prints `shim-git-stderr-marker` to stderr, then `exec sleep 90`. The `exec` is required: a killed `sh` would leave a `sleep` that keeps the stderr pipe open, and `Bun.spawnSync` would wait for it.
  - `bun` shim B: prints nothing, then `exec sleep 90` (the `ark()` helper starts `bun cli/ark.ts`).
  - `git` shim C: prints `shim-fast-failure` to stderr and `exit 3`.
- A scratch directory as the repo argument of `git`. No ark project is needed: shim B stalls before `ark` runs.
- The sleep (90 s) is longer than the 60 s test timeout, so at the base commit (no limit) the case ends by the test timeout and fails; with the fix it ends at the limit.

## Steps

1. With shim A on PATH, call the file's `git(directory, "add", "--", "x.txt")` and catch the thrown error. Record the elapsed time.
2. With shim A removed and shim C on PATH, call the same helper and catch the error. The new message shape is the contract: command line with `-C`, exit code, stderr.
3. With shim B on PATH, call `ark("status")` as the file calls it (default limit) and record the elapsed time and the result or error. If `ark()` returns a result instead of throwing, read its `code` and `err`. (One `ark` stall is enough: every `ark` call goes through the one spawn in `helpers.ts`.)
4. With shim A on PATH, call `tempGitRepo({ "stalled-template.txt": "x\n" })` of `test/helpers.ts` (a file set no other test builds, so no cached template hides the stall) and catch the error. Record the elapsed time.
5. With the real PATH, call the helper `git(directory, "rev-parse", "--git-dir")` on a scratch repo and `ark("--help")`.

## Expected results

- Step 1: the helper shall throw before the 60 s test timeout (elapsed under 60 s, over 0 s). The message shall contain the command line (`git -C <directory> add -- x.txt`), the limit in seconds or milliseconds as the file defines it, and `shim-git-stderr-marker`.
- Step 2: the helper shall throw at once. The message shall contain the command line (`git -C <directory> add -- x.txt`), the exit code `3` and `shim-fast-failure`, and shall not mention a time limit.
- Step 3: the `ark()` call shall end before the 60 s test timeout, shall carry the command line (`ark status`) and the limit in its failure, and, with no output from the child, shall not leave the failure as an empty string: a killed child (exit code `null` from `Bun.spawnSync`) shall not be reported as a plain code 1 with empty `err`.
- Step 4: the call shall throw before the 60 s test timeout. The message shall contain `init -q -b main timed out after <limit> ms`, a limit below the 60 s test timeout, and `shim-git-stderr-marker`.
- Step 5: with nothing stalled, both helpers shall return the command's output unchanged (`git-dir` output of `.git`; `ark --help` text and code 0).
- Steps 1 and 3 run as separate tests, each under its own 60 s budget, so the two stalls never add up to one test; a limit at or above 60 s shall fail the case.

## Screenshot checkpoints

none: integration case on child processes and error text; no UI.
