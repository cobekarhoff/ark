---
id: ARK-T24
title: ARK-T24 hub reads local test cases and zephyr evidence without a Zephyr call
level: integration
technique: equivalence classes of source (local / zephyr) times case state (active / retired / missing) times checkout (run checkout / configured workspace); boundary of version field present and absent
priority: high
risk: "an unmerged or changed case of a run reads missing or with stale main data, a retired case shows without its reason, a missing id shows as an empty row, a zephyr project reads case files or calls Zephyr, or a version is invented when result.json has none"
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
- Local project `run` with ticket ARK-900, AC1 `verified_by: [ARK-T1, ARK-T4, ARK-T5]` and a run of ARK-900 whose checkout `<run folder>/workspace` is a git repo:
  - Configured workspace (main): `ARK-T1` titled `ARK-T1 main title` (`changed_by: main-1`, one commit) and `ARK-T5` titled `ARK-T5 only in main` (`changed_by: main-only`).
  - Run checkout: `ARK-T1` with two commits, the second changing the title to `ARK-T1 changed in the run` and `changed_by` to `2026-11-06-ARK-900-1`; `ARK-T4` titled `ARK-T4 added in the run`, one commit, not in main. `ARK-T5` is not in the checkout.
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
9. Request the test cases of ARK-900 from project `run`. Assert the order `ARK-T1`, `ARK-T4`, `ARK-T5`.
10. Assert `ARK-T1` carries the run's title and `changed_by` (not main's), and a `versions` list that follows the run checkout: newest `2026-11-06-ARK-900-1`, then `2026-02-02-ARK-2-1`.
11. Assert `ARK-T4` (unmerged, absent in main) is not `missing`: it carries its title, status `active`, the run's `changed_by` and one version.
12. Assert `ARK-T5`, absent in the run checkout, falls back to the configured workspace: title `ARK-T5 only in main`, `changed_by` `main-only`, one version.

## Expected results

- Where `test_case_source` is `local`, the system shall send id, title, level, technique, priority, `risk`, status (with the reason of a retired case), `changed_by` and the list of versions of each case that the ticket names.
- Where `test_case_source` is `zephyr`, the system shall send the id, name, status and sha that `result.json` records, and a version only when the file has a `version` field.
- Where a run of the ticket has a checkout holding a case file, the system shall send that case, with versions from that checkout, in place of the configured workspace's copy; a case the checkout lacks shall come from the configured workspace.
- The system shall make no request to Zephyr.
- If a `verified_by` id has no case file, then the system shall send the word `missing` for it, never an empty row.

## Screenshot checkpoints

none: integration case on a JSON read; the page rendering of `missing` is proven in ARK-T18.
