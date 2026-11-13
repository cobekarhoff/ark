---
id: ARK-T316
title: ARK-T316 ARK-291-AC9 j k / Enter and Esc work on Roadmap, Esc returns to the same scroll position, and text keeps 4.5:1 (3:1 large) in light and dark
level: e2e
technique: state transition over keys; contrast measured in both themes once the animations of the page ended
priority: medium
risk: "Roadmap keys do not move the selection, Esc does not restore the scroll position, a stale chip still moving the page when the scroll is measured, or text below 4.5:1 in a theme"
status: active
changed_by: 2026-11-12-ARK-335-1
---

## Objective

Prove the Roadmap keys, the scroll restore on Esc and the text contrast in light and dark. Converted on touch from ARK-291-AC9 (the wait for the old per-source labels is now a wait for the stale chip, ARK-335).

## Preconditions

- Roadmap with 44 open tickets, project `p`, viewport of the other hub specs.

## Steps

1. Open the Roadmap and wait for the stale chip to vanish (every source answered).
2. Press `j`, `k`, `/`, Enter and Esc; assert the selection and the URL.
3. Assert Esc returns the Roadmap to the same scroll position.
4. In light and dark, wait for the finite animations to end and measure the contrast.

## Expected results

- The keys act as described.
- The scroll position after Esc equals the one before.
- Text keeps 4.5:1 (3:1 large) in both themes.

## Screenshot checkpoints

none: the case asserts requests, text and positions.
