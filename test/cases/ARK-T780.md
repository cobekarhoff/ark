---
id: ARK-T780
title: "ARK-T780 post_mr refuses a non-checkpoint video on an internal or public GitLab project and on an unknown visibility, accepts a private one, and a dry run prints the visibility and each file it would refuse"
level: integration
technique: "equivalence classes (GitLab `internal` / `public` / `private`; read fails / answers nothing on GitLab and GitHub; answers with no `visibility` field on GitLab) and state transition (dry run versus confirmed post)"
priority: high
risk: "an `internal` GitLab project is treated as private (visible to every gitlab.com user); a lower-case `private` from glab is refused because the compare expects `PRIVATE`; a failed or empty visibility read falls through to the upload; the unknown refusal does not say that the visibility is unknown; a failed read also blocks checkpoint screenshots; or a dry run skips the read, prints nothing about the refused files, or uploads"
status: active
changed_by: 2026-11-21-ARK-635-1
---

## Objective

Prove that on GitLab `post_mr.ts --confirmed` refuses a body that names a video outside a test case checkpoint folder when `glab api projects/:fullpath` reports `internal` or `public` (exit 2, no upload, no MR created, message names the file and the visibility), and accepts it when it reports `private`. Prove that, for that body, a failed read and an empty answer refuse on GitLab and on GitHub, and an answer with no `visibility` field refuses on GitLab, each with a message that says the visibility is unknown. The answer with no field runs on GitLab only: the one successful `gh repo view --json visibility` that evaluation.md records printed the field, and no GitHub answer without it was seen, so it gets no GitHub row. Prove that a dry run reads the visibility, prints it and each file it would refuse, and posts nothing. Serves ARK-635/AC3.

Expected: If the visibility read fails or prints no visibility and the body names a local image or video that is not a checkpoint screenshot of the run, then `post_mr.ts` shall refuse the upload and say that the visibility is unknown. When the post is a dry run, the system shall print the visibility and each file it would refuse and post nothing.

## Preconditions

- The `uploadRun("gitlab")` fixture of `test/pr-writing.test.ts` (2 checkpoint screenshots), plus a non-checkpoint video `results/screenshots/flow.mp4` with real bytes in the run folder, named as a Markdown image in the Evidence section before `lint_body.ts` runs. The same fixture on GitHub for the GitHub rows.
- The fake `glab` of `test/fixtures/merge-request/glab` answers `glab api projects/:fullpath` (the project path with no suffix) from an env var. Two shapes are the ones glab 1.82.0 printed (evaluation.md):
  - a visibility value: exit 0, stdout `{"path_with_namespace":"org/a","visibility":"<value>"}` (a trimmed project object);
  - failed: exit 1, stdout `{"message":"404 Project Not Found"}`, stderr `glab: 404 Project Not Found (HTTP 404)`.
- Two more `glab` answers are fake shapes made for this case, not printed by glab 1.82.0 (evaluation.md records no such answer). They stand for a host or proxy that answers without the field:
  - no field: exit 0, stdout `{"path_with_namespace":"org/a"}`;
  - empty: exit 0, no stdout.
- The fake `gh` answers `gh repo view --json visibility` from its env var, keyed on the argv `--json visibility` (ARK-T778), plus two variants:
  - failed: exit 1, empty stdout, stderr `HTTP 401: Bad credentials (https://api.github.com/graphql)`. This is the first of the two stderr lines that gh 2.103.3 printed for `GH_TOKEN=bad gh repo view --json visibility` (evaluation.md records this line; the second line, `Try authenticating with:  gh auth login -h github.com`, is from the run in findings/test-case-review-2.md). The fake leaves out the second line;
  - empty: exit 0, no stdout. This is a fake shape, not printed by gh 2.103.3; it is also what the fake `gh` prints today for `repo view`.
- The new env vars are in the `FAKE_*` scrub list of `test/pr-writing.test.ts`.
- The dry run goes through `test/fixtures/pr-writing/driver.ts` with `dryRun: true` (neither `post_mr.ts` nor `ark merge-request open` has a dry-run flag).

## Steps

1. GitLab `internal`: run `post_mr.ts --confirmed`. Read exit code, stdout JSON, stderr, the uploads the fake received and the fake host state.
2. GitLab `public`: the same.
3. GitLab `private`: the same.
4. GitLab, for each of failed, no field, empty: the same.
5. GitHub with `flow.mp4` in the body, for failed and empty: the same, reading `--attach` and `pr create`.
6. GitLab failed read, with a body whose only media are the 2 checkpoint screenshots: the same.
7. Dry run on GitLab `internal`, and on GitHub with the failed read: drive `post` with `dryRun: true`. Read the driver's `out` lines, the fake call log (with the `--help` probe left out, as `hostWrites()` of `test/pr-writing.test.ts` does) and the fake host state.

## Expected results

- Steps 1 and 2: exit 2; stderr names `flow.mp4` and the visibility (`internal`, then `public`); stdout JSON has `"posted": false`; the fake received no upload (no `projects/:fullpath/uploads` call, not even for the checkpoint files) and no `mr create`; the fake host state holds no MR.
- Step 3: exit 0; the fake received 3 uploads (2 checkpoint files and `flow.mp4`) before the `mr create`, and the description holds the 3 upload URLs. This is the control for steps 1, 2 and 4: the same body posts, so their exit 2 is the visibility rule.
- Steps 4 and 5: exit 2 in each variant; stderr names `flow.mp4` and contains `unknown` (the visibility is unknown); no upload, no `--attach`, no write call, no MR or PR in the fake host state.
- Step 6: exit 0 and 2 uploads: a failed read counts as not private, and on a repo that is not private checkpoint screenshots pass (ticket Change 1 and 2).
- Step 7: the `out` lines hold the visibility (`internal`, then `unknown`) and name `flow.mp4` as a file that would be refused, and do not name a checkpoint file as refused. The call log holds the visibility read (`api projects/:fullpath` on GitLab, `repo view --json visibility` on GitHub), so the dry run did read it. Leaving out each call whose argv holds `--help`, the fake received no upload and no `mr create`, `mr update`, `pr create` or `pr edit`, and its host state is unchanged. The case does not pin whether the dry run then returns `dry-run` or a refusal error: a GitHub dry run that goes on to `dry-run` runs the read-only `gh pr create --help` probe (`requireGithubAttach`, spawned by `host()` in a dry run), and the `--help` filter lets either return pass.
- At base steps 1, 2, 4, 5 and 7 fail (the video is uploaded, no visibility is printed): the validator shows this red proof.

## Authoring gate

1. Protects: the GitLab visibility rule (only `private` in any case passes), the fail-closed rule for a visibility read that fails or answers nothing on both hosts, and the dry-run report.
2. Regression: `internal` treated as private; a case-sensitive compare against `PRIVATE`; a failed read or `JSON.parse` error swallowed as private; a message with no `unknown`; a refusal of checkpoints on a failed read; a dry run that skips the read or uploads.
3. Existing proof misses it: ARK-T285 and ARK-T286 cover uploads and upload failure of checkpoint files under the fake's default answer (`public` on `glab`, `PUBLIC` on `gh`), except the ARK-T284 ARK-T285 decoy test, which names `../private.png` outside the run folder and sets `private` on `glab` (`PRIVATE` on `gh`); none names a video that a non-private project refuses, and none reads an unknown visibility. ARK-T778 covers GitHub PUBLIC and PRIVATE only; ARK-T56 covers a dry run of a body with no media.
4. No test-only hook: the real `post_mr.ts` process, and for the dry run the driver that already runs the real `postMergeRequest` for ARK-T284 and ARK-T285 (the only entry point with `dryRun`).

## Screenshot checkpoints

None. The surface is CLI output, exit codes and recorded host calls from a fake; no screenshot applies.
