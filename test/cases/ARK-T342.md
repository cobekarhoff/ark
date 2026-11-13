---
id: ARK-T342
title: "ARK-T342 the feed lists messages with avatar, role, time, Markdown body and Show more, threads, question cards, folded events, chips and search"
level: integration
technique: "equivalence classes (message kinds: plain, thread, question answered, question waiting, event) and boundary values (body at the cut, 2 vs 3 events in a row)"
priority: high
risk: "a message renders raw HTML from an agent body; long bodies are not cut or cannot expand; threads show every reply; a question card shows no answer or the wrong state; 3 events do not fold or 2 do; chips or search filter the wrong rows"
status: active
changed_by: 2026-11-13-ARK-345-1
---

## Objective

Prove each element of the AC2 feed: oldest-first order, avatar, role badge, time, subject, body through `Markdown` with 'Show more', thread collapse, question cards, event folding, type chips and search.

## Preconditions

- A fixture run with: messages in time order; one body long enough to be cut and one short; one body with Markdown and a `<script>`/HTML tag; a thread of 3 replies; an answered question (gate and answer text); a question with `answered: null`; one run of 2 Ark events and one run of 3 or more in a row.
- Viewport 1440x900.

## Steps

1. Open the Conversation tab; read the feed order.
2. For one message check avatar, role badge, time and subject; check the Markdown body renders (bold, list) and the HTML tag shows as text, not as an element.
3. Click 'Show more' on the long body: it expands; the short body has no button.
4. Check the thread shows 'N replies' collapsed and expands on click.
5. Check the answered question card shows 'You answered <gate>: <answer>' and the unanswered one shows 'Waiting for an answer from you'.
6. Check the 2 events stay as 2 quiet lines and the run of 3 or more folds into one line; expand the fold.
7. Click a type chip: only that type remains; clear it.
8. Type a word of one subject, then a word of one body, into the search box: each filters to its message.

## Expected results

- Messages are oldest first with all parts shown; the HTML in a body is escaped.
- 'Show more' works only on the cut body; the thread collapses to 'N replies'.
- Question cards show the answer or the waiting text; 2 events show as 2 lines and 3 or more fold into one.
- Chips and search narrow the feed by type, subject and body, and restore when cleared.

## Screenshot checkpoints

Feed top (dark); the answered and the waiting question cards; the folded events line.
