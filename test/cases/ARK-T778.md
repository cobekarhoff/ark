---
id: ARK-T778
title: "ARK-T778 post_mr on a public GitHub repo exits 2 and sends no file when the body names media outside a test case checkpoint folder, and a private repo still gets the upload"
level: integration
technique: "equivalence classes (visibility PUBLIC / PRIVATE; checkpoint file / non-checkpoint file) and boundary values on the checkpoint folder (symlink, `..` segment, video inside `screenshots`, file beside `screenshots`, `screenshots` under a side that is not head or base, no run folder)"
priority: high
risk: "post_mr reads no visibility and attaches a demonstration screenshot to a public PR; the check runs on create but not on update, so a refresh leaks; the checkpoint test compares the path string so a symlink or a `..` segment from inside `screenshots/` passes; any file under `results/evidence/` or any folder named `screenshots` passes; a video in a checkpoint folder passes; with no run folder a checkpoint-shaped path in the repo passes; the refusal names neither the file nor the visibility, or is reported as `not authenticated`; or the check also refuses a private repo"
status: active
changed_by: 2026-11-21-ARK-635-1
---

## Objective

Prove that the real `skills/pr-writing/scripts/post_mr.ts --confirmed` on GitHub refuses a body that names a local screenshot outside a test case checkpoint folder of the run when `gh` reports the repo PUBLIC: exit 2, no file sent to GitHub, no PR created or changed, and a message that names each refused file and the visibility. With the same body and PRIVATE it posts with every file attached, as today. Serves ARK-635/AC1.

Expected: If the repo is not private and the body names a local image or video that is not a checkpoint screenshot of the run, then `post_mr.ts` shall exit 2, send no file, post nothing, and name each such file and the visibility.

## Preconditions

- The `uploadRun("github")` fixture of `test/pr-writing.test.ts`: a one-repo run whose run folder holds checkpoint screenshots `results/evidence/ARK-T1/head/screenshots/a.png` and `results/evidence/ARK-T2/head/screenshots/b.png`, gathered with `gather.ts --run-dir <run folder>` and linted with `lint_body.ts` from the repo worktree (a different directory from the run folder).
- Two non-checkpoint files with real PNG bytes in the run folder: `results/screenshots/demo.png` (the demonstration evidence path) and `notes/live.png`. The body names both as Markdown images in the Evidence section, beside the two checkpoint images, before `lint_body.ts` runs.
- The fake `gh` of `test/fixtures/merge-request/gh` answers `gh repo view --json visibility` with `{"visibility":"<value>"}` on stdout and exit 0, the shape gh 2.103.3 printed for this repo (evaluation.md), where `<value>` comes from an env var of the fake. The env var is added to the `FAKE_*` scrub list of `test/pr-writing.test.ts`. Every other `gh` answer stays as it is.
- Boundary variants, each a file with real bytes that exists inside the run folder (so `localMedia` keeps it), named alone beside the two checkpoint images:
  - (a) `results/evidence/ARK-T1/head/screenshots/link.png`, a symlink to `results/screenshots/demo.png`;
  - (b) the target `results/evidence/ARK-T1/head/screenshots/../../../../screenshots/demo.png`;
  - (c) `results/evidence/ARK-T1/head/screenshots/clip.mp4`;
  - (d) `results/evidence/ARK-T1/head/x.png` (beside the `screenshots` folder);
  - (e) `results/evidence/ARK-T1/demo/screenshots/c.png` (a side that is not `head` or `base`).
- A repo outside any run: `gather.ts` without `--run-dir`, a PNG at `results/evidence/ARK-T1/head/screenshots/a.png` inside the repo worktree, and a body that names it.

## Steps

1. PUBLIC, no open PR: run `post_mr.ts --confirmed`. Read exit code, stdout JSON, stderr, the fake call log and the fake host state.
2. PUBLIC, an open PR on the branch (`openMergeRequest()`): run it again. Read the same, and the open PR's body.
3. PRIVATE, no open PR, then with the open PR: run it with the same body.
4. For each boundary variant (a) to (e): run it with PUBLIC, then with PRIVATE.
5. The repo outside any run, PUBLIC: run it.

## Expected results

- Steps 1 and 2: exit 2. Stderr names `demo.png` and `live.png` and the visibility (`PUBLIC`, matched without case). Stderr does not name a checkpoint file as refused (`ARK-T1/head/screenshots/a.png` is not in it). Stdout JSON has `"posted": false`, and its `error` is not `not authenticated`. No `gh` call carries `--attach`, no `pr create` or `pr edit` runs, the fake host state holds no new PR, and the open PR of step 2 keeps its body `Hand written intro.`.
- Step 3: exit 0 for create and for update. The one write call (`pr create`, then `pr edit`) carries `--attach` for exactly the 4 files (2 checkpoint, `demo.png`, `live.png`), as absolute paths, and the body names each of them. This is the control: the body of steps 1 and 2 is postable, so their exit 2 comes from the visibility rule and not from lint, the `--attach` probe or a missing file.
- Step 4: with PUBLIC each variant exits 2, its stderr names the variant's file (for (a) and (b) the name the body uses or the real path `demo.png`; either is accepted), no `--attach` is sent and no PR is created. With PRIVATE each variant exits 0 and its file is attached, so the PUBLIC refusal is the checkpoint rule and not a drop of the file before the check.
- Step 5: exit 2; stderr names `a.png` and the visibility; no PR is created. Outside a run no local media file goes to a repo that is not private, even at a checkpoint-shaped path.
- At base (before the fix) steps 1, 2, 4 (PUBLIC) and 5 exit 0 and attach the files: the validator shows this red proof.

## Authoring gate

1. Protects: the public-repo upload contract of `post_mr.ts` on GitHub, on create and on update (the refresh path of `ark merge-request open` reaches the same `postMergeRequest`), and the exact boundary of a checkpoint folder.
2. Regression: no visibility read; the check placed on the create branch only; a string-prefix or `includes("/screenshots/")` test of the path; the realpath of the file not taken; the image-extension filter dropped; the run-folder rule applied when `ledger.run` is missing; the message without file or visibility; a refusal class that `post_mr.ts` maps to `not authenticated`; or a check that refuses PRIVATE too.
3. Existing proof misses it: ARK-T284 asserts that every local file is attached and never sets a visibility; no case reads the repo visibility. ARK-T780 owns GitLab and the unknown read, ARK-T779 owns the checkpoint pass on a public repo.
4. No test-only hook: the case drives the real `post_mr.ts` process with a fake `gh` on PATH that answers the real command's output shape.

## Screenshot checkpoints

None. The surface is CLI output, exit codes and recorded host calls from a fake; no screenshot applies.
