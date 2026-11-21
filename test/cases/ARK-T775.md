---
id: ARK-T775
title: ARK-T775 a scenario wait sees a marker file created while the fs.watch of the scenario home delivers no event, within a 1 s limit
level: integration
technique: error guessing (a lost watch event); boundary value on the limit (1 s from the call, so less than 1 s from the file's creation)
priority: high
risk: "the scenario `waitFor` of `test/test-lock.test.ts` sees a marker only through an `fs.watch` event again (the poll is dropped or never started, or runs only once at the call), so a marker whose watch event is lost under load never ends the wait and the scenario hangs; or the wait resolves before the marker exists"
status: active
changed_by: 2026-11-21-ARK-618-1
---

## Objective

Prove that a scenario wait resolves for a marker file that appears while no watch event for it is delivered. The case calls `waitForWithin` of the `scenario()` callback for its short limit; `waitFor` and `waitForWithin` share one poll (strategy S1: both call `waitForMarkers`) and differ only in the limit. Serves ARK-618/AC2.

Expected: When a marker file is created after a scenario wait started and the watcher of the home delivers no event, the wait shall resolve within 1 s of the file's creation.

## Preconditions

- The real `scenario()` helper of `test/test-lock.test.ts` with its temp home; no child process is started.
- `watch` of `node:fs` is replaced for this test only by a watcher whose listener never runs and whose `close()` does nothing, and restored after the test. `spyOn` on the `node:fs` namespace (`import * as fs from "node:fs"`) with `mockRestore()` in a `finally` does this: in Bun 1.4.4 a scratch test showed that the spy also replaces a named `import { watch } from "node:fs"`. `mock.module("node:fs")` is not used: it stays for the whole process. The stub supplies no wake-up, so only a poll can end the wait. If the implementer drops the watcher, the stub is never called and the case still holds; the test does not assert on the stub's calls.
- The test's own timeout is a few seconds (a named constant), so at base the wait fails at that timeout and not at 90 s. No `setTimeout(`, no `toBeLessThan(<3+ digits>)` (ARK-T126).

## Steps

1. In a scenario, start `waitForWithin(1000, "late-running")` (a limit of 1 s), and keep the promise.
2. Check that the wait is still pending (`Bun.peek.status(promise)` is `"pending"`), then write `late-running` into `home`.
3. Await the promise from step 1.

## Expected results

- Step 2: the wait is still pending before the file exists (the marker is not seen early).
- Step 3: the wait resolves. Its 1 s limit runs from the call in step 1, which is before the file was created, so a resolve proves the file was seen in less than 1 s from its creation without a measure of the time. A reject with the limit error fails the case.
- The test does not reach its own timeout.

Validator notes: at base the scenario `waitFor` sees files only through the watcher, so with the stub the wait never ends and the test fails at its own timeout, which is the red proof.

## Screenshot checkpoints

None. The surface is a resolved promise in a test file; no screenshot applies.
