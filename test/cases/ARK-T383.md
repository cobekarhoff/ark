---
id: ARK-T383
title: "ARK-T383 a manual answer records the head of each repo and stage final warns when a head differs, without changing the exit code, and not after a clean sync"
level: integration
technique: state transition (answered at H, commit, clean sync, old event without heads) checked against the exit code of stage final
priority: medium
risk: "an answer given before a later commit is shipped as current human approval (D13, 4 runs) with no sign; or the warning shows on every run because a clean ark worktree sync after the answer counts as a change; or the warning changes the exit code or refuses open; or an old log with no heads warns"
status: active
changed_by: 2026-11-13-ARK-405-1
---

## Objective

Prove `gate.answered` for a manual criterion carries the head of each repo at the answer, and `ark merge-request check <run> --stage final` prints `warning: manual answer older than head: <AC id>` when a repo head differs from the recorded one, while the exit code and `ark merge-request open` are unchanged.

## Preconditions

- Fixture rule (order matters; ARK-405 review 4): `ark run start` fixes the run's criteria (`cli/run.ts:99`, `cli/events.ts:190`), and `ark gate record <run> manual AC2 ok` refuses an AC that is not in that list (`cli/gate.ts:68-69`: `criterion FAKE-1/AC2 is not in the ticket`). A second `ark plan check` after an edit of `plan.yml` clears the approval and sends the phase back to `planning` (`cli/events.ts:230`, `:366`), and open then refuses with `cannot open merge requests while the run is in phase planning` (`cli/merge-request.ts:437-439`), which would break step 3. So the ACs and the plan are written BEFORE `ark run start` and its `plan check`: `syncedRun` of `test/sync-base.test.ts` gets new options for them (for example `criteria` and `plan`) and writes them where it now writes its one-AC ticket and its plan. After `syncedRun` returns the test never edits `plan.yml` or the criteria, and never runs a second `plan check`; the evidence file, commits, gate answers and appended events are fine after the return.
- Fixture: `syncedRun("feature", { verified: true, criteria, plan })` of `test/sync-base.test.ts` with the fake host of `test/fixtures/merge-request` first on `PATH` (`useFakeHost()` of `test/sync-base.test.ts:264`), one repo. The options give the ticket one string-free `AC1` (`FAKE-1-AC1`, `verified_by: [FAKE-T1]`) and one manual `demonstration` AC `FAKE-1-AC2` (read as `FAKE-1/AC2`), a `summary.changes` row for each, and the step `build` serving both. After the return the test writes a well-formed `results/evidence/AC2.md` in the run folder (the four sections, a screenshot path under `Before` and `After`, no `human: ok` line). `AC1` is satisfied (`FAKE-T1` passing), so stage `final` has no problem at the answered head once `AC2` is answered and `ark test` ran.
- Every fixture of the steps is its own `syncedRun` call (steps 1-3 one, step 4 one, step 5 two, step 6 one). Each call runs `tempArkHome`, which resets `process.env.ARK_HOME` (`test/helpers.ts:19-23`): before each `ark` command the test sets `ARK_HOME` back to the `ARK_HOME` of the fixture it works on (step 5 compares two fixtures, so it switches between them).
- Order in each fixture: answer `AC2` first, then run `ark test <run>` (exit 0, because `AC2` reads `manual ok`; before the answer `ark test` exits 1 with `FAKE-1/AC2 is manual pending`, the existing behaviour). A commit after the answer moves the head, and a repeated `ark test` follows it so that the test head is current.
- The test reads heads with `git -C <worktree> rev-parse HEAD`, never from code under test. `moveTarget` and `ark worktree sync` as in ARK-T373.

## Steps

1. Record H. Run `ark gate record <run> manual AC2 ok`, then `ark test <run>`. Read the `gate.answered` event: its `heads` map (the shape of `heads` in `test.completed`) holds the repo with value H (every repo of the run, one here). Run `--stage final`: exit 0, no `warning:` line.
2. Add a commit in the worktree (head H2), run `ark test <run>` again so the test head is current, run `ark merge-request check <run> --stage final`. Assert exactly one `warning:` line, `warning: manual answer older than head: FAKE-1/AC2` (the AC by the canonical id of `gate.answered` `criterion`, the form open uses in `manual criterion without ok: FAKE-1/AC2`), and exit 0 (the exit code the same as step 1). Run `--stage head` and `--stage step`: no warning.
3. Run `ark merge-request open <run>` in that state. Assert it exits 0, and the output holds no `warning:` line.
4. Fresh fixture: answer at H, `ark test`, `moveTarget`, `ark worktree sync` (clean merge; the head is a merge commit, `HEAD^1` is H). Do not run `ark test` again. Run `--stage final`. Assert no warning (clean sync tolerance as in ARK-T373; the sync is the only head change, so the stale-head refusal does not apply either).
5. Fresh fixture with a problem: answer at H, `ark test`, then a commit (head H2) and `ark test` again; the problem is a title over 72 characters through `--summary`. Assert the output holds the title problem line and the warning line, and the exit code is 1 and the same as the run with the problem and no commit after the answer (a second fresh fixture).
6. Old log: fresh fixture where `AC2` is answered not with the command but with `appendEvent(..., "gate.answered", { gate: "manual", criterion: "FAKE-1/AC2", answer: "ok", by: "human" })` (no `heads` key; the test also appends the line `human: ok` to `AC2.md`). Add a commit (so the head differs from any head that could have been recorded), run `ark test <run>`, then `--stage final`. Assert no warning line for `FAKE-1/AC2`.

## Expected results

- When a manual criterion is answered, the system shall record the head of each repo in `gate.answered`.
- When a repo head differs from the recorded head, `--stage final` shall print `warning: manual answer older than head: <AC id>` and shall not change its exit code.
- While the head moved from the answered head only by clean sync merges, the system shall print no warning.
- Where an answer has no recorded heads, the system shall print no warning.
- `ark merge-request open` shall neither print nor refuse on the warning.

## Screenshot checkpoints

none: integration case on CLI output, events and git state; no UI surface.
