---
id: ARK-T766
title: ARK-T766 `ark criteria amend <run> <AC id> --guard` and `--no-guard` set and remove the guard after the criteria gate, the red proof follows the amend, a text or verified_by amend keeps the guard, and the gate's refusals apply
level: integration
technique: state transition (no guard, --guard, --no-guard, a text or --verified-by amend of a guard AC, each followed by an implementer start) and equivalence classes of the refusals (method not test, kind not bug, unknown AC, merge_requests_open, no change: --guard on a guard, --no-guard on no guard)
priority: high
risk: "the amend writes the line into ticket.md but records no event (or an event that `deriveState` does not read), so the red proof still demands the guard and the run is stuck as in ARK-606; or `--no-guard` leaves the line or the guard in state, or misses the line the criteria gate wrote; or the amend rewrites the text, method or `verified_by` of the AC or another AC; or the guard event is read as a text amendment (the `criteria.amended` branch with no `verified_by_new`), so the manual answer is cleared and an empty text amendment shows in the plan and the MR; or replay reads a `criteria.amended` with no `guard` field (every text and `--verified-by` amend) as `guard: false`, so a text amend of a guard AC clears the guard in state while ticket.md keeps the line and the red proof demands the guard again (the ARK-606 stall); or `--guard` on a guard writes a second `guard:` key, or `--no-guard` on no guard cuts another line of the block, and the ticket's readers break; or the amend skips the gate's refusals, so a guard sits on an inspection AC or in a feature run; or the amend works after the MR is open"
status: active
changed_by: 2026-11-21-ARK-617-1
---

## Objective

Prove that `ark criteria amend <run> <AC id> --guard` adds `guard: true` to the criterion in the run's `ticket.md` and records `criteria.amended` with `guard: true`, that `--no-guard` removes it and records `guard: false`, that the bug-run red proof reads the amended guard, and that the amend refuses a criterion whose method is not `test` and a run whose kind is not `bug`, as the criteria gate does. Serves ARK-617/AC4.

Authoring gate:

1. Protects: the third form of `ark criteria amend` (`cli/criteria.ts`, `cli/commands/criteria.ts`) and the replay of its event by `deriveState`.
2. Fails when: the ticket line or the event is missing or wrong (steps 1 and 3), the replay ignores the event (steps 2 and 4), the event counts as a text amendment (step 1), other lines change (step 1), a refusal is missing or writes something (steps 5 and 6), a field-less `criteria.amended` clears the guard (step 7), or `--no-guard` misses the gate's line (step 8).
3. Existing proof misses it: ARK-T228 and ARK-T230 own the `--verified-by` form and its refusals, ARK-T550 to ARK-T556 the text form; none sets a guard. ARK-T763 owns the red proof for a guard set at the gate; this case proves only that an amended guard reaches it, a distinct lifecycle (after the gate).
4. No test-only export, flag or hook: the case runs the `ark` process on the run folder, as `test/criteria-amend.test.ts` does.

## Preconditions

- A temp `ARK_HOME`, project and git repo, as `test/criteria-amend.test.ts`. A `kind: bug` run in `building` whose criteria gate was answered with no guard: `AC1` `method: test` with `verified_by: [ARK-T1]`, `AC2` `method: test` with `verified_by: [ARK-T2]` written as a block list, `AC3` `method: inspection`, `AC4` `method: demonstration` (manual) with a recorded manual answer `ok`. Its plan has an implementer step `build`. One appended `test.completed` (as ARK-T475) with `AC1` `failing`, `AC2` `passing`, `AC3` and `AC4` `manual pending`.
- A second `kind: bug` run in `building`, the guard run: the same ACs, plan and appended `test.completed`, but its criteria gate was answered with the real `ark gate record <run> criteria accept --criteria <file>` whose file has `guard: true` on `AC2` (as ARK-T764 step 1), so the `guard: true` line in `ticket.md` is the one the gate's writer wrote. The worktree has `test/cases/ARK-T3.md` with `status: active` committed at head, since the `--verified-by` form refuses an id with no active case.
- A `kind: feature` run in `building` with the same `AC1` and `AC2`; a `kind: bug` run in `merge_requests_open` with the same criteria.
- Before each call: the bytes of `ticket.md`, the line count of `events.ndjson`, and `state.json`.

## Steps

1. Bug run: run `ark run step <run> build start` (refused, as ARK-T763). Then run `ark criteria amend <run> AC2 --guard --reason "holds at base"`. Read `ticket.md`, the last `criteria.amended` and `state.json`.
2. Run `ark run step <run> build start`.
3. In a fresh bug run with the same state, amend `AC2 --guard`, then `ark criteria amend <run> AC2 --no-guard --reason "it shows the bug"`. Read `ticket.md`, the last `criteria.amended` and `state.json`.
4. Run `ark run step <run> build start`.
5. Refusals, each with `--guard --reason "x"`: `AC3` and `AC4` in the bug run; `AC2` in the feature run; `AC2` in the `merge_requests_open` run; `AC9` (no such AC) in the bug run.
6. No-change inputs: `ark criteria amend <run> AC2 --no-guard --reason "x"` in a fresh bug run (AC2 has no guard), and `ark criteria amend <run> AC2 --guard --reason "x"` in a fresh guard run (AC2 is a guard from the gate).
7. A guard kept through the other forms: in a fresh guard run, `ark criteria amend <run> AC2 <file with new text> --reason "x"`, then `ark criteria amend <run> AC2 --verified-by ARK-T2,ARK-T3 --reason "x"`. Read `ticket.md`, the two `criteria.amended` events and `state.json`. Run `ark run step <run> build start`.
8. The gate's line removed: in a fresh guard run, `ark criteria amend <run> AC2 --no-guard --reason "it shows the bug"`. Read `ticket.md` and the last `criteria.amended`. Run `ark run step <run> build start`.

## Expected results

- Step 1: the start exits 1 with `bug run: record a failing ark test of the ACs before the fix`. The amend exits 0 and its output names `AC2`. `ticket.md` holds one new `guard: true` line in the block of `AC2`; every other line, including the text, method and block `verified_by` of `AC2`, the other ACs and the body table, is byte for byte what it was. `parseCriteria` of `cli/ticket.ts` on `ticket.md` gives `AC2` guard true. The event has `criterion` `AC2`, `guard: true` and the reason. `state.json` lists no new text amendment (`amended_criteria` unchanged) and `AC4` keeps its manual answer `ok`.
- Step 2: exit 0; one `step.started` for `build` (the amended guard is exempt from the red proof of the appended run).
- Step 3: both amends exit 0. `ticket.md` is byte for byte what it was before the `--guard` amend; `parseCriteria` gives `AC2` no guard; the last event has `criterion` `AC2` and `guard: false`.
- Step 4: exit 1 with `bug run: record a failing ark test of the ACs before the fix`, no `step.started`.
- Step 5: each call exits 1 with one `ark: ` line: `AC3` and `AC4` name the AC, `guard` and the method (`inspection`, `demonstration`); the feature run names `AC2`, `guard` and the kind `feature`; the `merge_requests_open` run names the phase, as ARK-T230 says for the other forms; `AC9` names the unknown AC and lists the real ones. After each, `ticket.md`, `events.ndjson` and `state.json` are unchanged.
- Step 6: each call exits 1 with one `ark: ` line that names `AC2` and says it is already a guard (`--guard`) or is not a guard (`--no-guard`); `ticket.md`, `events.ndjson` and `state.json` are unchanged, so the guard run's `ticket.md` still holds exactly one `guard:` line in the block of `AC2` and `parseCriteria` reads it.
- Step 7: both amends exit 0. `ticket.md` holds the new text and `verified_by: [ARK-T2, ARK-T3]` for `AC2` and still exactly one `guard: true` line in its block. Neither event has a `guard` key (the text and `--verified-by` forms are unchanged, ARK-T550 and ARK-T228). `parseCriteria` gives `AC2` guard true. The start exits 0 with one `step.started` for `build`: replay keeps the guard through field-less `criteria.amended` events.
- Step 8: the amend exits 0; `ticket.md` is its bytes before the amend with exactly the gate's `guard: true` line removed; the event has `criterion` `AC2` and `guard: false`. The start exits 1 with `bug run: record a failing ark test of the ACs before the fix`.
- This case does not assert the start of an all-guards run (ARK-T763) or the `--reason` rule of the other forms (ARK-T230).

## Screenshot checkpoints

none: CLI and file assertions only; no UI surface.
