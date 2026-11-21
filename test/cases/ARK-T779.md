---
id: ARK-T779
title: "ARK-T779 post_mr on a public repo still uploads a body whose only media are checkpoint screenshots of the run's test cases, head and base, nested, through a symlinked run folder path"
level: integration
technique: "equivalence classes (checkpoint screenshot on the head side / base side / in a nested subfolder; GitHub / GitLab) and boundary value (the run folder path reached through a symlink)"
priority: high
risk: "the new check refuses a real checkpoint screenshot on a public repo, so every Ark MR with screenshots (ark's own repo is public) fails to post: it accepts only the `head` side, only a file directly in `screenshots/` and not a subfolder `ark test` copies, or it compares the real path of the file with the unresolved run folder path, so a run folder reached through a symlink (`/var` to `/private/var` on macOS) refuses every checkpoint"
status: active
changed_by: 2026-11-21-ARK-635-1
---

## Objective

Prove that with the repo visibility PUBLIC, `post_mr.ts --confirmed` uploads and posts, as today, a body whose only media are checkpoint screenshots: files under the `screenshots` folder that `ark test` writes in a `head` or `base` evidence folder of a test case (`cli/test-run.ts` copies that folder recursively, so subfolders count). Serves ARK-635/AC2 (a guard: it holds at base, where no visibility is read).

Expected: When the repo is not private and every local image of the body is a checkpoint screenshot of the run, `post_mr.ts` shall upload each and post the body as it does for a private repo.

## Preconditions

- The `uploadRun` fixture of `test/pr-writing.test.ts` (checkpoint screenshots `results/evidence/ARK-T1/head/screenshots/a.png` and `results/evidence/ARK-T2/head/screenshots/b.png`), plus a third checkpoint `results/evidence/ARK-T2/base/screenshots/x/c.png` (base side, nested subfolder) with real PNG bytes, named as a Markdown image in the Evidence section before `lint_body.ts` runs.
- `gather.ts --run-dir` gets the run folder through a symlink made in the test tmpdir, so the run folder path in the ledger is not its real path.
- The fake `gh` answers `gh repo view --json visibility` with `{"visibility":"PUBLIC"}`; the fake `glab` answers `glab api projects/:fullpath` with a project JSON whose `visibility` is `public` (the shape glab 1.82.0 returned for gitlab.com/gitlab-org/cli, evaluation.md). Both are set by the same env vars as ARK-T778 and ARK-T780.

## Steps

1. GitHub, no open PR: run `post_mr.ts --confirmed`. Read exit code, stderr, the call log and the fake host state.
2. GitHub, with an open PR (`openMergeRequest()`): run it again.
3. GitLab, no open MR: run it. Read the uploads the fake received and the posted description.

## Expected results

- Steps 1 and 2: exit 0. The one write call (`pr create`, then `pr edit`) carries `--attach` for exactly the 3 checkpoint files, and the body names each of them; the fake host state holds the PR with that body.
- Step 3: exit 0. The fake received exactly 3 uploads (`a.png`, `b.png`, `c.png`) before the `mr create`, and the posted description holds the 3 upload URLs and no run-folder path of a screenshot.
- No step prints a refusal or names the visibility as a reason to stop.
- At base the case passes (no visibility is read). After the fix it must still pass: the validator runs it at base and at head.

## Authoring gate

1. Protects: the contract that Ark's own MR evidence (checkpoint screenshots, the only images `ark merge-request open` puts in a body) still posts to a public repo on both hosts.
2. Regression: a checkpoint pattern that names `head` only, matches only one level below `screenshots/`, or realpaths the file and not the run folder; a GitLab branch that refuses all media when not private.
3. Existing proof misses it: ARK-T284 and ARK-T285 post checkpoint screenshots but with no visibility answer, from a head side only, with no subfolder and no symlinked run folder; they would also pass if the fix treated an unknown visibility as private. ARK-T778 owns the refusal side.
4. No test-only hook: the real `post_mr.ts` process with fake `gh` and `glab` on PATH.

## Screenshot checkpoints

None. The surface is CLI output, exit codes and recorded host calls from a fake; no screenshot applies.
