---
id: ARK-T75
title: ARK-T75 hub session ownership gives the same owners after the rule moves to the shared function
level: integration
technique: regression on equivalence classes of file start (before first step, inside a step window, in a gap between rework rounds, before step.started)
priority: medium
risk: moving the owner rule out of `hub/usage.ts` changes which session a hub transcript or usage view shows (ARK-284, ARK-344), or `cli/` starts to import `hub/`
status: active
changed_by: 2026-11-07-ARK-348-1
---

## Objective

Prove that `UsageIndex.sessionsOf` and its caller in `hub/snapshot.ts` keep their behavior when the owner rule becomes one function shared with `ark retro`. Serves ARK-348/AC1.

Expected: When the owner rule moves, the system shall give the run lead, each step and unassigned the same files as before.

## Preconditions

- The existing hub usage and snapshot fixtures, unchanged.
- Extra fixtures: a lead file that starts after the first step (unassigned for the lead), a rework step with a file in a later round and one in a gap between rounds, an evaluator and a designer stage file.
- Old-form fixtures (ARK-425): a run with no `worker.started` event for a step, and a run whose `worker.started.session` is `unknown`; each has a file that starts inside its step window.

## Steps

1. Run the existing hub usage and snapshot tests without edits.
2. Call `sessionsOf` for the extra fixtures and read each file's owner.
3. Call `modelsOf` for the same fixtures (with stage times) and read the owner keys of the result.
4. Check that `cli/` has no import from `hub/`.

## Expected results

- Existing hub tests pass unchanged.
- The lead gets a file only when it starts before the first step; a later-round file goes to the later round; a gap file is unassigned; evaluator and designer files stay `unassigned` in `sessionsOf` and are never picked as the lead.
- `modelsOf` reports the evaluator and designer file models under the keys `evaluator` and `designer`, and the lead, step and rework models under `lead` and the step ids.
- Old-form runs (no `worker.started`, or `session: unknown`) give each step the file that starts inside its window, with the owners the window rule gave before ARK-425; the session mapping adds to the rule and does not replace it.
- No file under `cli/` imports `hub/`.

## Screenshot checkpoints

None. The surface is data returned to the hub; the hub UI is unchanged.
