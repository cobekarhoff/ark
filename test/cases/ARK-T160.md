---
id: ARK-T160
title: ARK-T160 ark merge-request open on a run with 3 repos runs rev-parse HEAD at most once for each repo and each ledger git query once for each repo
level: integration
technique: "process counting through a git shim on PATH, grouped by repo and by git query (boundary: 3 repos, upper bound 3)"
priority: high
risk: "open asks each repo for rev-parse HEAD in staleHeads, evidenceProblems and the ledger separately, or the ledger repeats remote get-url or symbolic-ref for one repo, so each open starts about 20 git processes more than it needs; or the single head read is taken before a step that moves HEAD and the stale check or the ledger uses an old head"
status: active
changed_by: 2026-11-14-ARK-380-1
---

## Objective

Prove that one `ark merge-request open` reads each repo's head once and runs each ledger query once for each repo.

Expected: When `ark merge-request open` runs on a run with 3 repos, the system shall run `rev-parse HEAD` at most once for each repo and each git query of `skills/pr-writing/lib/ledger.ts` once for each repo.

## Preconditions

- A run with 3 repos built with `scenario()` in `test/helpers.ts`, each repo with its own files (so the heads differ) and an `origin` remote, ready for `merge-request open` (tests passed at head, evidence recorded, gates answered), as in the existing `test/merge-request.test.ts` cases.
- A git shim on PATH that appends `<cwd>\t<args>` to a log and runs the real git. The security scan of ARK-380 runs git in a scratch clone that it removes, so the test reads only the calls whose cwd still exists. The test restores PATH afterward.

## Steps

1. Put the shim on PATH and run `ark merge-request open <run>` as the existing merge-request tests do. Assert it exits 0 and opens the MR for all 3 repos.
2. Read the shim log. Group the calls by repo (cwd) and by args.
3. Assert for each repo that the count of `rev-parse HEAD` is at most 1, so at most 3 over the run.
4. Assert for each repo that each ledger query (`remote get-url origin`, `symbolic-ref refs/remotes/origin/HEAD`, and the other queries `ledger.ts` runs) appears once.
5. Assert the head in the stale check and in the ledger of each MR body is the repo's real head (the head differs between the repos, so a mix-up shows).

## Expected results

- Step 1: exit 0, 3 MRs.
- Step 3: at most 1 `rev-parse HEAD` for each repo, at most 3 in total.
- Step 4: no ledger query repeats for one repo.
- Step 5: each repo's ledger holds its own head.

## Screenshot checkpoints

none: a CLI with no visual surface.
