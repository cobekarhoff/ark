---
id: ARK-T272
title: ARK-T272 the transcript result route answers the full text of one tool result up to 64 KB with its size and whether it was cut, from the worker thread, and answers 404 for an unknown call, a call with no result yet and a file outside the run
level: integration
technique: boundary values (64 KB, 64 KB + 1, 100 KB), equivalence classes of call (found, unknown, no result yet) and file (in the run, foreign), equivalence classes of harness
priority: high
risk: "the route answers 200 for an unknown call or a foreign file such as `/etc/passwd`; a result is cut at the wrong size or does not say it was cut; the full text differs from the text the page's first line was cut from in one harness (Codex `{output}` JSON unwrapping, Claude block content, omp joined blocks); a call that has no result yet answers 200 with empty text; the handler reads the file itself, or a slow read stops the hub from answering other routes; a crashed worker leaves the request hanging"
status: active
changed_by: 2026-11-12-ARK-324-1
---

## Objective

Prove `GET /api/run/<run>/transcript/result?file=<file>&call=<id>`. Serves ARK-324/AC2. Settled: a call with an id but no result record answers 404, as an unknown call does. Size and the 64 KB cap count characters.

Expected: When a result is requested for a call of a session file of the run, the system shall answer the full text of the result up to 64 KB with its size and a cut flag, and when the call is unknown, has no result yet, or the file is outside the run, the system shall answer 404.

## Preconditions

- Hub test server and the session fixtures of ARK-T271 for omp, Claude and Codex.
- A tool call per harness with a multi-line result (the `tail` on line 3), a tool call with a JSON result, a tool call with a result of 64 KB exactly, one of 64 KB + 1 and one of 100 KB, and a tool call with no result record (a live step).
- Codex results in the three shapes of `codexResult`: plain string, JSON `{output}` and a failed one with an exit code.
- The route is read through the same server as the page, with the usage worker thread running.

## Steps

1. For each harness, read the result of the found call from the page's call id.
2. Read the 64 KB, 64 KB + 1 and 100 KB results.
3. Ask for a call id that is not in the file.
4. Ask for the call with no result record.
5. Ask for a file outside the run (`/etc/passwd`, a `..` path) and a session file of another run, with a valid call id.
6. Ask for a result while the worker is made to crash, as the ARK-284 worker-crash test does, then ask for the next page.
7. Run `bun test test/hub.test.ts`.

## Expected results

- A found result answers 200 with the whole text including the `tail` line, its size and `cut: false`; its first line equals the first line the page carries for the same call in each harness (Codex `{output}` is unwrapped the same way).
- The 64 KB result is whole and not cut; 64 KB + 1 and 100 KB come cut to 64 KB, with the size of the full text (so 100 KB shows as 100 KB) and `cut: true`.
- A JSON result arrives as its text unchanged, so the page can parse it.
- An unknown call, a call with no result yet, a foreign file and a file of another run all answer 404 with no result text.
- The request handler reads no file: the read goes through the worker, which the test shows by making the worker fail (the route answers 502 as the page route does) and by the hub still answering `/` while a result read runs.
- After the crash the next result request answers.

## Screenshot checkpoints

None, route output.
