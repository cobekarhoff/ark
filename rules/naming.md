---
description: "Naming gate for code: full words for identifiers, commands, flags, gate names and filenames"
---

# Naming gate

Use full words for anything that holds a domain object or lives beyond a few lines: `worktree`, `repoConfig`, `context`, `pullRequest`, `testCase`, `event`, `result`, `suite`, `runNumber`. Not `ws`, `cfg`, `ctx`, `pr`, `tc`, `ev`, `res`, `n`.

Short names are fine for loop indexes (`i`, `j`), universal names (`id`, `url`, `json`) and a one-line `catch (err)`.

Commands, flags, gate names and filenames use full names with no aliases: `ark worktree create`, `ark merge-request open`, gates `criteria`, `plan`, `escalation`.

This rule covers code only. Prose follows the Google developer documentation style guide: common abbreviations such as CLI, PR, MR, CI, API, UI, E2E, SHA and AC are never spelled out. AC IDs such as `ARK-013-AC2` are a data format and stay as they are.
