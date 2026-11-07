---
id: ARK-T41
title: ARK-T41 post creates and updates one MR and keeps a human edit
level: integration
technique: state transition (no MR, MR exists) plus error guessing on a failing probe and --dry-run
priority: high
risk: an update overwrites a tick a human made outside the markers, two MRs are created for one branch, a failed probe falls through to a write, the author becomes reviewer, or --dry-run writes
status: active
changed_by: 2026-11-06-ARK-316-1
---

## Objective

Prove that `post.ts` creates or updates one MR per branch on GitHub and GitLab, re-probes before it writes, replaces only the text between the markers, lints the final body, sets assignee and reviewers by the rule, and writes nothing under `--dry-run`. Serves ARK-316/AC7.

Expected: When an MR exists, the system shall replace only the text between `<!-- pr-writing:begin -->` and `<!-- pr-writing:end -->`.

## Preconditions

- A fake `gh` and a fake `glab` on PATH that record each call and answer from a small state file. Token owner is `cobekarhoff`. Every row below runs on both `gh` (GitHub) and `glab` (GitLab).
- A body file between the markers `<!-- pr-writing:begin -->` and `<!-- pr-writing:end -->` that passes lint, and a second body file whose generated region has a `fail` (a synthetic `ghp_` token, for example `ghp_` followed by 36 zeros).
- An existing MR whose body has text before and after the markers, including a template checkbox a human ticked (`- [x] Tested locally`).
- A second existing MR whose text OUTSIDE the markers holds the synthetic forbidden token `ghp_` plus 36 zeros (a human pasted it), with a clean generated region in the replacement body file.
- Config `reviewers` list: variant 1 `[alice, bob]`; variant 2 `[cobekarhoff]` (only the author); variant 3 `[cobekarhoff, alice]`.

## Steps

1. With no MR on the branch, post the body file on `gh`, then on `glab`. Count create calls.
2. With the MR now existing, post a changed body file on both hosts. Diff the MR body before and after.
3. Make the fake host's MR probe fail (non-zero exit), then post on both hosts. Read the calls.
4. Make the first probe say "no MR" and a second probe, just before the write, say "MR exists" (a race). Post on both hosts.
5. Post the file whose generated region holds the `ghp_` token as create and as update, on both hosts.
6. Post the clean replacement body to the MR whose text outside the markers holds the `ghp_` token (update), on both hosts. Read the calls and the host body.
7. Post with reviewers variants 1, 2 and 3 on both hosts. Read assignee and reviewers in the calls.
8. Post with `--dry-run` for create and for update on both hosts. Read the output and the host state.
9. Run `bun test test/pr-writing.test.ts`.

## Expected results

- Create: one MR is created on `gh` and one on `glab`, with the body from the file.
- Update: only the text between the markers changes. The human tick `- [x] Tested locally` and all text outside the markers are unchanged, on both hosts.
- The host is probed for an MR on the source branch just before the write; the race in step 4 turns the create into an update, and only one MR exists, on both hosts.
- A failing probe makes no create or update call (zero write calls) and reports the failure, on both hosts.
- A `fail` in the generated region (the `ghp_` token) refuses the post for create and for update, and nothing is written.
- The final body is linted after the rewrite, not only the generated region: the update in step 6 refuses because the merged body contains the token outside the markers, although the replacement region is clean. The host body is unchanged afterwards and there are zero write calls, on both hosts.
- Assignee is the token owner. Reviewers come from `reviewers` and never include the author: variant 1 sets `alice` and `bob`; variant 2 sets no reviewer and prints a warning; variant 3 sets `alice` only. Same on both hosts.
- `--dry-run` prints each host call it would make and makes zero write calls (the fake host state is unchanged), for create and update, on both hosts.
- `bun test test/pr-writing.test.ts` exits 0.

## Screenshot checkpoints

None. The surface is CLI output and Markdown text; no screenshot applies.
