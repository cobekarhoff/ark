---
id: ARK-T672
title: ARK-T672 finishing an implementer step succeeds when every case id in the run's touched tests is listed in the plan test_cases, and when the diff touches no case id
level: integration
technique: equivalence classes (all ids listed, no id in the diff, case id only in a non-test file) as the pass side of ARK-T671; boundary values (one listed id vs none, a listed id the diff does not touch)
priority: high
risk: "the finish check refuses a plan that lists every touched id, so every implementer step is blocked; the check filters on the action and refuses reuse, update or retire; a changed test with no case id is refused; a case id written in a non-test file (a README or doc) is read as a touched test id and refused; an id that the plan lists but the diff does not touch is refused"
status: active
changed_by: 2026-11-14-ARK-496-1
---

## Objective

Prove that implementer finish passes the plan membership check when the plan lists every touched case id, for each action, when the diff holds no case id, and when a case id appears only in a non-test file. Serves ARK-496/AC1.

Expected: When every case id in a test the run's diff changes appears in `test_cases` of `plan.yml`, whatever its action (add, update, reuse, retire), or when no changed test holds a case id (a case id in a non-test file does not count), the command shall exit 0 and append `step.finished` with the outcome `finished`.

## Preconditions

- The fixture and run of ARK-T671 (base test file with `ARK-T1`, `ARK-T2`, `ARK-T3`, `ARK-T9` tests, a started implementer step).
- Variant A: `test_cases` lists `ARK-T1` as `update`, `ARK-T2` as `reuse` and `ARK-T3` as `retire`; the step's commit edits those three tests. `ARK-T4` as `add` is a new test in the same diff. `ARK-T9` is also listed as `reuse`; the diff does not touch its test.
- Variant B: the step's commit edits a test whose title has no case id, and the plan lists no `test_cases`.
- Variant C: the step's commit edits only `README.md`, adding the text `see ARK-T2`; `test_cases` lists only `ARK-T1`.

## Steps

1. Variant A: run `ark run step <run> <step> finish`; read exit code and events.
2. Reset to a fresh started step for variant B and run `finish` again.
3. Reset again for variant C and run `finish`.

## Expected results

- Step 1: exit 0, no `case id not in plan test_cases` line, one `step.finished` event. All four actions pass, and the untouched listed `ARK-T9` causes no refusal.
- Step 2: exit 0 and one `step.finished` event; the output has no refusal for the id-less test.
- Step 3: exit 0 and one `step.finished` event; `ARK-T2` in `README.md` is not named.

## Screenshot checkpoints

none: CLI output, exit code and the event log; no UI.
