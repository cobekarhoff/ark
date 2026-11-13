---
id: ARK-T293
title: "ARK-T293 a secret-like command.log line is not in the posted body"
level: integration
technique: "equivalence classes on the secret kind (token, key, password, bearer, similar) with a clean control line, and boundary values (secret in line 20 of the tail and in line 21, outside the tail)"
priority: high
risk: "the last 20 lines of a head `command.log` go into a public MR body with a token, key, password or bearer value in them; only the line inside the tail matters, and the redaction must not erase the clean lines or the whole log"
status: active
changed_by: 2026-11-12-ARK-399-1
---

## Objective

Prove that a secret-like line of the head `command.log` (token, key, password, bearer or similar) is dropped or redacted before the body is built and posted, on both hosts. Serves ARK-399/AC4.

Expected: If a line of the head `command.log` tail is secret-like, then the posted body shall not contain its secret value.

## Preconditions

- Fixture run with one test case whose head `command.log` has 20 lines of which 5 are secret-like: `GITHUB_TOKEN=ghp_<fake>`, `Authorization: Bearer <fake>`, `password: <fake>`, `api_key=<fake>`, `export SECRET=<fake>`, plus clean lines (a path, a test name).
- Fake `gh` and fake `glab` that record the posted body; all fake secret values are unique strings, so a substring search finds them.

## Steps

1. Build the body for the fixture. Search it for each fake secret value.
2. Run `post_mr.ts --confirmed` on GitHub, then on GitLab. Search the recorded posted body for each fake secret value.
3. Read the clean lines in the block.
4. Move one secret line to line 21 from the end (outside the tail) and repeat step 1.

## Expected results

- No fake secret value appears in the built body or in the body recorded by the fake `gh` and the fake `glab`.
- The clean lines of the tail are still in the block.
- A line outside the last 20 never appears, secret or not.
- The block still has its result summary [INFERENCE: dropping a line must not drop the whole block].

## Screenshot checkpoints

None. The surface is Markdown text and recorded host calls from a fake; no screenshot applies.
