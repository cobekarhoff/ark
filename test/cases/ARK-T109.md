---
id: ARK-T109
title: ARK-T109 plan.md draws a 3-repo plan as repo subgraphs with the merge order
level: integration
technique: equivalence classes (single-repo vs multi-repo), exact text comparison
priority: medium
risk: the Mermaid of a multi-repo plan hides the merge order, the repo edges or the cross-repo step edges, so the plan gate shows no graph a later review can check; or a single-repo plan changes
status: active
changed_by: 2026-11-08-ARK-336-1
---

## Objective

Prove that the `plan.md` of a 3-repo plan holds one Mermaid subgraph per repo with its order number, thick `==>` edges for cross-repo steps, dotted repo edges labelled with the kind and the pin, a `Merge order:` line and a `## Repos` table, and that a single-repo plan draws as before.

## Preconditions

- The 3-repo Clara plan of the mockup, and a one-repo plan fixture whose `plan.md` was written by the previous version.

## Steps

1. Run the plan write (the command that writes `plan.md`) for the 3-repo plan and read the Mermaid text.
2. Check the `review-core` to `validate` edge, which crosses repos.
3. Run it for the one-repo plan and compare with the previous `plan.md` byte for byte.

## Expected results

- The text shall hold `subgraph repo1["1 repos/shared/clara-core"]`, the same for repo2 and repo3, and the line `Merge order: 1 repos/shared/clara-core → 2 repos/platform → 3 repos/domains/reports`.
- Each step shall read `<id>: <role>` with no `@ repo`; edges inside a repo shall be `-->`, edges across repos shall be `==>`.
- The repo edges shall be `repo1 -.->|"package clara-core>=0.0.6rc1"| repo2` and the other two, and no dotted edge shall go from repo2 to repo1 for the reviewer `needs`.
- The `## Repos` table shall hold the evidence of each edge.
- The one-repo `plan.md` shall equal the old one: flat graph, `@ repo` labels, no subgraph, no Merge order line, no `## Repos` table.

## Screenshot checkpoints

none: integration case on generated text.
