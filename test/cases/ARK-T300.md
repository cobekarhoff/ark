---
id: ARK-T300
title: "ARK-T300 a transcript shows 200 entries a page and Load more adds the next page, and at the end of a live file it checks for new entries"
level: e2e
technique: boundary values of the page (200, 400, end of file), state transition (page to end of file to new entries)
priority: medium
risk: "a page holds more or fewer than 200 entries; Load more does not append or doubles an entry; at the end of the file the control cannot fetch entries written after the page loaded"
status: active
changed_by: 2026-11-12-ARK-324-1
---

## Objective

Keep the paging rule of ARK-284 on the new list. Expected: When the transcript is at the end of a file, the system shall let the human check for new entries, and Load more shall add the next page of 200 entries.

## Preconditions

- A closed run whose lead session file holds 450 user messages `m0` to `m449`.
- The hub runs against that run, with the session file in the isolated sessions folder.

## Steps

1. Open the run page and click the run lead link.
2. Count the entries; click Load more; count again; click Load more again.
3. Read the button text and the end-of-file line.
4. Append one more message, `live arrival`, to the session file, and click the button.

## Expected results

- The first page shows 200 entries; the first Load more makes 400; the second makes 450.
- At the end the button reads "Check for new entries" and the page says "End of file · 450 entries"; the last entry is `m449`.
- After the append and a click, the page holds 451 entries and the last one is `live arrival`; no entry is doubled.

## Screenshot checkpoints
