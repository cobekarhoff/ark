---
id: ARK-T403
title: ARK-T403 merge-request open lists medium and low findings and the licences of new dependencies in a Security section of the MR body without blocking, and rebuilds that section on each call
level: integration
technique: equivalence classes over finding kind (medium, low, licence of a new package, licence of an old package, none), a base-versus-head lockfile diff as a boundary, and a sequence case for the refresh
priority: high
risk: a non-blocking finding is dropped (the reader never sees it), is listed for packages that are not new, blocks the MR, or is stale after a refresh; the Security section breaks the body lint (tier 0 heading, secret-like text) so the MR is refused or lands under `loose`; or a clean scan adds an empty section
status: active
changed_by: 2026-11-14-ARK-380-1
---

## Objective

Prove that `ark merge-request open` exits 0 and posts an MR whose body holds a Security section with each medium and low finding and the licence of each dependency that is new at the head against the base, and nothing for packages the base already had. Prove the section is absent when the scan is clean, is rendered in the form the body's tier allows, is per repo, and is rebuilt on a refresh of the open MR.

## Preconditions

- Fixture, host, clean fake `gitleaks` and fake `osv-scanner` as in ARK-T401 and ARK-T402 (the fake `osv-scanner` answers by the sha1 of the lockfile's bytes, so the base lockfile and the head lockfile can have different reports; licence fields come from the same report: each `packages[]` entry has `licenses: ["MIT"]` when the report is for a licence scan).
- Base lockfile: `main` holds `bun.lock` with `pkg-old@1.0.0`. The run branch commits a `bun.lock` that holds `pkg-old@1.0.0` and `pkg-new@2.0.0`. The test writes both texts and both sha1 values, and gives `pkg-new` the licence `Apache-2.0` and `pkg-old` the licence `GPL-3.0-only`, so a list of every package is told apart from a list of the new ones.
- The head report holds a `MODERATE` finding `GHSA-mmmm-1111-2222` on `pkg-old@1.0.0` and a `LOW` finding `GHSA-llll-3333-4444` on `pkg-new@2.0.0`. No high or critical finding exists.
- The test reads the posted body from the `create` call of `FAKE_LOG` (and from the `edit` call on a refresh). `scenario` uses `pr_writing.tier_floor: 1` unless a step says otherwise.

## Steps

1. Run `ark merge-request open <run>`. Assert exit 0 and one `create` call.
2. Assert the posted body holds a heading `## Security`, and under it both finding ids, with `pkg-old`, `pkg-new`, and the words `medium` (or `moderate`) and `low` for the right rows. Assert it holds `pkg-new` with `Apache-2.0`, and that `GPL-3.0-only` and `pkg-old`'s licence appear nowhere (`pkg-old` is old at base).
3. Assert the body holds no `loose` or unmatched-heading text, that the MR was created (so the body lint of the pr-writing skill passed, which fails a body that holds secret-like text), and that the body contains no text starting with `AKIA`, `ghp_`, `glpat-`, `xox` or `-----BEGIN`.
4. Control (clean). Same fixture with every report empty and no new package. Assert exit 0, and that the body holds no `Security` heading and no `licen` text.
5. Licence-only. A report with no vulnerability at all but a new package `pkg-new` with `MIT`. Assert exit 0, the Security section lists `pkg-new` and `MIT`, and no finding row.
6. No new package. The run changes no lockfile and the head report holds the same licences as the base. Assert the body lists no licence.
7. Tier 0. `pr_writing` without `tier_floor`, with one changed line on the branch, so the body is tier 0 (a bold title, not a `##` heading). Assert exit 0 (the lint did not refuse it) and the body holds `**Security**` and the finding ids and no `## Security`.
8. Per repo. Two repos with commits (`twoRepoShape` with `core` and `app`); only `core`'s lockfile has a medium finding. Assert the `core` body holds the Security section and the `app` body does not.
9. Refresh. After step 1 (MR open), change the fake report to hold no finding and no new package (rewrite the file, add no commit), and run `ark merge-request open <run>` again. Assert exit 0, an `edit` or `update` call, and that the new body has no Security section, so the section is not cached in an event. Then rewrite the report with a different finding `GHSA-nnnn-5555-6666` and call again; assert the body names it and no longer names `GHSA-mmmm-1111-2222`.

## Expected results

- When the scan finds only medium or low vulnerabilities and licences, the system shall not refuse `ark merge-request open`, and shall post an MR body with a Security section that lists each such finding with its id, package, version and severity.
- The system shall list the licence of each dependency that is new at the head against the base lockfile, and no licence of a dependency the base already holds.
- Where the scan finds nothing to show, the system shall add no Security section to the body.
- The Security section shall render in the form of the body's tier and shall pass the pr-writing lint.
- When the MR is already open, the system shall rebuild the Security section from the scan of that call.

## Screenshot checkpoints

none: integration case on the posted MR body text; no UI surface.
