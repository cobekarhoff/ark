# ARK-292 AC2 load proof

Command: `ARK_LOAD_PROOF=1 bun test test/timeouts.test.ts -t 'ARK-292-AC2 heavy'`

Load: 2 x CPU count `sh -c 'while :; do :; done'` processes. 20 child runs, 4 at a time, of
`bun test test/worktree.test.ts test/run.test.ts test/sync.test.ts test/merge-request.test.ts test/tooling.test.ts -t 'ARK-276-AC4|ARK-278-AC3|ARK-165-AC3|ARK-165-AC4|ARK-155|ARK-175'`.

- 1-min load before: 9.11 (15:52:19)
- 1-min load after: 60.96 (15:57:05; the busy-loops were killed in `finally`, so this is the load average still decaying)
- Results: 20 of 20 children exit 0, none print `timed out` (41 expect() calls: 1 length check + 2 per child), 286.37 s.

An earlier run failed: bun applies the preload `setDefaultTimeout` to the first test file only, so ARK-276-AC4 timed out at 5000 ms. Fixed by calling `setDefaultTimeout(30_000)` in every test file.

proof: passed
