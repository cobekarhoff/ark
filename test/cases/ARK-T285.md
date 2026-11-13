---
id: ARK-T285
title: "ARK-T285 post_mr on GitLab uploads each local screenshot and posts a body with the upload URLs and no local path"
level: integration
technique: "equivalence classes (Markdown image target / same path in backticks / path that is a suffix of another path) and state transition (upload before create or update)"
priority: high
risk: "a screenshot is not uploaded, an upload is repeated, the body is posted with a local path a reviewer cannot open, the path is replaced inside a backtick or a longer path (`a.png` inside `x/a.png`), the substitution is done before `finalBodyOf` so old URLs outside the markers survive wrongly, or the upload runs on a dry run"
status: active
changed_by: 2026-11-12-ARK-399-1
---

## Objective

Prove that on GitLab `scripts/post_mr.ts --confirmed` uploads each local image or video that the body names with `glab api --method POST projects/:fullpath/uploads -H "Content-Type: multipart/form-data; boundary=<boundary>" --input <multipart body file>`, replaces that path in the body with the `url` of the answer, and only then creates or updates the MR. Serves ARK-399/AC2.

Expected: When a body names a local image or video that exists, `post_mr.ts --confirmed` on GitLab shall upload it and shall post the body with the `url` of the answer in place of the path.

## Preconditions

- Same fixture run folder as ARK-T284 (2 screenshots, one a path suffix of the other), host GitLab.
- A fake `glab` on PATH that records argv, answers `api --method POST projects/:fullpath/uploads` with `{"url":"/uploads/<hash>/<name>","markdown":"..."}` (one distinct URL for each file), and records the `mr create`/`mr update` body.
- A variant where the same path also appears once in backticks in the body, and a variant with an open MR whose description holds an old upload URL outside the Ark markers.

## Steps

1. Run `post_mr.ts --confirmed` for a new MR. Read the fake call log in order and the posted description.
2. Run it for the open-MR update. Read the update call and the final description.
3. Run it with the backtick variant.
4. Run it as a dry run (no `--confirmed`).

## Expected results

- Exactly 2 upload calls, each `glab api --method POST projects/:fullpath/uploads -H "Content-Type: multipart/form-data; boundary=<boundary>" --input <multipart body file>`, both before the `mr create` call.
- The posted body holds the 2 distinct upload URLs and no run-folder path of a screenshot.
- `a.png` and `x/a.png` are replaced independently: the longer path is not corrupted.
- The backtick occurrence is left as it was; only Markdown image targets are replaced.
- The text of an open MR outside the markers keeps its old URLs; the Ark section holds the new ones.
- With no `--confirmed` no upload call is recorded.

## Screenshot checkpoints

None. The surface is CLI output and recorded host calls from a fake; no screenshot applies.
