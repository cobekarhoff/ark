---
id: ARK-T402
title: ARK-T402 merge-request open refuses a high or critical vulnerability in a lockfile of the head, names each one, and refuses when a scanner crashes or its report cannot be read
level: integration
technique: equivalence classes over severity (critical, high, medium, low) and over scanner outcome (finding, clean, no lockfile, crash, unreadable report, offline), with a pre-existing vulnerability as a boundary case
priority: high
risk: a high or critical vulnerability ships because the scanner's severity or exit code is misread, because a lockfile is skipped, or because a scanner failure (crash, garbage report, network down) reads as a clean scan; or a repo with no lockfile is refused by osv-scanner's no-lockfile exit code
status: active
changed_by: 2026-11-14-ARK-380-1
---

## Objective

Prove that `ark merge-request open` runs osv-scanner on each lockfile of the head, refuses when it finds a high or critical vulnerability, and names each one (id, package and version, severity, lockfile). Prove that the scan fails closed: a crash of either scanner, a report that does not parse, and an offline lookup each refuse with the scanner's own message, and never read as clean. Prove that osv-scanner's "no lockfile" exit is not an error.

## Preconditions

- Fixture, host and gitleaks fake as in ARK-T401 (one-repo `scenario`, fake `gh`, a clean fake `gitleaks` that exits 0), so an osv-scanner result is the only possible cause of a refusal. The run branch commits a lockfile `bun.lock` (and for step 5 a second lockfile `docs/package-lock.json`); the test passes the files to its commit helper.
- Fake `osv-scanner` on `PATH`, in a directory the test owns. It emulates osv-scanner 2.x: `scan source ... -L <lockfile> --format json` prints the content of the file `$FAKE_OSV_DIR/<sha1 of the lockfile's bytes>.json` on stdout (else `$FAKE_OSV_DIR/default.json`, else `{"results":[]}`); the test computes each sha1 itself from the lockfile text it wrote. A report holds `results[].packages[]` with `package: {name, version, ecosystem}` and `vulnerabilities[]` of `{id, aliases, database_specific: {severity}}` (`CRITICAL`, `HIGH`, `MODERATE`, `LOW`). Exit code: 1 when the printed report holds any vulnerability, 0 when none, the value of `FAKE_OSV_EXIT` when set, and 128 with the message `No package sources found` on stderr when the file is not a lockfile osv knows. The fake is the same one ARK-T403 and ARK-T404 use.
- The run is at the point where the open accepts it, so the scan is the only possible refusal. The test records `git ls-remote origin` and the `FAKE_LOG` `create` calls before each call.

## Steps

1. Critical. The report for `bun.lock` holds `GHSA-aaaa-bbbb-cccc` (alias `CVE-2026-0001`) with severity `CRITICAL` on `left-pad@1.3.0`. Run `ark merge-request open <run>`. Assert a non-zero exit, and an error text that holds `GHSA-aaaa-bbbb-cccc`, `left-pad`, `1.3.0`, `CRITICAL` and `bun.lock`. Assert no branch on the origin and no `create` call.
2. High. Same with `HIGH` on `lodash@4.17.0`. Assert the same refusal naming `HIGH`.
3. Two findings at once: a critical on `bun.lock` and a high on `docs/package-lock.json`. Assert one error that names both, each with its lockfile.
4. Severity boundary. A report with only `MODERATE` and `LOW` vulnerabilities. Assert exit 0 and one `create` call: medium and low do not block (ARK-T403 owns what the body shows).
5. Pre-existing. The same high vulnerability is in the lockfile at the base commit and unchanged by the run's commits. Assert the refusal still happens: the scan reads the lockfile of the head, so a vulnerability that main already has blocks until it is fixed or accepted (ARK-T404 owns accepted).
6. No lockfile. The run commits no lockfile and the fake exits 128 with `No package sources found`. Assert exit 0 and one `create` call. Control: a repo with a clean lockfile (exit 0) also opens.
7. Fail closed, osv-scanner. For each of: exit 2 with `panic: boom` on stderr; exit 1 with stdout `not json`; exit 0 with stdout that is empty; exit 2 with `failed to fetch ... lookup api.osv.dev: no such host` on stderr. Assert a non-zero exit, no `create` call and no pushed branch each time, an error that holds the scanner's stderr text, and for the offline case an error that tells the reader the lookup needs the network.
8. Fail closed, gitleaks. With a clean osv-scanner, a fake gitleaks that exits 2 with `fatal: boom` on stderr, and one that exits 0 but writes `not json` to the report path. Assert each refuses, with the stderr text for the first, and that neither reads as clean.
9. Refresh. Open the clean fixture, add a commit that changes the lockfile to the one whose report holds the critical vulnerability, and call `ark merge-request open <run>` again. Assert a non-zero exit naming the finding and an origin branch tip unchanged by the second call.

## Expected results

- When osv-scanner reports a vulnerability of severity high or critical in a lockfile of the head, the system shall refuse `ark merge-request open`, name each finding by id, package, version, severity and lockfile, and push and post nothing.
- When the vulnerability exists at the base too, the system shall still refuse.
- When osv-scanner reports only medium or low vulnerabilities, or finds no lockfile, the system shall not refuse.
- If a scanner exits with an unexpected code, prints a report that cannot be parsed, or cannot reach the network, then the system shall refuse and show the scanner's stderr; it shall never treat the scan as clean.
- When the MR is open and the head gained a vulnerable lockfile, the system shall refuse again before it pushes.

## Screenshot checkpoints

none: integration case on CLI output, git refs and the fake host log; no UI surface.
