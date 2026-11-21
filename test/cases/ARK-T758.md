---
id: ARK-T758
title: ARK-T758 merge-request open accepts a passing quick ark test for a run whose own diff is a hand edit outside the generated block of a generated Markdown file, when a passing check of that quick test runs the file's generated command in the same repo
level: integration
technique: equivalence classes of an eligible generated Markdown edit (one repo; two repos with the edit and its check in the second repo), each reaching the final stage through merge-request check and open
priority: high
risk: "the `generated.has(path)` exclusion of `noCodeRun` stays, so a one-line docs edit of `docs/reference/cli.md` still needs the full suite; or the check that proves the file is looked up in the wrong place (by check name equal to the path, by the first repo only, or only in a check whose repo is `.`), so a project whose generated file lives in a second repo never takes the quick path; or the accepted run still refuses on `criteria not passing` or `test evidence missing`, or the body lacks `Full suite: CI (no code file in this diff)`"
status: active
changed_by: 2026-11-21-ARK-625-1
---

## Objective

Prove that `ark merge-request check <run> --stage final` passes and `ark merge-request open <run>` opens the MR on the quick-test path when the run's own diff changes only a Markdown file listed under `generated` in `ark.yml`, by a hand edit outside its generated block, and the last `test.completed` at the head is a passing quick run in which a check whose command contains that entry's `generated` command passed in the repo of the file. The MR body says `Full suite: CI (no code file in this diff)`. Serves ARK-625/AC1.

Authoring gate:

1. Protects: the accepted edge of the new rule of `noCodeRun` (cli/merge-request.ts), reached through `checkStage` stage `final`: a generated `.md` path counts as no-code when the last quick test holds a passed check, of the same repo, whose command contains the path's `generated` command.
2. Fails when: the exclusion of every `generated` path stays; the link between the `generated` entry and the check is made by name, by an exact command match (the check command is the generated command plus `&& git diff --exit-code ...`), or against the checks of repo `.` only; or the quick path refuses on another rule for this diff.
3. Existing proof misses it: ARK-T748 opens on hand-written Markdown that is not in `generated`; ARK-T750 row 5 refused every edit of the generated file, which this case turns into an accepted head. This case owns the accepted head of a generated Markdown edit; ARK-T750 rows 5, 17, 18 and 19 are its negative table and start from this head; ARK-T759 owns the out-of-sync file.
4. No test-only export, flag or hook: the real `ark` process, a real `ark test <run> --quick` that runs the fixture check, and the fake forge of `test/fixtures/merge-request`. The fixture extends the `noCodeRun()` helper of the `ark merge-request open on a quick test of a run with no code file` describe in `test/test-selection.test.ts` with options (the `generated` list, the checks, the base files of each repo, the own commit); it does not copy its setup.

## Preconditions

- The `noCodeRun()` fixture of ARK-T748 fixture A (feature run, plan `test_cases` one `reuse` entry for `FAKE-T1`, a passing `FAKE-T1` test at base, the suite has `base_files`), with these changes.
- The base of the repo holds `scripts/gen-ref.sh`, a generator that rewrites only the lines between `<!-- generated:start -->` and `<!-- generated:end -->` of `docs/reference/cli.md` with the line `generated line`, and `docs/reference/cli.md` in sync with it: `# CLI`, a blank line, `hand line`, the start marker, `generated line`, the end marker.
- `ark.yml` lists `generated: [{ path: docs/reference/cli.md, command: sh scripts/gen-ref.sh }]` and one check `cli-reference` of repo `.` with the command `sh scripts/gen-ref.sh && git diff --exit-code docs/reference/cli.md` (the shape of this repo's own `cli-reference` check).
- The run's only own commit changes `hand line` to `hand line, edited` in `docs/reference/cli.md`. The default own Markdown commit of the helper (`docs/guide.md`, `skills/demo/SKILL.md`) is not made, so the generated file is the only changed file.
- Fixture B: the two-repo workspace of ARK-T748 fixture F (repos `core` and `site`, a run worktree in each). `site` holds the generator and the file of the bullets above at base, the only own commit is the same hand edit in `site`, and the `cli-reference` check has repo `site`. `core` has no own commit.

## Steps

1. Fixture A: run `ark test <run> --quick`. Read the exit code, stdout and the last `test.completed`.
2. Run `ark merge-request check <run> --stage final`. Read the exit code and the output.
3. Run `ark merge-request open <run>`. Read the exit code, stderr, the `merge_request.opened` events, the remote refs and the body of the recorded `gh pr create` call.
4. Fixture B: repeat steps 1 to 3.

## Expected results

- Step 1: exit 0. `test.completed` has `mode: "quick"`, `passed: true`, a `checks` entry `{ name: "cli-reference", passed: true }` and `FAKE-1/AC1` `not run`.
- Step 2: exit 0; empty output (no problem line).
- Step 3: exit 0; one `merge_request.opened` event; an `ark/` branch on the origin; one `gh pr create` call whose body holds the line `Full suite: CI (no code file in this diff)` exactly once and no line that starts `- Tests: ` with a passed count. stderr holds none of `quick, not a gate`, `criteria not passing`, `test evidence missing`.
- Step 4: as steps 1 to 3, with the `cli-reference` check of repo `site`.

## Screenshot checkpoints

none: CLI, event-log and MR-body text case; no UI surface.
