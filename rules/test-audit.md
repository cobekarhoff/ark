---
description: Authoring gate for every new or changed test, adapted from openclaw's test-audit skill. The Ark validator audits each AC-tagged test against it as its last step.
---
# Test authoring gate

Before adding or changing a test, answer these:
1. What observable behavior, invariant or independent contract does it protect?
2. What credible regression makes it fail?
3. Why does existing proof miss it? One contract has one owning test, at the strongest boundary that is practical. Add another layer only for a distinct transport or lifecycle risk. Extend tables or fixtures instead of copying setup.
4. Does it need an export, flag, wrapper or injection hook with no production caller? Then test at the real boundary instead.

Boundary, not "unit vs E2E":
- Pure deterministic logic (parsers, state projection, transition tables): test through its public entry point, e.g. the CLI process on fixture files. Those tests are fast and survive refactors.
- Behavior that crosses services, storage or UI: real integration or E2E against real or emulated dependencies you own. Never mock the thing being proven.
- A refactor that preserves behavior must not break the test.

Reject:
- tests that assert nothing, compare a value to itself, or take their expected value from the code under test
- copied inventories, export lists or source greps
- assertions on call shape, private predicates or mock calls
- mocks that supply the behavior the test asserts
- fixtures that fabricate ordering, receipts or persistence the owner never produces
- negative controls that pass on an unrelated guard
- names that promise behavior the test doesn't exercise

Keep, even when the test is slow or static:
- public API, protocol, config, migration, storage, security, default and ordering contracts
- a test that fails on baseline: treat it as a likely bug to fix, never a test to delete

Bug fixes: one regression test, at the owning layer, that fails before the fix for the intended reason and passes after. If you can't show the failing baseline, say so.
