---
id: ARK-T299
title: "ARK-T299 sweep closes only the terminals of released or closed dispatches that still run, lists idle services, and never touches a live dispatch or the Master Chief terminal"
level: integration
technique: "equivalence classes on dispatch state (released, closed, active, retained, other project, Master Chief) and boundary values on idle age (23 h, 25 h)"
priority: high
risk: "the sweep closes a live dispatch, a run lead or the Master Chief terminal (selected by workspace path or by a stale list); it closes a terminal of another project; it closes retained or keep-open terminals; it kills an idle service instead of listing it; it sends no message or several"
status: active
changed_by: 2026-11-12-ARK-358-1
---

## Objective

The sweep closes the Orca terminal of each released or closed dispatch of the project whose terminal is still connected, lists agent services and prototype servers idle more than one day, and sends one status message to the Master Chief Run naming what it closed and what it found. It never closes an active dispatch or the Master Chief Run terminal.

## Preconditions

- A fake `orca` with paged `worker-list --json` (`dispatchId`, `state`, `terminal`, `terminalState`, `workspace`) and `terminal list --json` (`handle`, `worktreePath`, `connected`, `lastOutputAt`, `title`), `terminal close` and `send` logged, `run-list` with the Master Chief Run.
- Rows for project `ark`: D1 released (`terminalState: released`, terminal still connected), D2 closed (settled state, terminal connected), D3 active (running), D4 retained, D5 settled but terminal already gone from `terminal list`. A row of project `other` settled and connected. The Master Chief terminal at the project workspace path, a run lead terminal, and two terminals idle 23 h and 25 h (one a prototype server).
- A variant fake in which D2 turns active between the first and the fresh `worker-list`.

## Steps

1. Run the sweep once.
2. Read the logged `close` and `send` calls.
3. Run the variant where D2 restarts before the close.
4. Run the sweep again after step 1 with the closed terminals gone.
5. Make `terminal close` fail for D1; run again.

## Expected results

- Step 1-2: `close` for D1 and D2 terminals only; none for D3, D4, D5, the `other` project row, the Master Chief terminal or the run lead terminal. The 25 h terminal is listed idle, the 23 h one not, and nothing is killed. One `send` to the ark Master Chief Run, type `status`, whose body names the two closed and the one idle.
- Step 3: D2 is not closed (the state is read fresh at the close).
- Step 4: no `close`, and no message or one that says nothing happened, per the plan; never a repeat of the closed list.
- Step 5: the failure is logged, the sweep continues with D2 and exits 0 or loops on.

## Screenshot checkpoints

none: script and log output, no UI.
