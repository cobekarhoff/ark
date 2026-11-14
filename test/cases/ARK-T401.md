---
id: ARK-T401
title: ARK-T401 merge-request open and run close handed_off refuse a secret in the commits of the run branch, name each finding without its value, and push nothing
level: integration
technique: equivalence classes over the commit range (own commit, commit before the base, merged-in target commit), a sequence case for the refresh of an open MR, and a negative check on the output
priority: high
risk: a leaked secret ships because the scan misses a path (refresh of an open MR, handed_off, a commit of the branch) or runs over the wrong range (blocks on a commit the run did not make, or skips one it did); or the refusal prints the secret value, or an unredacted scan leaks it into the MR body and the error text
status: active
changed_by: 2026-11-14-ARK-380-1
---

## Objective

Prove that `ark merge-request open` runs gitleaks on the commits the run branch added, refuses when it finds a secret and names each finding (rule, file, line, short commit), pushes nothing and posts nothing, and never prints the secret value. Prove the same refusal for the refresh of an already open MR and for `ark run close <run> handed_off`, and that a secret outside the run's own commits (before the base, or merged in from the target) does not block.

## Preconditions

- Fixture of `test/merge-request.test.ts` (`scenario`) with a one-repo shape (`names: ["core"]`, one implementer step, no repos block). The project suite is `command: "true {report}"` as `scenario` has it (ark.yml load refuses a suite whose command does not write its JUnit report to `{report}`). The host is the fake host of `test/fixtures/merge-request` (`gh`, `fake-host.ts`) first on `PATH`, with `FAKE_LOG` set; the origin is the local bare repo `scenario` makes. `pr_writing.tier_floor` is 1.
- Fake `gitleaks` on `PATH`, in a directory the test owns. It is an emulated gitleaks, not a mock of the answer: it parses `--log-opts` (both `--log-opts=<x>` and `--log-opts <x>`), runs `git log -p <log-opts> --format=@@%H` in its working directory (or the repository argument), and reports one leak for each added line of the form `FAKE-SECRET <rule>` in a commit of that range. With no `--log-opts` it scans all history. The report goes to the path after `--report-path` as a JSON array of `{RuleID, File, StartLine, Commit, Fingerprint: "<commit>:<file>:<rule>:<line>", Secret}`. `Secret` is `REDACTED` when argv holds `--redact` and the sentinel `SENTINEL-SECRET-VALUE-4242` when it does not. Exit code 1 when it wrote a leak, 0 when none, and the value of `FAKE_GITLEAKS_EXIT` when that is set. A fake `osv-scanner` that finds nothing (exit 0, `{"results":[]}`) is on `PATH` too, so a gitleaks finding is the only possible cause of a refusal.
- The test builds each commit itself with `git` (a file holding the line `FAKE-SECRET generic-api-key` at a known line number), and takes expected commit ids from `git rev-parse`, never from output of the code under test.
- The run is at the point where `ark merge-request open` accepts it (plan approved, passing test at head), so the only open refusal is the scan.
- The test records, before each call, `git ls-remote origin` and the `create` and `edit`/`update` calls in `FAKE_LOG`.

## Steps

1. Single secret. Commit `src/config.ts` with the marker on line 12 on the run branch, then record the tested head with it. Run `ark merge-request open <run>`. Assert a non-zero exit, and that the error text holds `generic-api-key`, `src/config.ts`, `12` and the first 8 hex characters of that commit. Assert the origin refs are as before (no `ark/...` branch), `FAKE_LOG` has no `create` call, and neither stdout nor stderr holds `SENTINEL-SECRET-VALUE-4242`.
2. Two secrets in two commits (rules `aws-access-key` and `generic-api-key`). Assert the one error names both findings, each with its own file, line and commit.
3. Control (clean). Same fixture without a marker. Assert exit 0 and one `create` call, so step 1 fails because of the finding and not for another reason. The test also asserts the posted body holds neither the sentinel nor the marker line.
4. Range, before the base. A marker in a commit that is an ancestor of the base (`main`), none on the run branch. Assert exit 0 and one `create` call: a secret the run did not add does not block.
5. Range, merged-in target. Put a marker commit on `main` after the run branch was cut and merge `main` into the run branch with `git merge` (what `ark worktree sync` does). Assert exit 0: the merged target commit is not scanned, because only the run's own commits are (`--first-parent --no-merges <base>..HEAD`). A marker in a commit made on the run branch after that merge still refuses.
6. Refresh of an open MR. Open the clean fixture (exit 0, one `create`, branch pushed). Commit a marker file on the run branch and run the guard path again (`ark merge-request open <run>` on the same run, the MR now open). Assert a non-zero exit naming the finding, the origin branch tip still equals the tip before the second call, and `FAKE_LOG` has no `edit` or `update` call after the first open.
7. `handed_off`. In the fixture of `test/run.test.ts` that closes a run as `handed_off` (`ark run close <run> handed_off`, as the tests at the lines that call it do), with a marker on the run branch, assert a non-zero exit with the same finding named, and that the run stays open (no `run.closed` event). With a clean branch the same call exits 0.
8. No bypass from the run branch. Three run commits, each with the marker on line 12 of `src/config.ts`: one with `# gitleaks:allow` on the marker line, one that also commits `.gitleaks.toml` with an `[allowlist]` of `paths = ["src/config.ts"]`, and one followed by a commit of `.gitleaksignore` holding the secret's fingerprint. For each, assert a non-zero exit naming the finding and nothing shipped.
9. Base policy. The base holds a `.gitleaks.toml` that allowlists `src/legacy.ts`; the run commits the marker in that file. Assert exit 0 and one `create` call: the allowlist of the base stays in force.

## Expected results

- When `ark merge-request open` is called and gitleaks reports a secret in a commit the run branch added, the system shall refuse, name each finding by rule, file, line and short commit, push no branch and post no MR.
- The system shall run gitleaks redacted and shall never print a secret value in the error text or in an MR body.
- When a secret sits only in a commit before the base or in a commit merged in from the target, the system shall not refuse.
- When the MR is already open, the system shall run the scan again on each call, and refuse before any push or edit of the MR.
- When `ark run close <run> handed_off` is called, the system shall refuse the same way and leave the run open.
- A `gitleaks:allow` comment, a `.gitleaks.toml` or a `.gitleaksignore` that the run branch commits shall not hide a secret; only the `.gitleaks.toml` of the base applies.

## Screenshot checkpoints

none: integration case on CLI output, git refs and the fake host log; no UI surface.
