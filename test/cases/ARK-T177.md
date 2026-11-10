---
id: ARK-T177
title: "ARK-T177 Code loads shiki in its own chunk on the first code block: Home's first load requests none, the block is plain monospace until the chunk loads, then it has coloured spans for 9 languages"
level: e2e
technique: request accounting, state transition (plain, loading, coloured), equivalence classes of languages
priority: high
risk: "shiki joins the entry chunk (Markdown imports Code statically, or splitting is off) and slows every first load, the loading state is blank or broken, a language lacks colour, or a block never colours"
status: active
changed_by: 2026-11-09-ARK-323-1
---

## Objective

Prove the lazy shiki chunk and the token spans. Expected: The system shall request no shiki chunk on the first load of Home; when the first code block shows, the system shall load the chunk and colour the tokens as spans.

## Preconditions

- Hub playwright fixture: Home with a gate question that holds markdown (no code block); a `.md` run file with one fenced block each for ts, js, json, yaml, bash, diff, python, markdown and gherkin.
- The test holds the chunk response with a `page.route` handler (the handler sees the request, so the request has already been made), then fulfils it.

## Steps

1. Record requests. Open Home. Wait for the gate question. Assert no request path matches a shiki chunk (a chunk other than the entry bundle) and the entry bundle is the only script.
2. Open the run file with the chunk route held. Assert the route handler received the shiki chunk request now (none while Home was displayed). While the response is held, assert each block shows its text as plain monospace with no coloured token span.
3. Release the held response. Assert the blocks then get coloured spans.
4. For each of the 9 languages assert the block holds `span` elements with at least two distinct colours in a light and a dark scheme, with the colours differing between the schemes.
5. Assert the chunk is served as JavaScript from `/assets/` (proof that `splitting: true` built it), not found by reading source text.

## Expected results

- First load of Home: no shiki chunk.
- Before the chunk: plain monospace; after: coloured spans in all 9 languages, a different theme in light and dark.

## Screenshot checkpoints

`checkpoint(page, "code-plain-before-chunk")` and `checkpoint(page, "code-coloured")` before their assertions.
