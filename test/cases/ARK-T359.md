---
id: ARK-T359
title: ARK-T359 The run page draws repo cards in merge or hand-off order with labelled repo edges, collapsed at 4 or more repos
level: e2e
technique: boundary values (3 and 4 repos) and equivalence classes (MR run, hand-off run)
priority: high
risk: "the cards use step order or alphabetical order instead of merge order; a hand-off run shows an MR number or nothing for its branch; the 4-repo run starts expanded and overflows the viewport; the edge label shows no pin or evidence; hover works but keyboard focus shows no evidence; repo `why` or evidence containing markup renders as HTML"
status: active
changed_by: 2026-11-13-ARK-339-1
---

## Objective

Prove the card list, its order, its per-card data, the edge labels and hover or focus evidence, and the collapse rule.

## Preconditions

- Playwright in `test/pw/hub.pw.ts`; fixtures from ARK-T358: a 3-repo MR run (one MR waits for another, CI set) and a 4-repo `merge_requests: none` run with hand-off branches; one `why` holds `<b>x</b>`.

## Steps

1. Open the 3-repo run page. Assert 3 cards in merge order, each with order number, `why`, MR number, state, CI, 'waits for !N', a step ring with its done count and one dot per step; cards start expanded.
2. Assert each repo edge shows its kind and pin; hover one edge, assert its evidence and bump state show; focus another edge with the keyboard, assert the same.
3. Open the 4-repo hand-off run. Assert 4 cards in hand-off order, all collapsed, each with its hand-off branch and state and no MR number.
4. Assert the `<b>` text shows literally in the `why`.

## Expected results

- The run page shall draw one card per repo in merge order, or hand-off order for `merge_requests: none`, with its order number, `why`, MR number, state, CI and 'waits for !N', or its hand-off branch and state, and a ring and a dot per step.
- Repo edges shall carry kind and pin; hover or focus shall show evidence and bump state.
- Where a run has 4 or more repos, the cards shall start collapsed.
- Free text shall render as text.

## Screenshot checkpoints

`checkpoint`: `cards-3-repo` (before the order assertion), `edge-hover`, `cards-4-repo-collapsed`.
