---
status: accepted
date: 2026-11-05
supersedes: ADR 0006
---

# Test cases describe the product, and an AC is proven through them

An AC belongs to its ticket: a ticket writes its ACs as `AC1`, `AC2`, and another ticket names one as `ARK-243/AC1`. The old form `ARK-243-AC1` is the same AC. A done ticket's ACs never change, and no field replaces an AC.

A test case is a lasting statement of what the product does. It is one entry `test/cases/<KEY>-T<n>.md`, made with `ark test-case new <KEY> --run <run>`, and its ID starts the title of the test that runs it. An AC links to its test cases through `verified_by` in the ticket, many to many: one case can serve two ACs and one AC can need two cases. Each AC has a `method`: `test` (the default), `demonstration`, `inspection` or `analysis`. The key `test_case_source` in `ark.yml` says where entries live; only `local` exists.

This replaces the rule of [ADR 0006](0006-integration-and-e2e-proof-only.md). Any level can be a test case, but every AC with `method: test` needs at least one integration or E2E test case in `verified_by`. Prefer integration and E2E: a unit case must earn its place. `ark test` decides an AC from the results of its `verified_by` cases at every level. An old-scheme AC with no `verified_by` keeps the old tag path, and only integration and E2E results count for it.

The criteria gate opens on every run, so the human approves `method` and `verified_by` for each AC. A run plans each test case it touches as `add`, `update`, `reuse` or `retire`. A retired entry stays with status `retired` and a reason, and its code is deleted.

Old tests convert by conversion on touch: a test with an old AC id in its title keeps proving that one AC until a run changes it. A run whose diff touches it writes a test case, renames the title to start with the test case ID and names the case in the plan. The reviewer rejects a diff that leaves the title unchanged. We do not migrate old tests in bulk.

## Consequences

- Tests describe the product, not one AC of one ticket, and survive the ticket.
- Every run pays the cost of the criteria gate, also when the ticket has ACs.
- Each test runner parser reads test case IDs as well as old AC IDs: bun test names, a pytest `case` marker and behave tags.
