---
description: "Naming gate for code and docs. Full words for identifiers and commands, abbreviations spelled out at first use. The Ark reviewer checks every change against it."
---
# Naming gate

Write full words wherever a reader meets a name.

## Code and command names

Full words for anything that holds a domain object or lives beyond a few lines: `worktree`, `repoConfig`, `activeRunFile`, `context`, `pullRequest`, `testCase`, `event`, `result`, `suite`, `runNumber`. Not `ws`, `cfg`, `ctx`, `pr`, `tc`, `ev`, `res`, `n`.

Short names stay for loop indexes (`i`, `j`), universal names (`id`, `url`, `json`) and a one-line `catch (err)`.

Commands, flags, gate names and filenames carry full names with no aliases: `ark worktree create`, `ark merge-request open`, gates `setup`, `criteria`, `plan`, `escalation`, `evidence`. Not `ark ws create`, `ark mr open`, `G1`.

## Prose, help, errors and prompts

Spell out an abbreviation at its first use in each document, prompt, help screen or error, then use the short form:
- "acceptance criterion (AC)" and "merge request (MR)", then AC and MR.
- Every other abbreviation the same way: "end-to-end (E2E) test", "continuous integration (CI)", "Oh My Pi (OMP)".
- A priority scale (P0 to P3), tier or milestone is stated inline where a prompt uses it: "P0 (must fix) to P3 (minor)".

Leave AC IDs such as `ARK-013-AC2` as they are: they are a data format.

## Check before you finish

Reread each name and abbreviation you added. Does a first-time reader know what it is? If not, write the full word.
