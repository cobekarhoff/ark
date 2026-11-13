---
id: ARK-T361
title: ARK-T361 The ticket page shows the repo chain of the newest run and links to the run page card; a single-repo run shows none
level: e2e
technique: equivalence classes (3-repo run, closed handed_off newest run, single-repo run) and a state-dot per run state
priority: medium
risk: "the chain reads an older run or only open runs, so a closed ticket shows none; the click opens the run page with all cards collapsed or at the wrong card; the hash route is refused by the parser; a single-repo ticket shows a one-repo chain or loses its step DAG; dot state does not match the card"
status: active
changed_by: 2026-11-13-ARK-339-1
---

## Objective

Prove the chain on the ticket page, its order and dots, the link to a card, and the absence of graph and chain for one repo.

## Preconditions

- Playwright in `test/pw/hub.pw.ts`; a ticket with an older 1-repo run and a newest 3-repo run (open), a ticket whose newest 3-repo run is closed, a ticket whose newest run is the 4-repo run of ARK-T359 (its cards start collapsed), and a single-repo ticket.

## Steps

1. Open the ticket page of the open 3-repo run. Assert the chain on one line in merge order with a dot per repo whose state matches the card.
2. Click the second repo; assert the hash route is the run page, and the card of that repo is in view.
3. Reload that URL; assert the same card is targeted.
4. Open the ticket page of the 4-repo run, click its third repo; assert the run page opens with that card expanded and in view while the other cards stay collapsed.
5. Open the closed ticket; assert the chain shows from the newest run.
6. Open the single-repo ticket; assert no chain. Open its run page; assert no repo graph and the step DAG still shows.

## Expected results

- The ticket page shall show the repo chain of the ticket's newest run on one line in merge or hand-off order, with a state dot per repo.
- When a repo is clicked, the run page shall open at that card, and open it when it is collapsed.
- A single-repo run shall show no repo graph and no chain, and the run page shall keep its step DAG.

## Screenshot checkpoints

`checkpoint`: `ticket-chain`, `run-card-target`, `single-repo-no-chain`.
