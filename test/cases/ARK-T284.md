---
id: ARK-T284
title: "ARK-T284 post_mr on GitHub passes one --attach per existing local file, resolved against the run folder"
level: integration
technique: "equivalence classes (path exists / path missing / non-image) and boundary values on the screenshot count (0, 2)"
priority: high
risk: "`--attach` is passed 0 or 2x per file, a path that does not exist is attached, a run-folder-relative path is resolved against the repo worktree so no file is found and a body with local paths is posted, or `gh pr edit` (update) gets no `--attach`"
status: active
changed_by: 2026-11-12-ARK-399-1
---

## Objective

Prove that `scripts/post_mr.ts --confirmed` on GitHub passes `--attach <path>` to `gh pr create` (and `gh pr edit`) once for each local image or video that the body names and that exists, resolving paths against the run folder. The body is the one `buildBody` generates; image rendering is asserted in ARK-T47 and not repeated here. Serves ARK-399/AC1.

Expected: When a body names a local image or video that exists, `post_mr.ts --confirmed` on GitHub shall pass one `--attach <path>` for it to `gh pr create` or `gh pr edit`.

## Preconditions

- Fixture run folder with `results/evidence/<case>/head/screenshots/` holding 2 PNG files (`a.png`, `x/a.png` style: one name is a suffix of the other path) and one test case with `base`/`head` `result.json`. Repo worktree is a different directory from the run folder.
- A fake `gh` on PATH that records its argv: `--version`/`pr create --help` and `pr edit --help` list `--attach`; `pr list` and `repo view` answer as in the existing `probeHostBin` fake; `pr create` and `pr edit` succeed and print a URL.
- A variant body that also names a third path that does not exist, and a variant with an existing open PR (update path).

## Steps

1. Run `post_mr.ts --confirmed` with the generated body naming both screenshots and a new PR (create). Read the fake call log.
2. Repeat with an open PR so that `gh pr edit` runs.
3. Repeat with the third, missing path in the body.
4. Repeat with a dry run (no `--confirmed`).

## Expected results

- The `gh pr create` call has exactly 2 `--attach` flags, one for each of the 2 screenshot paths, resolved against the run folder, and no more; the `gh pr edit` call has the same.
- The missing path gets no `--attach`.
- With no `--confirmed` no `gh pr create`, `gh pr edit` or upload call is recorded.
- The suffix path (`a.png` vs `x/a.png`) gets one `--attach` each, not 3.

## Screenshot checkpoints

None. The surface is CLI output and recorded host calls from a fake; no screenshot applies.
