---
id: ARK-T739
title: ARK-T739 ark.yml with a changed_command that lacks {base} is refused, a misspelled changed_command key gets the did-you-mean hint, and {report} is replaced
level: integration
technique: equivalence classes of the key (valid, no {base}, empty, wrong type, misspelled) at the config reader
priority: medium
risk: a `changed_command` with no `{base}` is accepted, so a quick run runs a selection that ignores the run's base and the files that ran are meaningless; a misspelled key (`changed_cmd`, `changed_command:` with the wrong case) is dropped without a hint and the suite silently runs in full; a non-text or empty value is accepted and fails later at run time; `{report}` stays literal in a quick run
status: active
changed_by: 2026-11-20-ARK-580-1
---

## Objective

Prove that `loadConfig` (reached through `ark test <run>` and any command that reads `ark.yml`) refuses a suite whose `changed_command` has no `{base}`, is empty or is not text, names the suite index and key as `base_command` is refused without `{files}`; that a misspelled key gets the existing "did you mean" hint; and that a valid `changed_command` loads with `{report}` replaced in a quick run. Serves ARK-580/AC1.

Authoring gate:

1. Protects: the `ark.yml` contract of the new key: required placeholder, value type, suite key list.
2. Fails when: the load of `cli/config.ts` skips the `{base}` check, the value type check, or the key is missing from `suiteKeys`.
3. Existing proof misses it: ARK-T120 and ARK-T388 load valid suites only; no case has a refusal of a suite key placeholder. This case is the only owner of the key's refusals and adds no check of the quick run (ARK-T737).
4. No test-only export, flag or hook: the case runs `ark` against an `ark.yml` file.

## Preconditions

- A temporary `ARK_HOME` and project whose `ark.yml` has one suite with `command`, and a fixture for each `changed_command` value: `bun test --changed={base}` (valid), `bun test --changed` (no `{base}`), `""` (empty), `["bun"]` (not text), and a separate `ark.yml` with the key spelled `changed_cmd`.
- For the valid value, a run in the fixture of `test/test-run.test.ts` where the command writes the `{report}` path it received to a file.

## Steps

1. For each fixture, run `ark test <run> --quick` (the first command that loads `ark.yml`). Read the exit code and stderr.
2. For the valid fixture, read the `{report}` path that the command received.

## Expected results

- Valid: loads; the command received a real report path, with no literal `{report}` or `{base}`.
- No `{base}`: exit non-zero; stderr names the suite as `suites[<i>].changed_command` and says it must contain `{base}`; no suite runs.
- Empty and not text: exit non-zero; stderr names `suites[<i>].changed_command` and the type it wants, as the other suite text keys do.
- Misspelled key: exit non-zero (unknown key); stderr names `changed_cmd` and suggests `changed_command`.
- A suite with no `changed_command` loads with no change from today (every other case of the repo owns that).

## Screenshot checkpoints

none: CLI case on a config file; no UI surface.
