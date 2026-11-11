---
id: ARK-T235
title: "ARK-T235 a fake run in a demo fixture starts and finishes while host free memory and swap are past the default limits"
level: integration
technique: "equivalence classes (fixture without the keys vs with them) at a host reading below the default floor and above the default swap ceiling"
priority: high
risk: "A demo fixture leaves the memory floor or swap ceiling at its default, so a fake `ark test` waits on a host under 20 percent free, the suite ends on its timeout, and the runner lives on; or the test passes although the floor is never read"
status: active
changed_by: 2026-11-10-ARK-419-1
---

## Objective

Prove the demo project that the fixture writers of `test/test-run.test.ts`, `test/evidence-test-run.test.ts` and `test/test-selection.test.ts` write makes a fake run skip the memory wait, with the host reading below the default floor and the swap above the default ceiling.

## Preconditions

- Temp `ARK_HOME`, temp git repo, a fake run `FAKE-1` with one cheap suite whose command writes a marker file.
- Fake host reading at the real boundary: `memory_pressure` and `sysctl vm.swapusage` on a temp `PATH` (macOS), through the `setFakeHost` helper of `test/helpers.ts`. No hook in product code. The case skips off macOS.
- Fake reading: 15 percent free (under the default floor 20), 12 GB swap (over the default ceiling 8 and over 10).

## Steps

1. Control: write the demo project with the same fixture shape but without `test_min_free_memory_percent` and `test_max_swap_gb`. Run `ark test FAKE-1` in the background; wait over three poll intervals; read its output and the marker; stop the runner.
2. Write the demo project with each of the three suites' fixture writers (the writer of each suite is called, not a copy of it). Run `ark test FAKE-1` to its end.
3. Repeat step 2 for the second `writeProject("demo", …)` of `test/test-run.test.ts` (the multi-repo test).

## Expected results

- Step 1: the output names the memory wait and the marker is absent: the fake reading holds a run with the default limits, so the test of steps 2 and 3 can fail.
- Step 2: no memory-wait line, the suite starts at once, the run finishes, exit 0, the marker is written, for each of the three writers.
- Step 3: same as step 2.
- The fixture holds `test_min_free_memory_percent: 0` and `test_max_swap_gb: 1000` in `ark.yml` of the demo project.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
