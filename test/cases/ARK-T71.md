---
id: ARK-T71
title: ARK-T71 post_mr refuses without --confirmed, on a lint fail and on STALE01, and creates a Draft or updates inside the markers
level: integration
technique: state transition (gather, lint, post, new commit, gather again) and decision table (flag, lint result, head, body hash, existing MR)
priority: high
risk: an MR is posted without the human's go, a lint fail or a stale head is pushed, STALE01 never runs because post_mr passes no heads or body hash, a new MR opens ready, an update overwrites text outside the markers, the standalone entry point lints only its input instead of the final merged body, or host writes happen on a refusal
status: active
changed_by: 2026-11-07-ARK-317-1
---

## Objective

Prove the post gate of `post_mr.ts`: no `--confirmed` means no post and no host call; a lint `fail` or STALE01 (ledger head or body hash) refuses; a new MR is a Draft unless `--ready`; an existing MR is updated inside the ARK-316 markers only. Serves ARK-317/AC5.

Expected: If `--confirmed` is missing, then `post_mr.ts` shall exit 1, print `{"refused":"no --confirmed","posted":false}`, run no lint and call no host command.

## Preconditions

- A fixture git repo on branch `fix-retry-429` with a bare local `origin` and a fake `glab` that records every call and has switchable state: no open MR, or one open MR (iid 412, Draft) whose description holds human text before and after the ARK-316 markers.
- `gather.ts` and `lint_body.ts` already run on a good body, so `.pr-writing/ledger.json` and the linted body hash exist.
- A bad body that fails lint (`Self-review completed` with no command, no Risk section).
- A clean generated region, and an open-MR description whose human text outside the markers holds a synthetic forbidden token (a string the lint rejects in a body, chosen as in ARK-T56).

## Steps

1. Run `post_mr.ts` without flags, with the good body, then with the bad body. Read stdout, stderr, exit code, the fake call log.
2. Run `post_mr.ts --confirmed` with the bad body (lint fail).
3. Run gather and lint on the good body, commit one more file, run `post_mr.ts --confirmed`.
4. Run gather, rewrite nothing, run `lint_body.ts`, run `post_mr.ts --confirmed` with no open MR. Read the create call and stdout.
5. Reset to no open MR; run `post_mr.ts --confirmed --ready`.
6. Set the state to the open MR. Edit the body, run `lint_body.ts`, run `post_mr.ts --confirmed`. Read the update call and the final description.
7. Edit the body after `lint_body.ts` ran, then run `post_mr.ts --confirmed`.
8. Make the fake `glab` report not authenticated and run `post_mr.ts --confirmed`.
9. Set the state to the open MR with the forbidden-token description outside the markers. Run gather and lint on the clean generated body, then `post_mr.ts --confirmed`. Read stdout, exit code, the call log and the description.
10. Run `bun test test/pr-writing-skill.test.ts`.

## Expected results

- Step 1: both runs exit 1, stdout is `{"refused":"no --confirmed","posted":false}`, stderr says to pass `--confirmed` only after the human said go, the call log is empty, and the bad body is not linted (no lint output).
- Step 2: exit 1, stdout `{"refused":"lint fail","posted":false,"checks":[...]}` with the `VAL01` fail, no create or update call.
- Step 3: exit 1, `STALE01` result `fail` naming the ledger head and the current head, no create or update call, nothing pushed after the refusal.
- Step 4: exit 0, one create call carrying the Draft flag, stdout `{"action":"created","url":"...","draft":true}`. The same run after gather and lint succeeds where Step 3 refused.
- Step 5: exit 0, the create call has no Draft flag, stdout `"draft":false`.
- Step 6: exit 0, one update call on iid 412 (no create), stdout `"action":"updated"`, the text before and after the markers is unchanged, the content between the markers is the new body, and the MR is still Draft.
- Step 7: exit 1, `STALE01` fail naming the body hash, no host write call.
- Step 8: exit 2, stdout `{"error":"not authenticated",...,"posted":false}`.
- Step 9: exit 1, a lint `fail` naming the forbidden token in the final merged body, zero host write calls, the existing description unchanged. The generated region alone is clean, so only a lint of the merged body can refuse. The shared post path is owned by ARK-T56; this step proves only that the standalone entry point keeps it.
- `bun test test/pr-writing-skill.test.ts` exits 0.

The ready, non-Draft Ark side is owned by ARK-T57 (and ARK-T48); this case does not re-run it.

## Screenshot checkpoints

None. The surface is CLI output and host calls recorded by a fake; no screenshot applies.
