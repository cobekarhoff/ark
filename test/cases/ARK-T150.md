---
id: ARK-T150
title: ARK-T150 gather.ts in each repo of a 2-repo run writes that repo's own host, token owner and template, and lint_body and post_mr use them
level: integration
technique: "equivalence classes (one class per repo: github vs gitlab origin, different templates) with a shared branch name as the discriminating input"
priority: high
risk: the ledger builder picks worktrees[0] (or the first repo on the branch) for host, token owner and template, so the second repo of a run gets the first repo's host, owner and template, and lint_body and post_mr act on the wrong host or body shape
status: active
changed_by: 2026-11-09-ARK-362-1
---

## Objective

Prove that in a run with 2 repos on the same branch name, `gather.ts --run-dir <run folder>` run from each repo directory persists a `.pr-writing/ledger.json` with that repo's own files, host, token owner and template, and that `lint_body.ts` and `post_mr.ts --confirmed` then use that repo's host and template.

## Preconditions

- A temp run folder with a run state listing 2 repos. Each repo is a real git worktree of one shared branch name with commits.
- Repo A: origin on github (`https://github.com/org/a.git`), its own MR template with headings unique to A.
- Repo B: origin on gitlab (`https://gitlab.example.com/org/b.git`), its own MR template with headings unique to B.
- Fake `gh` and `glab` executables first on PATH that report different token owners (for example `owner-a`, `owner-b`) and record every call.
- Real `gather.ts`, `lint_body.ts`, `post_mr.ts`. No mocks of the scripts.

## Steps

1. Run `gather.ts --run-dir <run folder>` with cwd = repo B (the second repo), then with cwd = repo A.
2. Read `.pr-writing/ledger.json` in each repo.
3. Write a body that follows each repo's own template and run `lint_body.ts` in each repo.
4. Write a pre-linted body (`.pr-writing/body.md`) that follows each repo's template, then run `post_mr.ts --confirmed` in each repo.
5. Read the exit codes, the outputs and the fake CLI call logs.

## Expected results

- When gather runs in repo B, the system shall write a ledger whose files are only B's, whose host is the gitlab host, whose token owner is `owner-b` and whose template is B's template.
- When gather runs in repo A, the ledger shall carry A's files, the github host, `owner-a` and A's template. The result does not depend on which repo runs first.
- `lint_body.ts` in each repo shall check the body against that repo's template headings and owner, and exit 0 for a body that follows it. A body that follows the other repo's template shall fail.
- `post_mr.ts --confirmed` in each repo shall make its host calls to that repo's host only: the recorded calls are `gh` for A and `glab` for B, with that repo's token owner. The fake CLI log of the other host shall have no call.

## Screenshot checkpoints

none: cli_output case; the observable is exit codes, stdout and the ledger file.
