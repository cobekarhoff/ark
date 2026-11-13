---
id: ARK-T340
title: "ARK-T340 the Conversation tab opens from the run page, keeps the sub routes, and shows the design reference files"
level: integration
technique: "state transition (route: run, conversation tab, sub route, back) with equivalence classes of reply state (ok, loading, truncated, stale)"
priority: high
risk: "the tab is missing or breaks `#/run/<run>` and the transcript/plan sub routes; docs/design/agent-comms/ lacks hybrid-2.html or data.js; the `loading`, `truncated` or `stale` states of GET /api/run/<run>/conversation show an empty or wrong trace without a notice"
status: active
changed_by: 2026-11-13-ARK-345-1
---

## Objective

Prove the run page has a Conversation tab fed by GET /api/run/<run>/conversation, that the tab lives in the URL hash without breaking old routes, and that the design reference is in the repo.

## Preconditions

- A fixture run served by the hub with a conversation (Master Chief, run lead, workers).
- Fixture variants: `directory: "loading"`, `truncated: true`, `stale: true`.
- Viewport 1440x900.

## Steps

1. Check that docs/design/agent-comms/hybrid-2.html and data.js exist and are non-empty.
2. Open `#/run/<run>`; the existing Body renders. Click the Conversation tab; the hash changes and the trace and feed render.
3. Reload on the tab hash: the tab is still selected. Open an existing sub route (a transcript) and go back: the tab state is right.
4. Request each reply variant (loading, truncated, stale) and open the tab.

## Expected results

- The files exist; the tab renders from the conversation reply; reload keeps the tab.
- `#/run/<run>` and every sub route still open as before.
- Each of `loading`, `truncated` and `stale` shows a visible notice and the trace still draws what it has.

## Screenshot checkpoints

Conversation tab open (dark); the `truncated` notice.
