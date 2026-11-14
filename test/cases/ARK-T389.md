---
id: ARK-T389
title: ARK-T389 loadConfig refuses an unknown key at the top level, in a role name, in a role, in a suite, in a repo entry, in a check and in pr_writing, and names the file, the key and the nearest valid key
level: integration
technique: equivalence classes (one class for each level of ark.yml), boundary of the nearest-key match (one edit away, no near match), error guessing (the two typos that passed before)
priority: high
risk: a typo in ark.yml passes the config check with no word, so `merge_request: none` leaves the default `open` and the first run pushes branches and opens MRs of a project that must stay local; or the check covers the top level only and a typo in a role, a suite, a repo entry, a check or pr_writing still passes; or the error gives a wrong guess for a key with no near match
status: active
changed_by: 2026-11-13-ARK-332-1
---

## Objective

`loadConfig` refuses a key it does not know at each level of `ark.yml`, as it does for `gates`. The error names the file, the key and, when one exists, the nearest valid key.

## Preconditions

- A temp `ARK_HOME` with a project whose `ark.yml` is valid (as `validConfig()` in `test/run.test.ts`), so a single added typo is the only fault.
- Each level below is a separate project file, one typo at a time.

## Steps

1. Load the valid config. Then load a copy with each one change, one case for each row. In every row the typo key is ADDED BESIDE the valid key; the valid key stays (so a required key is never missing, and only the unknown key is the fault):
   - top level: `merge_request: none` (beside `merge_requests`); and `concurency: 1` (beside `concurrency`)
   - role name: `roles.reviewr` (beside `roles.reviewer`)
   - role name: `roles.test_writr` (beside `roles.test_writer`)
   - key in a role: `roles.evaluator.modle` (beside `roles.evaluator.model`)
   - suite: `suites[0].comand` (beside `suites[0].command`)
   - repo entry: `repos."repos/a".bse` (beside `repos."repos/a".base`)
   - check: `checks[0].comand` (beside `checks[0].command`)
   - pr_writing: `pr_writing.reviwers` (beside `pr_writing.reviewers`)
2. Load a copy with a top-level key that is near to no valid key (`zzzzzz: 1`).
3. Load a copy with a valid key and no typo at each level (all known keys of the reference: top-level, each role, each suite key, each check key `name`, `repo`, `command`, `cores`, `repos.<path>.base` and each `pr_writing` key `reviewers`, `tier_floor`, `sensitive_paths`, `one_way_paths`, `agent_authored`, `title_prefix`).

## Expected results

- Step 1: every load throws an `ArkError` whose message starts with the full path of the project's `ark.yml` (as the other config errors do) and holds the typo key and the nearest valid key: `merge_request` ... `merge_requests`, `concurency` ... `concurrency`, `reviewr` ... `reviewer`, `test_writr` ... `test_writer`, `modle` ... `model`, `comand` ... `command`, `bse` ... `base`, `comand` ... `command` (check), `reviwers` ... `reviewers`. The message for a suite or a repo entry names which one (`suites[0]`, `repos.repos/a`, `checks[0]`, `pr_writing`).
- Step 2: the load throws and names the key; it makes no wrong suggestion (no `did you mean`, or a list of the valid keys).
- Step 3: the load succeeds with each field as written (no valid key is refused).

## Screenshot checkpoints

none: no UI surface; the proof is the thrown error.
