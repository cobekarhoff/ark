---
id: ARK-T660
title: ARK-T660 the hub Companions page shows one row per companion with state, last wake, trigger and cost, its latest ideas and proposed tickets, and approve, dismiss with a reason and ask each do their write from the page
level: e2e
technique: state transition (populated, no companions, listed but nothing yet, unknown cost, Orca unavailable) and one pass of each action (approve a ticket, dismiss a ticket, dismiss an idea, ask from a ticket and from an idea) in a real browser against a real hub
priority: high
risk: "the page shows `stopped` when Orca is down instead of `unavailable`; a cost that has an unpriced message shows as a sum or as $0 instead of `unknown`; approve changes a ticket other than the one clicked, or queues it (creates an Orca task) instead of only setting status ready; a dismiss without a reason is accepted, or the reason is not in dismissed.md where the companion reads it; ask runs with Orca down and fails with no message; agent-written text in ideas.md or a ticket title runs as HTML in the page; a dismissed item still offers its actions after a reload; a reason or question that is within the page's character limit but over the server's byte limit (multibyte text) is dropped with a silent 413 and no message in the row"
status: active
changed_by: 2026-11-14-ARK-480-1
---

## Objective

Prove the page `#/companions` lists each companion of `ark.yml` with its state, last wake, trigger and cost, shows its latest ideas and proposed tickets under it, and that approve, dismiss with a reason and ask each work from the page and write what they promise. Serves ARK-480/AC7.

## Preconditions

- A real hub started by the Playwright helpers (`test/pw/helpers.ts`) on a temp `ARK_HOME` and a fake `orca` (the real `ark` runs behind the page's actions), a controlled page clock, a project `p` with these companions: `cortana` (live worker started by a real `ark companions sync` against the fake `orca` before the page opens, session file with priced messages, wake times in `companions/cortana/`, three ideas in `ideas.md` one of which holds `<img src=x onerror=...>` text, two proposed tickets with `source: cortana`), `gardener` (live, session with one unpriced message), `quiet` (listed, no worker record, no ideas, no tickets), and a ticket of `p` at `status: proposed` that has no `source` line (a human's idea).
- A fake `orca` that can be set to fail `worker-list` (Orca unavailable) and that logs `send` and `task-create` calls.

## Steps

1. Open `#/companions`. Read each row, then the sections under the table. Reach the page by the nav tab and by typing the URL; press Esc after each way in.
2. Read the states in turn: no companions in `ark.yml`; only `quiet` listed; Orca set to fail.
3. Approve the first proposed ticket of `cortana`.
4. Dismiss the second proposed ticket: first with an empty reason, then with a reason.
5. Dismiss an idea with a reason. Reload the page.
6. Ask from a proposed ticket and from an idea, a question each. Then ask with Orca failing.
7. Limits, with multibyte text (each character of 4 UTF-8 bytes, such as an emoji): dismiss a proposed ticket with a reason of exactly 400 characters (1600 bytes); dismiss another item with a reason of 401 characters; ask with a question of exactly 400 characters and with one of 401 characters. Read the message in the row after each refusal.

## Expected results

- Step 1: one row for each of `cortana`, `gardener`, `quiet`, in `ark.yml` order. `cortana`: state `running`, the time and trigger of its last wake, its triggers, and a cost equal to the sum of its priced messages. `gardener`: cost shows `unknown`, never `$0` or a partial sum. `quiet`: state not running, last wake `none`, cost `unknown` or `$0` as its empty session says, and nothing under it. Ideas and proposed tickets of a companion are listed under it by title with the companion's name; the ticket with no `source` line is not listed on this page (the Roadmap Review list shows it). The `<img onerror>` idea shows as text, no element is created and no handler runs. Both ways in show the same page; Esc leaves it as it does for the other views.
- Step 2: with no companions the page says so and has no table; with Orca failing every row says `unavailable`, not `stopped`, the Ask buttons are off, and Approve and Dismiss stay on.
- Step 3: the ticket file's `status:` line is `ready` and no other byte or file changed; the row shows `approved` at once; the fake `orca` log has no `task-create` and no `send` call.
- Step 4: an empty reason is refused with a message on the form and nothing is written; with a reason, `companions/cortana/dismissed.md` gets one entry that holds the ticket id and the reason and the time; the row shows `dismissed`.
- Step 5: `dismissed.md` gets an entry that holds the idea reference and the reason; after the reload the dismissed idea and the dismissed ticket no longer offer Approve, Dismiss or Ask. [INFERENCE: the plan must decide whether a dismissed item leaves the list or stays marked; the mockup keeps it with its status line until the next refresh, and the case asserts only that it offers no action after the reload.]
- Step 6: Ask runs `ark companion ask` for that companion: the real `ark companion ask` runs and the fake `orca` log has one `send` to its worker, which holds the question and names the item it was asked from; with Orca failing the form shows the refusal and nothing is sent.
- Step 7: the three POST routes accept a body up to 4096 bytes (a 400-character reason or question in 4-byte characters is about 1600 bytes plus the JSON around it, and passes) and refuse a reason or question over 400 characters, counted in characters and checked on the server. The 400-character reason is accepted: `dismissed.md` holds it whole and the row shows `dismissed`. The 400-character question is accepted: the fake `orca` log has one `send` that holds it whole. The 401-character reason and question each get a refusal with a visible message in the row (it names the 400-character limit), nothing written, no `send` logged, and never a silent 413 or an unchanged row.
- The page sends no write (non-GET) request except the one an action sends; its live refresh (`/events`, polling) may make GET requests. A click on Approve, Dismiss or Ask sends exactly one POST.

## Screenshot checkpoints

- `#/companions` populated (rows, proposed tickets, ideas), light and dark, at 1280 px and 720 px.
- `#/companions` with Orca unavailable, and with the dismiss form open and its refusal message.
- The unknown-cost pill.
