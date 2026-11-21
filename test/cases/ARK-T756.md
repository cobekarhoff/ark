---
id: ARK-T756
title: ARK-T756 With every fake source held for the whole first 2 s window, the first window counts 0 to 5 reads, and after the release the churn check of ARK-T241 passes with no second loop
level: integration
technique: boundary values (a starved baseline window of 0 to 5 reads against a healthy one of about 20) with state transition (held, released, churn)
priority: high
risk: "the churn check takes its baseline from one starved window (a floor of 5 that a starved window misses, or 1.5 times a window of 5 that a healthy churn window of 11 exceeds), so ARK-T241 fails on a loaded host with no defect in the hub (runs 2026-11-20-ARK-608-1 and 2026-11-20-ARK-606-1); or the baseline is the smallest, the first or the mean of the windows instead of the largest; or a hold control misses one of the five counted sources, so the starved window is not starved for that source and the test proves nothing for it"
status: active
changed_by: 2026-11-20-ARK-615-1
---

## Objective

Prove that the window check of ARK-T241 survives a starved first window: one window of 0 to 5 reads, then two healthy windows, give a baseline that a healthy churn window stays under. Serves ARK-615/AC3.

Expected: When the first 2 s window holds 0 to 5 reads of a source, the check shall take the largest of the three windows as the baseline and pass a churn window of a hub that runs one loop per source.

Authoring gate:

1. Protects: the baseline of the churn check is the largest of three consecutive windows, so one starved window does not set the limit, and no fixed floor applies to a window.
2. Fails when: the floor of 5 stays (the held window has 0 to 5), the baseline is the first window or the smallest (0 to 5, limit at most 7.5, a healthy churn window has about 20), or the mean (about 13, limit about 20, so a healthy churn window of about 20 fails often); or a hold control does not hold its source (that window counts about 20, above 5).
3. Existing proof misses it: ARK-T241 owns the idle lifecycle and the rule on a natural sample, where the first window starves only on a loaded host and passes on an idle one. No test makes the starved window happen on demand. The held window is a distinct load state of the same check, so this case loads the same window-check module as ARK-T241 and runs the same setup (the setup is shared, not copied).
4. No hook in `hub/`: the holds are state files of the fake tools of `fixture()` in `test/hub-idle.test.ts`, which the shell fakes read. The window check is the shared test module that ARK-T241 also loads.

## Preconditions

- The setup of ARK-T241 (same `fixture()`, a run in `building` with its Orca run, a run with an open plan gate and a Plannotator session, `ARK_HUB_INTERVAL_MS=100`, the hub started with `Bun.spawn`).
- `fixture()` has a hold control for each of the five counted sources. Each fake appends its call line first and then waits while its hold file exists (cap 1500 x 0.02 s), and waits for nothing when the file is absent:
  - `orca.hold`: `orca terminal list` only (existing).
  - `plannotator.hold`: every `plannotator` call (new).
  - `inbox.hold`: the conversation read (`orca orchestration inbox` with `--full` and a `--limit` other than 200) and the Master Chief unread read (`inbox` with `--terminal`) (new). Never the liveness read `inbox --limit 200 --full` of the orca pass, and never `orca.hold`: ARK-T241 step 4 and ARK-T250 hold one source and the others must keep running.
  - `gh.hold`: every `gh` call (existing).
- `afterEach` removes all four hold files.
- The window check is a module under `test/` that ARK-T241 and this case load with `await import`. It takes three window counts and the churn window count of each source, uses the largest of the three as the baseline, requires each window below 25 and the churn count below 1.5 times the baseline, and fails with a message that names the source, the three window counts and the churn count.

## Steps

1. Run steps 1 and 2 of ARK-T241's setup: start the hub with no client, connect one client and wait until a push has fresh orca, plannotator and github data.
2. Create the four hold files. Count each source's lines over the next 2 s: window W1.
3. Remove the four hold files at the end of W1. Count two more consecutive 2 s windows: W2 and W3.
4. Connect a client, disconnect it, and reconnect within 50 ms, 5 times, as ARK-T241 step 5. Keep the last client and wait 200 ms. Count one 2 s window: the churn window.
5. Run the window check on W1, W2, W3 and the churn window of each source: orca, plannotator, gh, conversation, chiefUnread.

## Expected results

- Step 2: W1 is 0 to 5 for each of the five sources (a read that started before the hold counts 0, the one that starts inside the window logs its line and waits). A source above 5 means its hold does not reach it, and the case fails there.
- Step 3: W2 and W3 hold healthy counts (about 20 each at the 100 ms interval).
- Step 5: the check passes for each source: every window below 25 and the churn count below 1.5 times the largest of W1, W2 and W3. No floor of 5 applies to W1.
- The case needs no load on the host and no repeat count: the holds make the starved window happen on every run.

Baseline (validator): on the base, the held W1 fails the old floor `expect(reads).toBeGreaterThanOrEqual(5)` of ARK-T241 for each source, or the import of the missing window-check module fails. The validator records which and the printed line.

Run evidence (once, not part of the permanent suite): the validator runs this case and ARK-T241 on a scratch clone in which `hub/snapshot.ts` starts a second loop on reconnect (`pause` keeps `generation` and the timers, `resume` does not increment `generation`). It checks that the patch applied (the diff is in the evidence) and that both tests fail on the churn check with a message that names the source, the three window counts and the churn count. Written to `results/evidence/AC3-mutation.md`.

## Screenshot checkpoints

none: call-log counts and event-stream assertions only
