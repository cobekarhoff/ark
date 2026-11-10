---
id: ARK-T172
title: ARK-T172 Markdown renders headings, paragraphs, bold, italic, inline code, links, nested lists, GFM tables, blockquotes, rules and fenced code as elements
level: e2e
technique: equivalence classes, one fixture holding every token class
priority: high
risk: "a token class renders as literal source text or as the wrong element, a nested list flattens, a table or code block widens the page instead of scrolling in its own box"
status: active
changed_by: 2026-11-09-ARK-323-1
---

## Objective

Prove that `Markdown` turns each supported markdown token class into its element. Expected: When `Markdown` reads text with headings, paragraphs, bold, italic, inline code, links, ordered, unordered and nested lists, GFM tables, blockquotes, rules and fenced code, the system shall render each as its React element.

## Preconditions

- Hub playwright fixture: ticket ARK-5xx whose Problem holds one fixture with every token class (a wide table and a long code line included).

## Steps

1. Open `#/ticket/<id>`.
2. Assert in the Problem section: h1..h3 headings, `p`, `strong`, `em`, inline `code`, `a` with its href, `ol` and `ul` with a nested `ul > li > ul`, a `table` with `thead`, `th` and `td`, `blockquote`, `hr`, and a fenced block (`pre`) with its text.
3. Assert no literal markdown marker (`**`, `##`, backticks, `|---|`) shows in the section text.
4. Assert the page has no horizontal overflow (`document.documentElement.scrollWidth <= clientWidth`) and the wide table and the code block scroll inside their own box.

## Expected results

- Every token class is its element with its text; no markup marker leaks.
- A wide table or code line scrolls in its box, never the page.

## Screenshot checkpoints

`checkpoint(page, "markdown-fixture")` before the element assertions; `checkpoint(page, "no-overflow")` before the overflow assertion.
