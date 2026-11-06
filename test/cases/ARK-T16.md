---
id: ARK-T16
title: ARK-T16 both entry points import each pr-writing module
level: integration
technique: equivalence classes (two entry points, four modules) and a negative search
priority: high
risk: a second builder of an MR title or body survives in cli/merge-request.ts or elsewhere, or one entry point skips a module, so the CLI and the skill write different bodies
status: active
changed_by: 2026-11-06-ARK-316-1
---

## Objective

Prove that `skills/pr-writing/lib/` holds one module set (`ledger.ts`, `body.ts`, `lint.ts`, `post.ts`) that both `cli/merge-request.ts` and the skill scripts import, and that no other file builds an MR title or body. Serves ARK-316/AC1.

Expected: When the repo is searched, the system shall have one module set that builds every MR title and body.

## Preconditions

- The worktree holds `skills/pr-writing/lib/ledger.ts`, `body.ts`, `lint.ts` and `post.ts`.
- At least one skill script under `skills/pr-writing/` exists next to `lib/`.
- `description()` is gone from `cli/merge-request.ts`.

## Steps

1. List the files in `skills/pr-writing/lib/`.
2. For each of the four modules (`ledger`, `body`, `lint`, `post`), resolve the import graph of `cli/merge-request.ts` and check for an import of that module.
3. Repeat step 2 for a skill script under `skills/pr-writing/` (entry point two).
4. Search every other source file of `cli/` and `skills/` for code that builds an MR title (`<ticket id>: <summary>`) or an MR body (the provenance line, the `Not done` heading, the markers `<!-- pr-writing:begin -->` and `<!-- pr-writing:end -->`), and for calls to `gh pr create` or `glab mr create` outside `post.ts`.
5. Run `bun test test/pr-writing.test.ts`.

## Expected results

- The directory holds exactly the four modules `ledger.ts`, `body.ts`, `lint.ts`, `post.ts`.
- `cli/merge-request.ts` imports all four. A skill script imports all four. A missing import from either entry point fails the case.
- No file outside `skills/pr-writing/lib/` builds an MR title or body or calls `gh pr create` or `glab mr create`.
- `bun test test/pr-writing.test.ts` exits 0.

## Screenshot checkpoints

None. The surface is CLI output and Markdown text; no screenshot applies.
