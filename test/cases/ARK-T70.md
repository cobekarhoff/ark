---
id: ARK-T70
title: ARK-T70 .pr-writing.toml holds the five Ark keys plus checks, PR_WRITING_<KEY> overrides it, a bad key is refused
level: integration
technique: decision table (file only, file plus env, env only) with typed values (list, boolean, string) and an invalid-key class
priority: high
risk: the TOML loader drops a key, an env value for a list or boolean stays a string, the file wins over the environment, a misspelled key is silently ignored so a typo disables sensitive_paths, or the repo's own .pr-writing.toml does not parse
status: active
changed_by: 2026-11-07-ARK-317-1
---

## Objective

Prove the standalone config: `.pr-writing.toml` at the repo root holds `reviewers`, `tier_floor`, `sensitive_paths`, `agent_authored`, `title_prefix` and `checks`; `PR_WRITING_<KEY>` environment variables override it with the right types; an unknown key is refused. Serves ARK-317/AC4.

Expected: If `.pr-writing.toml` has a key outside the valid list, then `review.ts` shall exit 1 and name the key and the valid keys.

## Preconditions

- A fixture git repo with a `.pr-writing.toml` that sets `reviewers = ["ana", "bo"]`, `tier_floor = 2` (an integer, the Ark config contract: 0 to 3), `sensitive_paths = ["db/**"]`, `agent_authored = true`, `title_prefix = "feat(TICKET): desc"` and `checks = ["true"]`.
- A variant file with the misspelled key `reviewrs = ["ana"]`.
- Variant files with `tier_floor = 0`, `tier_floor = 3`, `tier_floor = 4` and `tier_floor = "T2"`, matching the boundaries of ARK-T58.
- The repo's own `.pr-writing.toml` at the Ark repo root.
- A clean environment: no `PR_WRITING_*` variables set, except where a step sets them.
- A way to read the effective config: the lib loader called from a throwaway script, and `review.ts` for the bad-key refusal.

## Steps

1. Load the fixture config with no environment variables. Read each key and its type.
2. Set `PR_WRITING_REVIEWERS=cy,di`, `PR_WRITING_AGENT_AUTHORED=false`, `PR_WRITING_TITLE_PREFIX="fix(TICKET): desc"`, `PR_WRITING_TIER_FLOOR=3`. Load again.
3. Load a repo with no `.pr-writing.toml` and one environment variable set.
4. Set `PR_WRITING_AGENT_AUTHORED=maybe`. Load. Then clear it and set `PR_WRITING_TIER_FLOOR=high`, then `PR_WRITING_TIER_FLOOR=4`, loading each time. Also load each `tier_floor` variant file.
5. Run `review.ts` in the repo with the `reviewrs` variant. Capture exit code, stdout and stderr.
6. Parse the repo's own `.pr-writing.toml`. List its keys.
7. Run `bun test test/pr-writing-skill.test.ts`.

## Expected results

- Step 1: `reviewers` is the list `["ana","bo"]`, `sensitive_paths` a list, `agent_authored` the boolean true, `tier_floor` the number 2 (typeof number, not the string `"2"`), `title_prefix` a string, `checks` a list.
- Step 2: `reviewers` is `["cy","di"]` (a list, not the string `cy,di`), `agent_authored` is the boolean false, `tier_floor` is the number 3 (typeof number; a string would make `tier_floor <= tier` comparisons wrong), `title_prefix` is `fix(TICKET): desc`. Keys not overridden keep the file value.
- Step 3: the environment value applies with no file present; other keys take their defaults.
- Step 4: the load is refused with a message naming `PR_WRITING_AGENT_AUTHORED` and the bad value; `review.ts` run with it exits 1. `PR_WRITING_TIER_FLOOR=high` and `=4` are each refused naming the variable. Files with `tier_floor` 0 and 3 load as the numbers 0 and 3; files with 4 and `"T2"` are refused, as ARK-T58 does for `ark.yml`.
- Step 5: exit 1, stderr contains `unknown key "reviewrs"` and the valid keys `reviewers, tier_floor, sensitive_paths, agent_authored, title_prefix, checks`, stdout is `{"error":"bad config key","key":"reviewrs"}`, and no check ran.
- Step 6: the repo's file parses and its keys are all in the valid list (`checks` present). Whether `one_way_paths` is valid is the plan's decision; this case does not assert it.
- `bun test test/pr-writing-skill.test.ts` exits 0.

## Screenshot checkpoints

None. The surface is CLI output and a config file; no screenshot applies.
