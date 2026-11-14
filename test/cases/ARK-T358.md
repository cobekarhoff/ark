---
id: ARK-T358
title: ARK-T358 The run snapshot of a 3-repo run carries the repos block, step repos, repo order, MR waits and bump states
level: integration
technique: equivalence classes (MR run, hand-off run, closed handed_off run, single-repo run, old plan with no repos list, cyclic repos); race ordering (repo facts arrive after the MR state)
priority: high
risk: "the hub keeps reading only `plan.steps` so the repos block, a step's repo or `waits_for` never reaches `RunView`; the page re-derives the order and it differs from `repoGraph`; a cyclic repos list throws inside the snapshot compose and the run vanishes; a closed handed_off run loses its repos; a bump step shows done with no refresh; the test reads a bump state before the repo-facts loop has published (a read race between the MR loop and the repo-facts loop, `readRepoFactsOnce` in `hub/snapshot.ts`), so a submodule bump reads `unknown` on a host where the MR loop is faster, as on the Linux CI runner"
status: active
changed_by: 2026-11-14-ARK-468-1
---

## Objective

Prove that the snapshot of a fixture run holds what the repo graph draws from, in the order `repoGraph` gives, and that bad plans degrade to a run with no graph. The proof reads a bump state only after the repo facts of the run are read: the MR loop (the `gh` read that reports `merged`) and the repo-facts loop (git reads of branch and submodule pointer) are two background loops, and the first snapshot that shows `merged` can come before the facts. An unread fact shows as `unknown` by design, so waiting for the MR state alone is a read race, not a git setting (the fixture records the pointer with `git update-index --cacheinfo 160000`, and `git ls-tree` reads it with no submodule worktree and no `protocol.file.allow`).

## Preconditions

- Test in `test/hub.test.ts`, new fixture writer that writes `plan.yml` with a `repos` block (3 repos, edges with kind, pin, evidence, bump), steps with a repo each (one bump step), `merge_request.opened` events with `order` and `waits_for`, and one `bump.refreshed` event.
- Variants: a `merge_requests: none` run closed `handed_off`; a plan with one step repo; an old plan with no `repos` list; a plan whose repos form a cycle.
- `docs/design/repo-graph/hybrid-1.html` and `data.js` exist (copy of the prototype folder).
- The repo-facts loop is held back deterministically: after `writeRepoWorkspace` and before the hub starts, a `git` shim is first on `PATH` that sleeps 1 s before it runs `ls-tree` and passes every other git command straight through. The fake `gh` answers at once, so the MR loop reports `merged` well before the repo facts publish (the facts publish after the last run of the loop, at least 3 s with 3 runs that read a pointer). The shim is the test's own dependency; no product code changes for it.

## Steps

1. Install the delaying `git` shim, start the hub, compose the snapshot for the 3-repo MR run.
2. Control (fails before the fix, deterministically), on the same hub: wait for the snapshot in which the MR run shows `merged`, with no wait on the facts. Assert `web-bump` reads `points at upstream branch unknown`, because the shim holds the facts for at least 3 s after `merged` shows. No second hub, no extra wait.
3. Wait for the snapshot in which the MR run shows `merged` AND the facts of that run are read (a repo of the run has `branch.ahead` not null; branch and pointer facts are set in one read, so one implies the other). Read `RunView` from that snapshot.
4. Assert `repos` in `repoGraph` order with each repo's `why`, edges with kind, pin, evidence and bump state; each step has its repo; each MR has `order` and `waits_for` and the upstream MR's state is found in the same list.
5. Assert the bump step is pending until `bump.refreshed` and refreshed after it; `web-bump` reads `points at upstream branch 01234567`.
6. Compose the handed_off run: repos and hand-off order still present, `merge_requests` empty.
7. Compose the single-repo, no-`repos` and cyclic runs: no graph is offered for one repo; the old plan orders by step `needs`; the cyclic run is still in the snapshot with no graph and no throw.
8. Assert the two files of `docs/design/repo-graph/` exist.

## Expected results

- When a run has 2 or more step repos, the snapshot shall carry its repos block, each step's repo, the merge or hand-off order from `repoGraph`, each MR with `waits_for`, and each bump step with its state.
- Once the repo facts of a run are read, the `web-bump` state shall read `points at upstream branch` and the first 8 characters of the recorded gitlink, on every host.
- If the repos form a cycle, then the snapshot shall hold the run with no graph.
- A run with one step repo shall carry no graph.
- The test shall wait for the repo facts of the run, not only for the MR state, before it reads a bump state.

## Screenshot checkpoints

none: the proof is snapshot data, not a view.
