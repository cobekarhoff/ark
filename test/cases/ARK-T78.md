---
id: ARK-T78
title: ARK-T78 the ticket page shows the snapshot title at once, shows a loading state until its document arrives, and shows a change to the ticket file within 5 seconds
level: e2e
technique: state transition (loading, loaded, unreadable, reloaded after a file change), boundary of time (5 s), request accounting for the signature-driven refetch
priority: high
risk: "the title waits for the document request; no loading state shows, so the page looks empty or jumps; the page never refetches after the file changes because the snapshot no longer pushes; the page flashes back to loading on a reload, or refetches on an unrelated push; an unreadable file shows the loading state forever or a blank page; a side panel waits for the document"
status: active
changed_by: 2026-11-07-ARK-329-1
---

## Objective

Prove the ticket page paints the title and header from the snapshot before the document arrives, shows a loading state while the route answers, shows the document when it arrives, shows an edit of the ticket file within 5 s, and shows an unreadable state when the file does not parse. Serves ARK-329/AC3.

Expected: When the ticket page opens, the system shall show the title from the snapshot at once, shall show a loading state until the document arrives, and shall show a change to the ticket file within 5 s.

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts` with a hub on a temp `ARK_HOME` (fixture from `test/hub-fixtures.ts`), project `p`, `ticket_source: local`, with a writable tickets folder.
- Ticket `ARK-521` (title `Ticket`, ready): problem `First text`, one criterion `AC1`.
- The test delays the `/api/ticket/p/ARK-521` response by 1.5 s with a route handler, for step 1 only.

## Steps

1. Open `#/ticket/ARK-521` with the delay on. Assert the heading `Ticket` is visible and the loading status shows while the document is not yet loaded. `checkpoint(page, "ticket-loading")`. Assert the text `First text` is not visible yet.
2. Wait until `First text` shows. Assert the loading status is gone. `checkpoint(page, "ticket-loaded")`.
3. Remove the delay. Count `/api/ticket/p/ARK-521` requests. Rewrite the file `ARK-521.md` with the problem `Second text`. Within 5 s assert `Second text` shows and `First text` does not. During the wait the loading status never reappears. `checkpoint(page, "ticket-reloaded")`.
4. Assert the route was fetched exactly once more after the edit.
5. Write a different ticket's file (an unrelated push). Wait 2 s. Assert no extra `/api/ticket/p/ARK-521` request was sent.
6. Rewrite `ARK-521.md` so it does not parse. Within 5 s assert the unreadable alert shows, not the loading status. `checkpoint(page, "ticket-unreadable")`. Rewrite it with the problem `Third text`; within 5 s assert `Third text` shows and the alert is gone.

## Expected results

- The title shows before the document arrives, and a loading status shows until it does.
- An edit of the ticket file shows on the open page within 5 s, with no flash of the loading state.
- One refetch per change of this ticket; none for an unrelated push.
- An unreadable file shows an alert; a repair shows the text again within 5 s.

## Screenshot checkpoints

- `ticket-loading`: title and header visible, loading status in place of the text.
- `ticket-loaded`: first text and criteria shown.
- `ticket-reloaded`: second text shown after the file edit.
- `ticket-unreadable`: the unreadable alert under the title.
