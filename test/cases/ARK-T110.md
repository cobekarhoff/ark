---
id: ARK-T110
title: ARK-T110 ark chief state has no close-check section and flags an interview due at 10 closed runs since the newest interview file
level: integration
technique: boundary values (9 vs 10 closed runs) plus equivalence classes of the interviews folder (missing, empty, one file, several files)
priority: high
risk: ark chief state still lists closed runs with an empty Close check; or the interview-due count ignores the newest file in interviews/, counts all closed runs after an interview, counts open runs, or flips at the wrong threshold (9 due, or 10 not due)
status: active
changed_by: 2026-11-08-ARK-327-1
---

## Objective

Prove that `ark chief state` prints no section for closed runs with an empty Close check, and prints an interview-due line from the number of closed runs since the newest file in `<ARK_HOME>/projects/<project>/interviews/`: due at 10 or more, not due at 9.

## Preconditions

- Fixture project as in `test/chief.test.ts` (temporary `ARK_HOME`, fixture workspace repo, fake `orca` on `PATH`), run through the real CLI process (`ark chief state --project <project>`), no import of the code under test.
- Run folders are created with the real `appendEvent` (`run.started`, then `run.closed`). Each closed run's `run.closed` time is controlled by the fixture, either by writing the event `ts` in `events.ndjson` of the fixture run or by setting file mtimes, so "since the newest interview file" is decided by fixture times and never by the code under test. The "since" reference is the modification time of the newest file in `interviews/`; the fixture sets it with `utimes`.
- Every closed run in the fixture has a `retro.md` whose `## Close check` heading is empty (`- Biggest pain:` and so on), as the old fixture had. At least one open run exists and must never be counted.
- Cases D1 to D6 each use a fresh `ARK_HOME` project folder:
  - D1: `interviews/` folder missing; 10 closed runs.
  - D2: `interviews/` folder missing; 9 closed runs.
  - D3: `interviews/` exists and is empty; 10 closed runs.
  - D4: `interviews/` holds one file; 4 closed runs before its time and 10 after.
  - D5: `interviews/` holds one file; 10 closed runs before its time and 9 after.
  - D6: `interviews/` holds two files, an old one and a newer one; 10 closed runs between the two file times and 3 after the newer one (counting from the older file would give 13 and wrongly mark it due).

## Steps

1. For each of D1 to D6 run `ark chief state --project <project>`. Assert exit code 0 and empty stderr.
2. For each run assert the output has no heading `## Closed runs with an empty Close check` and does not contain the text `Close check` anywhere.
3. For each run read the interview-due line of the output (the line that mentions the interview and a count).
4. Assert the other sections still appear: `Open runs` lists the open run and does not list any closed run.

## Expected results

- When `ark chief state` runs, the system shall not print a section for closed runs with an empty Close check, whatever the content of their `retro.md`.
- When `<project>/interviews/` is missing or empty, the system shall count all closed runs: D1 prints 10 and due; D2 prints 9 and not due; D3 prints 10 and due.
- When `<project>/interviews/` holds files, the system shall count only closed runs after the newest file: D4 prints 10 and due; D5 prints 9 and not due; D6 prints 3 and not due.
- The system shall mark the interview due when the count is 10 or more, and not due when it is 9 or fewer.
- The system shall not count open runs.

## Screenshot checkpoints

none: integration case on CLI text output; no UI surface.
