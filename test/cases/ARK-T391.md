---
id: ARK-T391
title: ARK-T391 a suite whose command has no {report} is refused at config load with a message that says the command must write its JUnit report to {report}
level: integration
technique: boundary values (command with `{report}`, without it, with it only in `base_command`), equivalence classes (head suite, suite with a base side)
priority: high
risk: a suite command without `{report}` passes the load and the first `ark test` gives `base failed`, `suite failed` and `criterion passing` at once with no cause; or the check is put on `base_command`, or in a second place, so a valid config is refused or the error comes late
status: active
changed_by: 2026-11-13-ARK-332-1
---

## Objective

`loadConfig` refuses a suite whose `command` does not contain `{report}`, and the message names the suite and says the command must write its JUnit report to `{report}`.

## Preconditions

- A temp `ARK_HOME` with a project and a valid `ark.yml` whose suite `command` holds `{report}` (for example `bun test --reporter=junit --reporter-outfile={report}`).
- A second project whose suite has `base_files` and a `base_command` that holds `{files}` and no `{report}`, and a `command` with `{report}`.

## Steps

1. Load the valid project.
2. Change the suite `command` to `bun test` (no `{report}`). Load it.
3. Load the second project (a `base_command` without `{report}`, a `command` with it).

## Expected results

- Step 1: the load succeeds.
- Step 2: the load throws an `ArkError` with the path of `ark.yml`, `suites[0]` (or the suite name) and the text that the command must write its JUnit report to `{report}`.
- Step 3: the load succeeds: the check is on `command` only (the reference's `base_command` contract is out of this check; a check on it would refuse the valid fixtures of the test-audit tests).
- The `ark status` exit code and text for a `loadConfig` refusal belong to ARK-T390; this case does not repeat them.

## Screenshot checkpoints

none: no UI surface; the proof is the thrown error.
