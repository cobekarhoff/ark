---
id: ARK-T173
title: "ARK-T173 Markdown makes no HTML from text: script and img onerror show as text, only http, https, / and # links are links, and no hub file uses dangerouslySetInnerHTML"
level: e2e
technique: equivalence classes of inputs (raw HTML in every token position, link schemes, case and whitespace variants), source scan
priority: high
risk: "raw HTML from a run file, ticket or gate question runs script or creates an element, or a javascript: link, a mixed-case or whitespace-padded variant becomes a clickable link (XSS)"
status: active
changed_by: 2026-11-09-ARK-323-1
---

## Objective

Prove the renderer never makes HTML or an unsafe link. Expected: The system shall show raw HTML as text and make no element from it; a link shall be a link only when its target starts with http://, https://, / or #.

## Preconditions

- Hub playwright fixture: a `.md` run file or ticket section holding `<script>window.__xss=1</script>`, `<img src=x onerror="window.__xss=2">`, the same tags inside a list item, a table cell, a blockquote and link text, links `[a](javascript:alert(1))`, `[b](JaVaScRiPt:alert(1))`, `[c](  javascript:alert(1))`, `[d](//evil.example)`, `[e](data:text/html,x)`, and safe links `http://`, `https://`, `/`, `#` targets.

## Steps

1. Open the surface that renders the fixture.
2. Assert the tag text `<script>` and `<img ... onerror=...>` shows as text in every position.
3. Assert the rendered area has no `script` element and no `img` element, and `window.__xss` is undefined, after waiting for the page to settle.
4. Assert these four unsafe candidates show as text with no `a` element: `[a](javascript:alert(1))`, `[b](JaVaScRiPt:alert(1))`, `[c](  javascript:alert(1))`, `[e](data:text/html,x)`. Assert `[d](//evil.example)` follows the AC as written (target starts with `/`): it is an `a` element. Assert the four safe links (`http://`, `https://`, `/`, `#` targets) are `a` elements with their href.
5. Scan: read every file under `hub/` and assert none contains `dangerouslySetInnerHTML`.

## Expected results

- No element or script is made from raw HTML; the text shows as written.
- Only http://, https://, / and # targets are links.
- No `hub/` file uses `dangerouslySetInnerHTML`.

## Screenshot checkpoints

`checkpoint(page, "raw-html-as-text")` and `checkpoint(page, "links")` before their assertions.
