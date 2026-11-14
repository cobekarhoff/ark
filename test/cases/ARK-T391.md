---
id: ARK-T391
title: ARK-T391 a suite whose command has no {report} is refused at config load with a message that says the command must write its JUnit report to {report}
level: integration
technique: boundary values (command with `{report}`, without it), equivalence classes (first suite, second suite)
priority: high
risk: a suite command without `{report}` passes the load and the first `ark test` gives `base failed`, `suite failed` and `criterion passing` at once with no cause; or the check is put on `base_command`, or in a second place, so a valid config is refused or the error comes late
status: active
changed_by: 2026-11-13-ARK-332-1
---

## Objective

`loadConfig` refuses a suite whose `command` does not contain `{report}`, and the message names the suite and says the command must write its JUnit report to `{report}`.

## Preconditions

- A temp `ARK_HOME` with a project and a valid `ark.yml` whose suite `command` holds `{report}` (for example `bun test --reporter=junit --reporter-outfile={report}`).
- A second project whose first suite has `{report}` and whose second suite has none.

## Steps

1. Load the valid project.
2. Change the suite `command` to `bun test` (no `{report}`). Load it.
3. Load the second project.

## Expected results

- Step 1: the load succeeds.
- Step 2: the load throws an `ArkError` with the path of `ark.yml`, `suites[0]` (or the suite name) and the text that the command must write its JUnit report to `{report}`.
- Step 3: the load throws an `ArkError` that names the second suite, so every suite is checked and not the first only. That `base_command` needs no `{report}` is proved by ARK-T389.
- The `ark status` exit code and text for a `loadConfig` refusal belong to ARK-T390; this case does not repeat them.

## Screenshot checkpoints

none: no UI surface; the proof is the thrown error.
