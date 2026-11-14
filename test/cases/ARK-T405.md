---
id: ARK-T405
title: ARK-T405 ark status names a missing gitleaks or osv-scanner with its brew command, and merge-request open and run close handed_off refuse with the same message
level: integration
technique: decision table over which tool is installed (both, only gitleaks, only osv-scanner, neither) crossed with the command (status, open, handed_off) and the repo shape (with and without a lockfile)
priority: high
risk: a missing scanner reads as a clean scan and the gate passes silently; status and the MR refusal give different texts, so the reader cannot act on one of them; the refusal needs a lockfile or an open `merge_requests` mode to fire; status exits non-zero for every project on a host without the tools
status: active
changed_by: 2026-11-14-ARK-380-1
---

## Objective

Prove that with `gitleaks` or `osv-scanner` missing from `PATH`, `ark status` prints one line for each missing tool that names the tool and its brew command, and `ark merge-request open` and `ark run close <run> handed_off` refuse with that same line before any push, MR post or scanner run. Prove that an installed tool adds no line and that both installed lets the open proceed.

## Preconditions

- Fixture, host and fake scanners as in ARK-T401. The test builds its own `PATH` for each row: the fake host directory of `test/fixtures/merge-request`, a directory with a symlink to the real `bun` (as `symlinkBun` of `test/run.test.ts` does, so `ark()` can start), `/usr/bin:/bin`, and the directory that holds each fake scanner that row has installed. The refusing shims of `test/tmpdir-preload.ts` keep covering `orca`, `omp`, and the rest; `brew` is never run. The preload's own clean fake scanners (if the plan puts them there) are off this PATH, so the row decides what is installed. The test restores `PATH` after each row.
- The project's roles are ones the fake `PATH` can run (as `controlledPath` in `test/run.test.ts` does), so no role line is printed. The test asserts that first on the "both installed" row, so a role failure cannot cause the exit code under test.
- The run is at the point where the open accepts it (plan approved, passing test at head), so the scan check is the only possible refusal. The test records `git ls-remote origin` and `FAKE_LOG` before each call. Each fake scanner, when called, appends a line to `$FAKE_SCAN_LOG`.
- The exact lines are `brew install gitleaks` and `brew install osv-scanner`; the test writes them from the AC text and reads no expected text from the code under test.

## Steps

1. Neither installed. Run `ark status`. Assert exit 0 (the plan default: status is information, the MR open refuses), a line for `gitleaks` that holds `brew install gitleaks`, and a line for `osv-scanner` that holds `brew install osv-scanner`.
2. Same PATH. Run `ark merge-request open <run>`. Assert a non-zero exit, an error that holds both status lines of step 1 verbatim (each full line of step 1 is a substring of the error text), no pushed branch, no `create` call, and an empty `$FAKE_SCAN_LOG`.
3. Only gitleaks missing (osv-scanner installed). Assert the status output has the `gitleaks` line and no `osv-scanner` line, and the open's error holds that line and does not name `osv-scanner`. Repeat with only osv-scanner missing: the mirror result with `brew install osv-scanner`.
4. Both installed, both clean. Assert the status output has neither line, and the open exits 0 with one `create` call. Assert `ark status` shows no role line, so the earlier rows' output comes from the scanners alone.
5. Missing tool on a repo with no lockfile: the run commits no lockfile, osv-scanner is missing. Assert the open refuses with the osv-scanner line (osv-scanner's no-lockfile exit never gets the chance to excuse it).
6. `merge_requests: none` project (the mode in which `mergeRequestOpen` does not run), a run ready to close as `handed_off`, both tools missing. Assert `ark run close <run> handed_off` exits non-zero with the same lines, and the run stays open. With both installed and clean it exits 0.
7. Status needs no run. With one project and no run at all, and with an open run, assert the same lines appear exactly once each.
8. Message source. Assert that the status line and the refusal line for one tool are byte-equal on every row (the test cuts the line from each output by its brew command and compares them).

## Expected results

- When gitleaks or osv-scanner is not on `PATH`, `ark status` shall print a line for each missing tool that names it and gives `brew install <tool>`, and shall print no such line for an installed tool.
- When a tool is missing, `ark merge-request open` shall refuse with the same line as `ark status`, before any scanner runs, any push or any MR post.
- The refusal shall not depend on the repo having a lockfile or on the project's `merge_requests` mode.
- When both tools are installed, `ark status` shall print no scanner line and `ark merge-request open` shall proceed.
- `ark status` shall exit 0 when the only problem is a missing scanner.

## Screenshot checkpoints

none: integration case on CLI output and git refs; no UI surface.
