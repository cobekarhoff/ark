---
status: accepted
---

# An AC is proven only by integration or E2E tests passing at head

Every AC needs at least one test case, written into the plan and approved at the plan gate. The validator implements it as an integration or E2E test tagged with the AC's ID, and `ark test` requires it to pass at the head commit on the composed workspace. Unit tests never prove an AC: they are cheap to make pass and say little about whether the ticket works.

We dropped red-green proof, which ran each new test on the base commit to show it failed first. For E2E tests on a composed multi-repo workspace, that means building and starting the whole stack twice per run. It was the most complex part of the old CLI, and most of the protection it gave is already covered by your approving the test cases up front and by MR review.

## Consequences

- A test that would pass without the change can slip through. Retros track escaped defects so we can see whether that happens.
- Each test runner needs a parser that maps its native tags to AC IDs: bun test names, pytest markers and behave tags.
