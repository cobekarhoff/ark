---
id: ARK-T277
title: "ARK-T277 the ARK-284 rules stay: 200 entries a page with Load more, and while the worker reads a 200 MB session file with a result read queued, / and /nope answer with a p95 below 200 ms"
level: integration
technique: performance boundary (p95 under load), boundary values of the page (200, 201 entries), state transition (page 1 to Load more)
priority: high
risk: "a page holds more or fewer than 200 entries or Load more does not append; the result read runs on the request thread or blocks the hub, so `/` and `/nope` answer slowly while a 200 MB file is read; a result read queued on the transcript slot starves page reads; pages with 20 KB arguments grow without a measure; the project checks (tests, typecheck, lint, format) fail after the change"
status: active
changed_by: 2026-11-13-ARK-339-1
---

## Objective

Prove that the new limits and the new route keep the budgets of ARK-284. Serves ARK-324/AC7.

Expected: While the usage worker thread reads a 200 MB session file, the system shall answer `/` and `/nope` with a p95 below 200 ms, and a transcript page shall hold 200 entries with Load more for the rest.

## Preconditions

- The setup of `test/hub.test.ts` "ARK-284-AC7 while the worker thread reads a 200 MB session file": a 200 MB session file of a run, 250 messages.
- A second file of 201 entries whose tool calls have 20 KB arguments.
- A project checkout where the change is built.
- A 3-repo run (the fixture of ARK-T358) in the hub project, so the snapshot carries the repos block while `/` is sampled.

## Steps

1. Open the 200 MB file's page 1 and, while it is read, sample `/` and `/nope` repeatedly; compute the p95.
2. With the 3-repo run present, sample `/` and `/nope` again under the same load; compute the p95.
3. Repeat with a result request for a call near the end of the same file queued behind the page read; sample again.
4. Read page 1 of the 201-entry file: entries count, the cursor; read the next page; record the response size of page 1.
5. Read the page of the largest real session file in `ARK_HOME` and record its size, for the validator report.
6. Run `bun test`, `bun run typecheck`, `bun run lint` and `bun run format:check`.

## Expected results

- The p95 of `/` and `/nope` is below 200 ms in steps 1 to 3.
- Page 1 has 200 entries and a cursor; the next page has the remaining ones; no entry is lost or doubled.
- The response size of the 20 KB-argument page is recorded and the page answers.
- The result request of step 3 answers (found) and its read does not delay `/`.
- All four commands exit 0, with the old ARK-284 tests changed only where a new limit required it.

## Screenshot checkpoints

None, timing and route output.
