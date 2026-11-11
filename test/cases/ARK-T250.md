---
id: ARK-T250
title: ARK-T250 A GitHub read released after the last page left changes nothing the next page sees, and the next page's own read shows the new answer
level: integration
technique: state transition (read in flight, last page leaves, read ends, new page)
priority: high
risk: A GitHub read that ends after the last page left is cached and published, so the next page first shows an answer from before it connected
status: active
changed_by: 2026-11-11-ARK-365-1
---

## Objective

Prove that the hub discards a source read that ends after the last page left, and that the next page's own read shows the new answer. Serves ARK-365.

Expected: When a source read ends after the last page left, the hub shall discard its result.

## Preconditions

- A running hub with a fake `gh` that can hold a read and change its answer.
- A run with an open merge request, shown by a connected page.

## Steps

1. Hold the next GitHub read, then drop the last page.
2. Change the answer to closed and release the read; wait until it ends.
3. Hold the next read and connect a page.
4. Read the first data of the page, then release the read.

## Expected results

- The first data of the new page does not show the merge request as closed.
- After the new read is released, the page shows it as closed.

## Screenshot checkpoints

None. There is no screen to check.
