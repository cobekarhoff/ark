---
id: ARK-T292
title: ARK-T292 the hub records agent peaks and gaps in resources.json for a run sampled, then a gap, then sampled again, and metrics.json and ark retro show the peaks
level: integration
technique: state transition (sampling -> no page -> sampling) with an injected clock, read-modify-write of one shared file
priority: high
risk: a cumulative CPU summed across samples, suite and agent peaks added together, a span with no page open (pause) is recorded as sampled or not recorded, so peaks look continuous; the peak of an agent drops after a gap (reset instead of max); the hub or `ark test` loses the other's keys; `metrics.json` or `ark retro` lacks the peaks, or old runs with no resources.json break `ark retro`
status: active
changed_by: 2026-11-12-ARK-418-1
---

## Objective

While a hub page is open the hub adds the peak memory and CPU seconds of each agent of a run to `agents` in `results/resources.json`, and records each span with no sample as a gap. `metrics.json` gets a `resources` object with the peaks of the run, and `ark retro` lists the run's top 3 by memory.

## Preconditions

- Accounting rules (the approved plan MUST adopt them): per agent, `peak_memory` = maximum over samples; `cpu_seconds` = the maximum cumulative reading (readings are cumulative, so never summed across samples, never lower than an earlier value). Run rollup in `metrics.json`: `peak_memory` = the largest single entry among agents and suites (suite and agent peaks may overlap in time, so they are not summed); `cpu_seconds` = sum over agent entries plus sum over suite entries (suite groups are separate process groups, not counted in an agent's group). Top 3 = entries ranked by peak memory.
- A fixture `ARK_HOME` with one open run `RUN-A` with 4 agents (handles `H1`..`H4`), plus a closed run `RUN-OLD` with no `resources.json`, and `results/resources.json` with a `suites` key written by `ark test`: suite `unit` peak 700 MB, cpu 30 s; suite `e2e` peak 450 MB, cpu 55 s.
- Fake `ps`, `lsof` and `orca` of ARK-T288 whose memory and CPU per handle are set by the test between samples. `ARK_HUB_INTERVAL_MS` is small and the clock of the hub is injected (the test sets the time of each sample).

## Steps

1. Start the hub, open one SSE client. Sample 1 at t0 (MB / cumulative CPU s): `H1` 300 / 10, `H2` 200 / 4, `H3` 100 / 2, `H4` 50 / 1. Sample 2 at t0+5 s: `H1` 500 / 14 (others as sample 1).
2. Close the SSE client (the hub pauses). Advance the clock 5 minutes with no sample; the fake `ps` shows `H1` at 900 MB meanwhile.
3. Open an SSE client again (the hub resumes). Sample 3 at t0+5 min+5 s: `H1` 400 / 20, `H2` 250 / 9 (`H3`, `H4` as sample 1).
4. Read `results/resources.json`. Then restart the hub (kill and start) with the clock 2 minutes later and one more sample 4: `H1` 350 / 26, `H2` 150 / 12, `H3` and `H4` absent (agents ended); read it again.
5. Run `ark retro RUN-A` (or the `metrics` step that writes `metrics.json`) and read `metrics.json` and `retro.md`. Run it for `RUN-OLD` as well.
6. Read `results/resources.json` again after the hub restart: the `suites` key must equal its fixture value.

## Expected results

- After step 3: `H1` 500 MB / 20 s (not 400 MB; the 900 MB of the closed span is not counted since no sample was taken; not 44 s, the sum of 10+14+20); `H2` 250 MB / 9 s; `H3` 100 MB / 2 s; `H4` 50 MB / 1 s.
- After sample 4: `H1` 500 MB / 26 s; `H2` 250 MB / 12 s (a lower 150 MB reading never lowers a peak); `H3` 100 MB / 2 s and `H4` 50 MB / 1 s are kept (absence is not a reset).
- `gaps`: one entry from the time of sample 2 to the time of sample 3 (start and end within one interval of those times, about 5 min), none between samples 1 and 2. A second entry covers the hub restart (~2 min). Nothing is added while samples are in a row.
- The `suites` key is unchanged by the hub (step 6), at every read. Preservation of `agents` and `gaps` by the suite writer is owned by ARK-T291 and not repeated here.
- `metrics.json` of `RUN-A` has `resources.peak_memory` = 700 MB (not the sum) and `resources.cpu_seconds` = 126 (agents 26+12+2+1 = 41, suites 30+55 = 85; not double counted). `ark retro` lists exactly 3 top entries in this order: suite `unit` (700 MB), `H1` (500 MB), suite `e2e` (450 MB); `H2` (250 MB) is not listed. `retro.md` shows the same three.
- `RUN-OLD` (no `resources.json`) completes `ark retro` with `resources: "unknown"` in `metrics.json` (the convention of `cost.review_to_build_ratio`), no throw, and the comparison with other closed runs does not count it as zero.
- The file is valid JSON at every read, including while the hub and `ark test` write.

## Screenshot checkpoints

none: no UI surface in this case; the proof is the file content and the `ark retro` text.
