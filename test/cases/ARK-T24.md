---
id: ARK-T24
title: ARK-T24 hub reads local test cases and zephyr evidence without a Zephyr call
level: integration
technique: equivalence classes of source (local / zephyr) times case state (active / retired / missing); boundary of version field present and absent
priority: high
risk: "a retired case shows without its reason, a missing id shows as an empty row, a zephyr project reads case files or calls Zephyr, or a version is invented when result.json has none"
status: active
changed_by: 2026-11-06-ARK-314-1
---

## Objective

Prove the hub's on-request test case read for a ticket sends the full record of a local case, the recorded evidence of a zephyr case, and `missing` for an id with no case file, and makes no request to Zephyr.

## Preconditions

- Hub started on fixtures from `test/hub-fixtures.ts`, read through its HTTP test-case route (the route the ticket page calls), not through an internal function.
- Local project (`test_case_source: local`), ticket ARK-900 with `verified_by`: AC1 `[ARK-T1, ARK-T2, ARK-T99]`.
  - `ARK-T1` active: title `ARK-T1 first case`, level `integration`, technique `boundary values`, priority `high`, risk `the first defect`, `changed_by: 2026-01-01-ARK-1-1`; committed twice in the fixture git repo (two commits with different `changed_by`), so it has two versions.
  - `ARK-T2` retired: `status: retired` with the reason line `replaced by ARK-T1`, one commit.
  - `ARK-T99`: no case file.
- Zephyr project (`test_case_source: zephyr`), same ticket ids, no case files in the repo. The run's `results/evidence/ARK-T1/head/result.json` holds `{id: ARK-T1, name: "ARK-T1 first case", status: pass, sha: 9b85039, version: 3}`; `results/evidence/ARK-T2/head/result.json` holds the same fields without `version`; `ARK-T99` has no evidence folder.
- A stub HTTP server on a free port stands in for Zephyr; the zephyr project's config points at it and it records every request. It must record none.

## Steps

1. Request the test cases of ticket ARK-900 from the local project. Assert the response order follows `verified_by`.
2. Assert `ARK-T1` carries id, title, level, technique, priority, risk, status `active`, `changed_by` and a `versions` list of length 2 in newest-first order, each with its `changed_by`.
3. Assert `ARK-T2` carries status `retired` and the reason `replaced by ARK-T1`.
4. Assert `ARK-T99` is `{id: ARK-T99, missing: true}` with no other field, and that the ticket page JSON never holds an empty record for it.
5. Request the same ticket from the zephyr project. Assert `ARK-T1` carries id, name `ARK-T1 first case`, status `pass`, sha `9b85039` and version 3.
6. Assert `ARK-T2` carries id, name, status and sha and has no `version` key (a version is shown only when the file has one).
7. Assert `ARK-T99` reads `missing` in the zephyr project too.
8. Assert the Zephyr stub recorded zero requests across steps 5 to 7, and that the route answers 200 with the stub stopped.

## Expected results

- Where `test_case_source` is `local`, the system shall send id, title, level, technique, priority, `risk`, status (with the reason of a retired case), `changed_by` and the list of versions of each case that the ticket names.
- Where `test_case_source` is `zephyr`, the system shall send the id, name, status and sha that `result.json` records, and a version only when the file has a `version` field.
- The system shall make no request to Zephyr.
- If a `verified_by` id has no case file, then the system shall send the word `missing` for it, never an empty row.

## Screenshot checkpoints

none: integration case on a JSON read; the page rendering of `missing` is proven in ARK-T18.
