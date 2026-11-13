---
id: ARK-T291
title: ARK-T291 ark test writes the peak memory, CPU seconds, wall time and admission wait of each suite and side to results/resources.json
level: integration
technique: real child process with a known memory load, boundary of the wait (0 with no other test, greater than 0 when it queued), state of the file across a rerun
priority: high
risk: the sampler reads the runner instead of the suite group (a peak near zero), loses the short-lived children, reports a wait greater than 0 with no other test or loses the wait when queued, writes no value or a wrong one for a cached or quick suite, or a rerun of `ark test` removes the hub's `agents` and `gaps` keys
status: active
changed_by: 2026-11-12-ARK-418-1
---

## Objective

`ark test` samples the process group of each suite it starts (head and base) every second and writes `results/resources.json` in the run folder: for each suite and side, peak memory, CPU seconds, wall time and time waited for admission.

## Preconditions

- A fixture repo and `ARK_HOME` with an open run and a `test_command` suite in `ark.yml` that allocates about 200 MB (touches every page), keeps it for 3 s, spawns a child that also holds 30 MB, then exits 0. A second suite exits at once (shorter than one sample interval) after burning CPU for 0.2 s.
- A fixture with a base side (full run, not `--quick`).
- `results/resources.json` already holds a hub-written `agents` key and one `gaps` entry (from ARK-T292).
- The `ark test` lock folder of the fixture has no other ticket for step 1 and a started ticket of another run (holding all the CPU budget) for step 3.

## Steps

1. Run `ark test` for the run with no other test. Read `results/resources.json`.
2. Run it again with the suites cached (`reused: true`) and read the file. Run once with `--quick` and read it.
3. Start a second `ark test` (run B) while another ticket holds the budget, release that ticket after about 2 s, let run B finish, and read its `resources.json`.
4. After steps 1-3, read `agents` and `gaps` of the fixture file of step 1's run.

## Expected results

- Step 1: for the 200 MB suite, both head and base sides have an entry with `peak_memory` of 150 MB or more (and less than 400 MB, so the group is not double counted), `cpu_seconds` greater than 0, `wall_ms` of the suite run within 20% of the observed wall time, and `admission_wait_ms` of 0. For the short suite `cpu_seconds` is at least 0.1 and below the wall time times the core count (a group that exits between samples still has its CPU counted); no entry is missing.
- The peak is the peak of the group (runner child plus its child), not of `ark test` itself and not of the whole host.
- Step 2: a cached suite (`reused: true`) starts no process: its entry keeps the figures of its last measured run (`peak_mb`, `cpu_s`, `wall_s`, `wait_s`) and gains `cached: true`, so a rerun never loses the peaks of an unchanged suite; a suite never measured has only `{ cached: true }`; a `--quick` run has no base side entries and does not delete the entries of the full run it does not touch.
- Step 3: `admission_wait_ms` of run B is about 2 000 (at least 1 500 and at most 4 000), measured from the first request to the start; the wait of a suite is not added to its `wall_ms`.
- Step 4: `agents` and `gaps` are byte-identical (parsed JSON equal) to before the reruns: the suite writer owns the `suites` key only and preserves the others (ARK-T292 owns the hub writer's preservation of `suites`; the file is replaced by temp file and rename, never half-written when read at any time during the run).

## Screenshot checkpoints

none: no UI surface in this case; the proof is the file content.
