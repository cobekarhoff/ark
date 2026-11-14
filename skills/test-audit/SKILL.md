---
name: test-audit
description: Audit the tests of an Ark project, or run a campaign that prunes them. Use when a ticket or a person asks to review, trim, merge or retire tests, to find junk tests, or to cut test time. It lists each test declaration, marks it keep, update, merge or delete, and proves that a deleted contract still has a keeper. Read-only unless a run's implementer step is cutting over.
---

# Test audit

Credit: adapted into Ark words from OpenClaw's test-audit skill, <https://github.com/openclaw/openclaw/blob/main/.agents/skills/test-audit/SKILL.md>. MIT License, Copyright 2026 OpenClaw Foundation.

Three things share the name `test-audit`. This skill (`/skill:test-audit`, this folder) tells you how to audit tests. `ark test-audit inventory` is the command that lists the test declarations of a project. `rules/test-audit.md` in the Ark repo is the test authoring gate, a short checklist for one new or changed test. This skill uses the command and the gate; it is neither.

## Pick the mode

- **Audit.** One area, one session, no run. Read [references/audit.md](references/audit.md). You edit no file: you write the ledger for the human.
- **Campaign.** Many lanes, deleted tests, proof that nothing was lost. It is an Ark run with a plan. Read [CAMPAIGN.md](CAMPAIGN.md). A run lead reads it when the ticket names a test audit campaign.

## Rules for both

- Ask what the test protects before you ask whether it is cheap. A test of a contract stays, even when it is slow or static.
- Take every command from the project: `suites` and `checks` in `$ARK_HOME/projects/<project>/ark.yml`, and `test_case_source` (`local` is the only value: the cases are files under `test/cases/`). Never copy a command from another project, and never assume a package manager.
- The inventory reads only suites with `parser: bun`. A suite with another parser needs the manual lane inventory in `references/audit.md`.
- A deleted test needs a named keeper that proves the same contract. `CAMPAIGN.md` says how to prove it.
- A test that is red on the baseline may be a product bug. Write it down; never delete it to make a run green.
- Never put a secret, a token or a log with one in a ledger.
