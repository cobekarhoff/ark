---
id: ARK-T17
title: ARK-T17 ledger holds run data, or git and host data without a run folder
level: integration
technique: equivalence classes (run folder, no run folder) and decision table on the base fallback order, with successful and failing host probes kept apart
priority: high
risk: the ledger lists a fixed finding, drops evidence or a gate answer, picks the wrong base, or records a failed host probe as none, so every body built from it misstates the change
status: active
changed_by: 2026-11-06-ARK-316-1
---

## Objective

Prove that `ledger.ts` builds one ledger from a run folder, and the same shape from git and the host when there is no run folder, that each base fallback wins in its order, and that a failed host probe is `unknown`. Serves ARK-316/AC2.

Expected: When a host probe fails, the system shall record `unknown` and never `none`.

## Preconditions

- Fixture run folder with: `ticket.md` (problem, change, 2 ACs, `kind: bug`, `summary:`), `plan.yml` with a summary and risks, a `test.completed` event (AC1 passing, AC2 failing) and an earlier one with other statuses, `results/evidence/<test case id>/{base,head}/`, two gate answers (criteria, plan) in the events, a merge order with one `Depends on` line, a base and a head SHA.
- Findings: `findings/round-1.md` holds a P0 that a later `findings/round-2.md` closes with `No findings.`, and a P1 closed by a recorded fix decision. The latest file holds an open P2 and an open P3.
- Fixture git repo with commits ahead of its base and a repo MR template. Two fake `gh`/`glab` modes on PATH: a succeeding mode that answers each probe from a state file (open MR list, default branch), and a failing mode that exits non-zero on every probe.

## Steps

1. Build the ledger for the fixture run folder.
2. Read: the ticket fields, the `plan.yml` summary and risks, per-AC status, evidence entries, open findings, merge order and `Depends on` lines, base and head SHA, the `git diff --shortstat` text and the answered gates.
3. Build the ledger for the fixture git repo with no run folder, with the host in succeeding mode, for each row of this table. Each row sets all three sources at once, so a wrong order picks a different base:

   | Row | Host MR response | `origin/HEAD` | Host default branch | Expected base |
   | --- | --- | --- | --- | --- |
   | a | open MR targeting `release/2` | `main` | `develop` | `release/2` |
   | b | no open MR (empty list) | `main` | `develop` | `main` |
   | c | no open MR | not set | `develop` | `develop` |
   | d | no open MR | not set | host answers with no default | none: exit 1 asking for `--base` |

4. Build the ledger for the same repo with the host in failing mode, for: (e) `origin/HEAD` set to `main`; (f) `origin/HEAD` not set.
5. Read the commit range, the three-dot diff, the template and the tracker refs of the git ledger, and each host-derived field.
6. Run `bun test test/pr-writing.test.ts`.

## Expected results

- Run ledger: ticket fields (problem, change, ACs, `kind`, `summary`) are present; plan summary and risks are present; AC status is that of the LAST `test.completed` only (AC1 passing, AC2 failing); evidence lists each test case; SHAs and the shortstat match git; both gate answers are listed; the merge order and the `Depends on` line are present.
- Open findings hold exactly the latest-file P2 and P3. The P0 closed by a later `No findings.` and the P1 closed by a fix decision are absent.
- Git ledger has the same shape as the run ledger, with the commit range, the three-dot diff, the template and tracker refs filled from git.
- Rows a, b and c take base `release/2`, `main` and `develop`. Row d exits 1 with a message that asks for `--base`. In row b the MR field is `none` because the probe succeeded and found no MR.
- Row e: the base is `main` (from git, no host needed); the MR-target field and the host default branch field are `unknown`; no field holds `none`. Row f exits 1 asking for `--base`, and its host-derived fields are `unknown`, not `none`.
- `bun test test/pr-writing.test.ts` exits 0.

## Screenshot checkpoints

None. The surface is CLI output and Markdown text; no screenshot applies.
