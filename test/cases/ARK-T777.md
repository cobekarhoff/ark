---
id: ARK-T777
title: ARK-T777 The window check passes the orca read counts that failed CI on a healthy Linux runner and fails a second loop, one source at four times its baseline and a source that never reads
level: unit
technique: boundary values (churn 11 and 12 against a baseline of 3; 0 against 0; a churn sum of 35 against 30, between 1.5 and 2 times the baselines) and a decision table (per-source bound and sum rule, each row with one rule able to fail)
priority: high
risk: "the window check fails a healthy hub on the small counts of a starved Linux runner (orca W 4,4,4 churn 7 against the old limit of 1.5 times the baseline, PR CI run 44901215110; the other tuples come from main and PR CI runs of 2026-11-21), so ARK-T241 and ARK-T756 stay red with no defect in the hub; or the rewrite that lets those counts pass also lets a second loop pass (the sum rule dropped or its factor at 2 or more), lets one source run four times its baseline (the per-source bound dropped, written with `<=`, or given slack or rounding), lets a source that never reads pass (only the sum is checked), drops the 25-read window ceiling, or takes the baseline from the first, smallest or mean window; or a failure no longer names the counts it judged, so a CI log cannot show why"
status: active
changed_by: 2026-11-21-ARK-631-1
---

## Objective

Prove the rule of the window check module of ARK-T241 and ARK-T756 (`checkWindows` in `test/hub-window-check.ts`) on the exact counts that CI runs produced, which no live hub produces on demand. Serves ARK-631/AC1 and ARK-631/AC2.

Expected: When each source's churn count is below 4 times its baseline (the largest of its three windows) and the sum of the churn counts is below 1.5 times the sum of the baselines, and each window is below 25, the check shall pass. When any of the three fails, it shall fail and name the counts it judged.

Authoring gate:

1. Protects: the read-rate rule that ARK-T241 and ARK-T756 apply to a live hub. A healthy runner's small counts pass, a second loop fails, one runaway source fails, a dead source fails.
2. Fails when: on the base, the AC1 rows fail (`orca W 4,4,4 churn 7` throws, because 7 is not below 1.5 x 4 = 6). After the fix: the per-source bound is dropped or loosened (the 4x rows pass), the sum rule is dropped (the doubling rows pass, because 2x is under the per-source 4x), the sum factor is raised to 2 or more (the every-source `W 4,4,4 churn 7` row passes: 35 is below 2 x 20 = 40), the bound uses `<=` or rounding (the dead-source row or the 12-against-3 row passes), the window ceiling is dropped (the ceiling row passes), or the baseline is the first, smallest or mean window (the `1,1,3 churn 11` row fails: a limit of 4 x 1 or 4 x 1.67 is below 11).
3. Existing proof misses it: ARK-T241 and ARK-T756 run the check on a live hub whose counts depend on the host. On a developer machine they give about 20 reads a window and pass on the base rule too, so neither shows the CI tuples, and neither can make a second loop, a runaway source or a dead source without a change in `hub/`. ARK-T756 makes a starved first window but cannot set exact counts. This case owns the rule; ARK-T241 and ARK-T756 own its use on a live hub.
4. No hook: `checkWindows` is the module's one export, and ARK-T241 and ARK-T756 call it. The case calls the same export with literal counts. Level `unit` because the rule is a pure function of counts and the counts that matter came from CI runs, which an integration test on this host does not reproduce.

## Preconditions

- The window check module `test/hub-window-check.ts`, loaded as ARK-T241 loads it. No hub, no fake tool, no file.
- Sources in the order of ARK-T241: orca, plannotator, gh, conversation, chiefUnread. A row gives each source three window counts (W1, W2, W3) and a churn count, written `W a,b,c churn d`.
- "Healthy at 4" means a source at `W 4,4,4 churn 4`: the other sources of a CI pass, whose counts no log holds (the check threw on orca first). "Healthy at 10" and "healthy at 20" read the same way.
- A pass row expects the check to return. A fail row expects it to throw, and the message to name what the row says.

## Steps

1. Pass rows of AC1: orca at each tuple below, the other four sources healthy at 4. Then the same six rows with the other four healthy at 5.
   - `W 4,4,4 churn 7` (PR CI run 44901215110, ARK-T241)
   - `W 1,3,4 churn 6` and `W 1,4,3 churn 6` (ARK-T756)
   - `W 1,4,2 churn 6` (main #296; not named in AC1, the same failure)
   - `W 1,1,2 churn 3`
   - `W 1,1,3 churn 11` (main run 44900809909)
2. Pass row, no lower bound: orca `W 4,4,4 churn 0`, the others healthy at 4.
3. Fail rows of AC2, a second loop: every source at `W 4,4,4 churn 8`; then every source at `W 20,20,20 churn 40`. Then the sum factor's upper edge: every source at `W 4,4,4 churn 7` (each source 1.75 times its baseline, under the per-source 4x, so only the sum rule can fail).
4. Rows of AC2, one source at four times its baseline, the others healthy at 10 (so the sum rule passes and only the per-source bound can fail): orca `W 3,3,3 churn 11` (pass, 3.67 times), orca `W 3,3,3 churn 12` (fail), orca `W 2,2,2 churn 8` (fail), orca `W 4,4,4 churn 16` (fail).
5. Fail row of AC2, a dead source: conversation `W 0,0,0 churn 0`, the others healthy at 20.
6. Fail row, the window ceiling: orca `W 25,20,20 churn 20`, the others healthy at 20.

## Expected results

- Step 1: all 12 rows pass.
- Step 2: the row passes.
- Step 3: all three rows fail. The message names the sum rule, the churn sum and the limit (1.5 times the sum of the baselines: 40 against 30, 200 against 150, 35 against 30) and the W1, W2, W3 and churn count of every source. The `churn 7` row is the one that catches a sum factor of 2 or more: under a factor of 2 it passes (35 is below 40), while the two doubling rows still fail (40 is not below 40, 200 is not below 200).
- Step 4: churn 11 against 3 passes; each of the three 4x rows fails with a message that names orca and its W1, W2, W3, churn count and limit.
- Step 5: the row fails with a message that names conversation and its counts (0, 0, 0, churn 0).
- Step 6: the row fails with a message that names orca and its counts.
- On the base commit the step 1 rows fail and the rows of steps 3 to 6 that expect a failure already fail (AC2 is a guard). The validator records the base message of the first failing row; by the base code (`churn < 1.5 * baseline`, `test/hub-window-check.ts:21`) it is the orca row `W 4,4,4 churn 7` with a limit of 6.

Margin (validator evidence, once, not a row): with the other four sources healthy at 3, the `W 1,1,3 churn 11` row fails the sum rule (23 against a limit of 22.5). The evidence records it: AC1's churn-11 tuple passes only while the other sources read at least 4 a window, and no CI log holds their counts.

## Screenshot checkpoints

none: a pure function of counts, no page
