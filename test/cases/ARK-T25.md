---
id: ARK-T25
title: ARK-T25 pr_writing config block is validated
level: integration
technique: equivalence classes and boundary values on tier_floor (valid 0-3, invalid below 0, above 3, non-integer) and one wrong type for each other key
priority: medium
risk: a bad tier_floor loads and breaks the lint tier later, a valid key is refused, or the defaults are missing
status: active
changed_by: 2026-11-06-ARK-316-1
---

## Objective

Prove that `cli/config.ts` accepts a `pr_writing:` block and validates it. Serves ARK-316/AC9.

Expected: When `tier_floor` is not valid, the system shall refuse the config.

## Preconditions

- A temporary `ARK_HOME` and project folder.
- Config A: a `pr_writing:` block with `reviewers`, `tier_floor: 1`, `sensitive_paths`, `one_way_paths`, `agent_authored: false` and `title_prefix`.
- Config B: a `pr_writing:` block with only `reviewers`.
- Config C: no `pr_writing:` block.
- Configs D, E, F, G: `tier_floor` set to `5`, `-1`, `1.5` and `"high"`; configs for the boundaries `0` and `3`.
- One config per other key, each with a wrong type and the rest valid: H `reviewers: "alice"` (a string, not a list); I `reviewers: [1, 2]` (items not strings); J `sensitive_paths: "cli/*"`; K `one_way_paths: {}`; L `agent_authored: "yes"`; M `title_prefix: 42`.

## Steps

1. Load config A and read the block.
2. Load config B and C and read the defaults.
3. Load configs with `tier_floor` 0 and 3.
4. Load configs D, E, F and G. Read the error.
5. Load configs H to M. Read the error of each.
6. Run `bun test`.

## Expected results

- Config A loads; all six keys are present with the values given.
- Config B gives `tier_floor` 0 and `agent_authored` true. Config C loads with the same defaults.
- `tier_floor` 0 and 3 load. 5, -1, 1.5 and `"high"` are refused, and the message names the key `tier_floor`.
- Each of H to M is refused, and the message names its key: `reviewers` (H and I), `sensitive_paths`, `one_way_paths`, `agent_authored`, `title_prefix`.
- `bun test` exits 0.

## Screenshot checkpoints

None. The surface is CLI output and Markdown text; no screenshot applies.
