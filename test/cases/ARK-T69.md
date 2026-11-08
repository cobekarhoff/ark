---
id: ARK-T69
title: ARK-T69 gather writes the ledger and probes the open MR; review records pass, fail and not_run and changes no file
level: integration
technique: state transition (no MR, open MR, probe failure) for gather; equivalence classes (pass, fail, missing tool) and boundary values (49, 50, 51 lines of output) for review
priority: high
risk: gather needs an Ark run or writes the ledger elsewhere, --existing-only prints a placeholder or exits 0 when the probe fails, review keeps the whole output or fewer than 50 lines, reports a missing tool as a failure or a pass, or edits the worktree
status: active
changed_by: 2026-11-07-ARK-317-1
---

## Objective

Prove `gather.ts` builds `ledger.json` from git and the host with no Ark run, `--run-dir` takes the Ark ledger, `--existing-only` prints the open MR or nothing and exits 2 when the probe fails; and `review.ts` runs the configured shell checks, records command, exit code and the last 50 lines, records `not_run` for a missing tool, and changes no file. Serves ARK-317/AC3.

Expected: When the open-MR probe fails, `gather.ts --existing-only` shall exit 2 and write no file.

## Preconditions

- A fixture git repo (not an Ark project, no `ark.yml`) on branch `fix-retry-429` with two commits ahead of `main`, a bare local `origin`, and a fake `glab` on `PATH` whose behaviour a variable switches: no open MR, one open MR (iid 412, draft, head SHA), or exit 1 with `401 Unauthorized`.
- A second fixture: an Ark run folder with a `ledger` built by ARK-316 (for `--run-dir`).
- A `.pr-writing.toml` with `checks` of three commands: one that exits 0, one that prints 120 lines then exits 1 (the last line is `line 120`), and one whose tool does not exist (`no-such-tool-xyz --version`).
- A variant check that prints exactly 49, 50 and 51 lines.
- Clean worktree; a snapshot of every file under the repo (tracked, untracked, ignored) with its hash, taken before `review.ts`.

## Steps

1. Run `gather.ts` in the fixture repo. Read `.pr-writing/ledger.json` and stdout.
2. Run `gather.ts --run-dir <run folder>`. Compare the ledger to the Ark ledger.
3. Run `gather.ts --existing-only` with an open MR; then with none; then with the probe failing. Capture exit code, stdout and `ls .pr-writing`.
4. Run `review.ts`. Capture exit code, stdout JSON and stderr.
5. Snapshot the repo again and diff it against the first snapshot. Check `git status --porcelain`.
6. Run `review.ts` with the 49-, 50- and 51-line checks. Read `output_tail` length.
7. Run `review.ts` with all three checks replaced by passing commands.
8. Run `bun test test/pr-writing-skill.test.ts`.

## Expected results

- Step 1: exit 0, `.pr-writing/ledger.json` exists, its head equals `git rev-parse HEAD`, base is `main`, it lists the two commits and the changed files, and stdout is one JSON document with `ledger`, `head`, `base`, `host`, `files`, `existing_mr`.
- Step 2: the ledger holds the Ark run data (tests, findings, evidence), not the git-only ledger.
- Step 3: with an open MR stdout is `{"iid":412,...,"draft":true,...}` and exit 0; with none stdout is empty, stderr says `no open MR`, exit 0; with the probe failing exit 2, stdout `{"error":"probe failed",...}`, and no ledger file is written or changed.
- Step 3 (normal gather with the probe failing, no `--existing-only`): exit 2, stdout one JSON object with `"error":"probe failed"` and no `existing_mr` key, stderr holds `401 Unauthorized`, and the ledger stays written. With no open MR a normal gather still exits 0 with `existing_mr` null.
- Step 4: exit 1, `ok: false`, three records in order: `pass` with `exit_code` 0; `fail` with `exit_code` 1 and an `output_tail` of exactly 50 lines ending `line 120`; `not_run` with `exit_code` null and a tail naming the missing tool. Each record holds the command string. The missing tool does not turn the exit 1 into 2.
- Step 4 variant (a `pass` and a `not_run`, no `fail`): exit 2 and `ok: false`.
- Step 5: the snapshot is identical (no file added, removed or changed, `git status --porcelain` is empty), including after the failing check.
- Step 6: tails hold 49, 50 and 50 lines.
- Step 7: exit 0 and `ok: true`.
- `bun test test/pr-writing-skill.test.ts` exits 0.

## Screenshot checkpoints

None. The surface is CLI output and JSON files; no screenshot applies.
