---
id: ARK-T681
title: ARK-T681 the collapse of ARK-T680 changes no byte of a small body, and a body of exactly 65,535 or 65,536 characters at log keep 0 is not collapsed
level: integration
technique: boundary values (body at log keep 0 of exactly 65,535 and 65,536 characters) and a golden whole-body comparison (small plan, text written in the case from the output before the change)
priority: high
risk: the collapse starts on a body that fits, or changes the text of a body below the limit (a new line, a different blank line, a moved note), so the STALE01 body hash of every open MR moves for no reason; or it starts at `>=` or before the log tails are cut to none, so a body of 65,536 characters at keep 0 collapses
status: active
changed_by: 2026-11-14-ARK-507-1
---

## Objective

Prove the two things no other case proves: a small body is byte-equal to the body built before ARK-507, and the boundary of the collapse at log keep 0 is strict (`>` 65,536). Per-case blocks, the last 20 log lines, the Deleted bullets and the note about a log cut are owned by ARK-T287, ARK-T200 (c) and ARK-T364; this case does not repeat them. Serves ARK-507/AC1 ("below the limit the body is unchanged").

## Preconditions

- Row 1: the real `buildBody` on a literal ledger as in `baseLedger` of `test/pr-writing.test.ts`: kind `bug`, problem `Stale bodies.`, change `1. Fix it.`, plan cases `ARK-T1` and `ARK-T2`, each `base fail`, `head pass`, sha `abc1234def5678abc1234def5678abc1234def56`, a 3-line head log `ARK-T<n> line 1..3`, and a last `test.completed` with 10 passed, 1 skipped, base skipped 1 and 3 deleted tests (`test/b.test.ts` titled ``second `b` | pipe``, `test/a.test.ts` titled `first`, and one with no file titled `no file`). The literal expected body below was produced by `buildBody` before ARK-507 and is pasted into the test as written; it is not read from the code under test.
- Rows 2 and 3: one run built by `boundaryRun` in `test/pr-writing.test.ts` from `suiteRun(150)`, with 150 plan cases, 20-line logs and 4 deleted tests. The test rewrites its `AC2.md` evidence file with a pad of `x` characters, found by `padFor`, so that the body at log keep 0 is exactly 65,535 characters in row 2 and exactly 65,536 in row 3. Both are over the limit with 20 log lines, so the log tails are cut. Real ledger reader and `buildBody`. No mocks.

Literal expected body of row 1:

````
<!-- pr-writing:begin -->
> Written by an AI agent on behalf of @cobekarhoff, following their spec. @cobekarhoff has not reviewed it yet.

Refs: ARK-316. 2 files changed, 40 insertions(+).

## Problem

Stale bodies.

## What is different

- Fix it.

## Evidence

<details><summary>`ARK-T1`: base fail, head pass @ abc1234</summary>

Result: base fail, head pass @ abc1234

Log (last 20 lines of the head command.log):

```
ARK-T1 line 1
ARK-T1 line 2
ARK-T1 line 3
```

</details>

<details><summary>`ARK-T2`: base fail, head pass @ abc1234</summary>

Result: base fail, head pass @ abc1234

Log (last 20 lines of the head command.log):

```
ARK-T2 line 1
ARK-T2 line 2
ARK-T2 line 3
```

</details>

- Tests: 10 passed, 1 skipped (base 1), 3 deleted
  - Deleted: no file
  - Deleted: `test/a.test.ts` first
  - Deleted: `test/b.test.ts` second \`b\` \| pipe

## How to verify

- [ ] `git diff main...HEAD --stat`. Expect: 2 files changed, 40 insertions(+).

## Not done

- Nothing open.

## Risk and revert

Merge risk: low (script low, reviewer none).

- Verification: good. All ACs pass with evidence.
- Alignment: good. Every changed file is in the plan.
- Impact: good. No sensitive path and no interface callers.
- Rollback cost: good. No one-way path and no deleted file.

Door: two-way

Blast radius: 1 changed files in 1 repo(s)

Also changed, not in plan: none.

```text
# Revert, newest merge first
git revert -m 1 <merge sha of the MR for this repo>
```

## Acceptance criteria

<!-- pr-writing:end -->
````

## Steps

1. Build the body of row 1 and compare it with the literal expected body.
2. Build the body of rows 2 and 3 and measure the body at keep 0 before the cut (65,535 and 65,536). Count the `<details>` blocks that name a case, the `  - Deleted:` bullets, the `Log (last` label and the Tests line. Read the note about the log tails and the note about a collapse.

## Expected results

- The body of row 1 shall equal the literal expected body byte for byte.
- When the body at log keep 0 is 65,535 or 65,536 characters, the system shall not collapse: the body shall be at most 65,536 characters, shall hold one `<details>` block for each plan case and one `  - Deleted:` bullet for each deleted test, shall have no `Log (last` label, and shall carry the note about the log tails and no note about a collapse. A collapse at `>=`, or before the log tails are cut to none, fails this.

## Screenshot checkpoints

none: the proof is the Markdown text of the MR body.
