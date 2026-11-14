---
id: ARK-T358
title: ARK-T358 The run snapshot of a 3-repo run carries the repos block, step repos, repo order, MR waits and bump states
level: integration
technique: equivalence classes (MR run, hand-off run, closed handed_off run, single-repo run, old plan with no repos list, cyclic repos)
priority: high
risk: "the hub keeps reading only `plan.steps` so the repos block, a step's repo or `waits_for` never reaches `RunView`; the page re-derives the order and it differs from `repoGraph`; a cyclic repos list throws inside the snapshot compose and the run vanishes; a closed handed_off run loses its repos; a bump step shows done with no refresh"
status: active
changed_by: 2026-11-13-ARK-339-1
---

## Objective

Prove that the snapshot of a fixture run holds what the repo graph draws from, in the order `repoGraph` gives, and that bad plans degrade to a run with no graph.

## Preconditions

- Test in `test/hub.test.ts`, new fixture writer that writes `plan.yml` with a `repos` block (3 repos, edges with kind, pin, evidence, bump), steps with a repo each (one bump step), `merge_request.opened` events with `order` and `waits_for`, and one `bump.refreshed` event.
- Variants: a `merge_requests: none` run closed `handed_off`; a plan with one step repo; an old plan with no `repos` list; a plan whose repos form a cycle.
- `docs/design/repo-graph/hybrid-1.html` and `data.js` exist (copy of the prototype folder).

## Steps

1. Compose the snapshot for the 3-repo MR run; read `RunView`.
2. Assert `repos` in `repoGraph` order with each repo's `why`, edges with kind, pin, evidence and bump state; each step has its repo; each MR has `order` and `waits_for` and the upstream MR's state is found in the same list.
3. Assert the bump step is pending until `bump.refreshed` and refreshed after it.
4. Compose the handed_off run: repos and hand-off order still present, `merge_requests` empty.
5. Compose the single-repo, no-`repos` and cyclic runs: no graph is offered for one repo; the old plan orders by step `needs`; the cyclic run is still in the snapshot with no graph and no throw.
6. Assert the two files of `docs/design/repo-graph/` exist.

## Expected results

- When a run has 2 or more step repos, the snapshot shall carry its repos block, each step's repo, the merge or hand-off order from `repoGraph`, each MR with `waits_for`, and each bump step with its state.
- If the repos form a cycle, then the snapshot shall hold the run with no graph.
- A run with one step repo shall carry no graph.

## Screenshot checkpoints

none: the proof is snapshot data, not a view.
