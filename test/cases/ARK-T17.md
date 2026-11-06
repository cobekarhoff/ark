---
id: ARK-T17
title: ARK-T17 ledger holds run data, or git and host data without a run folder
level: integration
technique: equivalence classes (run folder, no run folder) and decision table on the base fallback order
priority: high
risk: the ledger lists a fixed finding, drops evidence or a gate answer, picks the wrong base, or records a failed host probe as none, so every body built from it misstates the change
status: active
changed_by: 2026-11-06-ARK-316-1
---

## Objective

Prove that `ledger.ts` builds one ledger from a run folder, and the same shape from git and the host when there is no run folder, and that a failed host probe is `unknown`. Serves ARK-316/AC2.

Expected: When a host probe fails, the system shall record `unknown` and never `none`.

## Preconditions

- Fixture run folder with: `ticket.md` (problem, change, 2 ACs, `kind: bug`, `summary:`), `plan.yml` with a summary and risks, a `test.completed` event (AC1 passing, AC2 failing) and an earlier one with other statuses, `results/evidence/<test case id>/{base,head}/`, two gate answers (criteria, plan) in the events, a merge order with one `Depends on` line, a base and a head SHA.
- Findings: `findings/round-1.md` holds a P0 that a later `findings/round-2.md` closes with `No findings.`; a P2 in the latest file stays open; a P1 closed by a recorded fix decision.
- Fixture git repo with commits ahead of its base, a fake `gh` and `glab` on PATH that exit non-zero on every probe, and a repo MR template.

## Steps

1. Build the ledger for the fixture run folder.
2. Read: the ticket fields, the `plan.yml` summary and risks, per-AC status, evidence entries, open findings, merge order and `Depends on` lines, base and head SHA, the `git diff --shortstat` text and the answered gates.
3. Build the ledger for the fixture git repo with no run folder, where the fake host fails every probe.
4. Repeat step 3 for the base order: (a) an open MR exists with a target; (b) no open MR, `origin/HEAD` set; (c) no open MR, no `origin/HEAD`, host default branch known; (d) none of the three known.
5. Read the commit range, the three-dot diff, the template and the tracker refs of the git ledger, and the host-derived fields.
6. Run `bun test test/pr-writing.test.ts`.

## Expected results

- Run ledger: ticket fields (problem, change, ACs, `kind`, `summary`) are present; plan summary and risks are present; AC status is that of the LAST `test.completed` only (AC1 passing, AC2 failing); evidence lists each test case; SHAs and the shortstat match git; both gate answers are listed; the merge order and the `Depends on` line are present.
- Open findings hold only the latest-file P2. The P0 closed by a later `No findings.` and the P1 closed by a fix decision are absent.
- Git ledger has the same shape as the run ledger, with the commit range, the three-dot diff, the template and tracker refs filled from git.
- The base is taken in the order (a) open MR target, (b) `origin/HEAD`, (c) host default branch. Case (d) exits 1 with a message that asks for `--base`.
- Every field that came from a failed host probe is `unknown`. No field holds `none` because of a failed probe.
- `bun test test/pr-writing.test.ts` exits 0.

## Screenshot checkpoints

None. The surface is CLI output and Markdown text; no screenshot applies.
