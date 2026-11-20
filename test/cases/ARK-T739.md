---
id: ARK-T739
title: ARK-T739 ark.yml with a changed_command that lacks {base} or {report}, is empty or is not text is refused, and a misspelled changed_command key gets the did-you-mean hint
level: integration
technique: equivalence classes of the key (valid, no {base}, no {report}, empty, wrong type, misspelled) at the config reader
priority: medium
risk: a `changed_command` with no `{base}` is accepted, so a quick run runs a selection that ignores the run's base and the files that ran are meaningless; a `changed_command` with no `{report}` is accepted and the suite fails later with no report; a misspelled key (`changed_cmd`) is dropped without a hint and the suite silently runs in full; a non-text or empty value is accepted and fails later at run time
status: active
changed_by: 2026-11-20-ARK-580-1
---

## Objective

Prove that `loadConfig` (reached through `ark test <run>`) refuses a suite whose `changed_command` has no `{base}`, has no `{report}`, is empty or is not text, names the suite index and key as `base_command` is refused without `{files}` and `command` without `{report}`; that a misspelled key gets the existing "did you mean" hint; and that a valid `changed_command` loads. Serves ARK-580/AC1.

Authoring gate:

1. Protects: the `ark.yml` contract of the new key: required placeholders, value type, suite key list.
2. Fails when: the load of `cli/config.ts` skips the `{base}` check, the `{report}` check, the value type check, or the key is missing from `suiteKeys`.
3. Existing proof misses it: ARK-T120 and ARK-T388 load valid suites only; no case has a refusal of a suite key placeholder. This case is the only owner of the key's refusals. It adds no check of the quick run: ARK-T737 owns what a quick run does with `{base}` and `{report}`.
4. No test-only export, flag or hook: the case runs `ark` against an `ark.yml` file.

## Preconditions

- A temporary `ARK_HOME` and project, and the run is started (`ark run start`) with a valid `ark.yml` first. `ark run start` loads `ark.yml` too, so the bad `ark.yml` is written after the run exists; the first command that reads it is then `ark test`.
- One `ark.yml` per fixture, each with one suite with a valid `command` and a `changed_command` of:
  - `bun test --changed={base} --reporter=junit --reporter-outfile={report}` (valid),
  - `bun test --changed --reporter=junit --reporter-outfile={report}` (no `{base}`),
  - `bun test --changed={base}` (no `{report}`),
  - `""` (empty),
  - `["bun"]` (not text),
  - and a valid value under the key spelled `changed_cmd`.

## Steps

1. For each fixture, write its `ark.yml` over the valid one and run `ark test <run> --quick`. Read the exit code and stderr.

## Expected results

- Valid: `ark.yml` loads; stderr has no config refusal.
- No `{base}`: exit non-zero; stderr names the suite as `suites[<i>].changed_command` and says it must contain `{base}`; no suite runs.
- No `{report}`: exit non-zero; stderr names `suites[<i>].changed_command` and says it must write its JUnit report to `{report}`; no suite runs.
- Empty and not text: exit non-zero; stderr names `suites[<i>].changed_command` and the type it wants, as the other suite text keys do.
- Misspelled key: exit non-zero (unknown key); stderr names `changed_cmd` and suggests `changed_command`.
- A suite with no `changed_command` loads with no change from today (every other case of the repo owns that).

## Screenshot checkpoints

none: CLI case on a config file; no UI surface.
