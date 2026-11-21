---
id: ARK-T759
title: ARK-T759 a run whose own edit makes a generated Markdown file differ from its generated command fails ark test --quick on the generated check, and merge-request open refuses it and pushes nothing
level: integration
technique: equivalence classes of a generated Markdown edit (inside the generated block, against ARK-T758's edit outside it), state transition (quick test failed, then check and open)
priority: high
risk: "a quick test of a Markdown-only diff skips the checks of `ark.yml`, so it exits 0 on an out-of-sync `docs/reference/cli.md`, or runs them in the base checkout and not in the run worktree, so the check is recorded passed and the open pushes the stale file on the quick-test path; or the new rule accepts a generated `.md` because a matching check exists in `ark.yml` without reading its `passed` in the last test, so `noCodeRun` reads the stale file as no-code and the first refusal of `open` becomes the `did not pass` line instead of the quick line (a later rule still refuses, so the rule's own check is gone unseen)"
status: active
changed_by: 2026-11-21-ARK-625-1
---

## Objective

Prove that a run whose own commit changes the generated block of a Markdown file listed under `generated`, so that the file differs from what the `generated` command writes, fails `ark test <run> --quick` on the check that runs that command, and that `ark merge-request open <run>` refuses it as today. Serves ARK-625/AC2.

Authoring gate:

1. Protects: the safety claim of the new rule: the quick test proves a generated Markdown file in sync, so a file that is not in sync never reaches the quick-test path of `ark merge-request open`.
2. Fails when: `ark test --quick` skips the checks for a diff with no code file or records them as passed; the check runs outside the run worktree (the regenerated file equals the base); or `noCodeRun` accepts the generated path on the presence of a matching check in `ark.yml` and not on the passed check of the last test (the first refusal line is then the `did not pass` line and not the quick line).
3. Existing proof misses it: ARK-T758 owns the accepted head with the file in sync; ARK-T750 row 11 fails a check (`false`) that proves no generated file, so it says nothing about the generated check catching a stale file. This case is ARK-T758 fixture A with one change: the edit is inside the generated block.
4. No test-only export, flag or hook: the real `ark` process, a real `ark test <run> --quick` that runs the fixture's `cli-reference` check (`sh scripts/gen-ref.sh && git diff --exit-code docs/reference/cli.md`), and the fake forge.

## Preconditions

- ARK-T758 fixture A, except that the only own commit changes `generated line` to `generated line, edited` inside the generated block of `docs/reference/cli.md`. Running the generator rewrites that line back, so `git diff --exit-code docs/reference/cli.md` in the run worktree exits 1 after it.

## Steps

1. Run `ark test <run> --quick`. Read the exit code, stdout, stderr and the last `test.completed`.
2. Run `ark merge-request check <run> --stage final`. Read the exit code and the output.
3. Run `ark merge-request open <run>`. Read the exit code, stderr, the `merge_request.opened` events, the remote refs (`git ls-remote origin`) and the recorded `gh` calls.

## Expected results

- Step 1: exit 1. stdout holds `check cli-reference failed`; stderr holds `check cli-reference failed` in the `tests did not prove every criterion` line. `test.completed` has `mode: "quick"`, `passed: false`, a `checks` entry `{ name: "cli-reference", passed: false }` and `suites: []` (a failed check stops the run).
- Step 2: exit 1. The output holds the quick line ``the last test at this head is quick, not a gate: run `ark test <run>` `` and the line ``the last test run did not pass: fix the failures and run `ark test` again``.
- Step 3: exit 1. The first line of stderr is `ark: ` and then the quick line of step 2, the refusal of this edit before the change (the generated path is not accepted because its check did not pass). No `merge_request.opened` event, no `ark/` branch on the origin and no `gh pr create` call.

## Screenshot checkpoints

none: CLI, event-log and git-ref case; no UI surface.
