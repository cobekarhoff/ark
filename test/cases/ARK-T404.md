---
id: ARK-T404
title: ARK-T404 ark.yml security.accepted lets an accepted vulnerability or secret through, shows it as accepted with its reason in the MR body, and refuses a malformed security block
level: integration
technique: equivalence classes over the match (finding id, alias, secret fingerprint, no match) and over the config shape (valid, empty id, empty reason, duplicate id, unknown key), a partial accept as a boundary
priority: high
risk: an accepted finding still blocks, or an unaccepted one slips through because the match is too loose (one accepted id lets a second finding through); the accept shows nowhere in the MR body so a reviewer cannot see what was waved through; an accepted secret leaks its value; a typo in the security block is silently ignored and the human believes a finding is accepted
status: active
changed_by: 2026-11-14-ARK-380-1
---

## Objective

Prove that an entry of `security.accepted` in ark.yml (`id` and `reason`) turns a matching high or critical vulnerability, or a matching secret, from a refusal into an accepted finding that `ark merge-request open` lets through, that the MR body shows it as accepted with its id and reason, that a finding the list does not name still refuses, and that ark.yml load refuses a security block that is malformed, naming the field.

## Preconditions

- Fixture, host, fake `gitleaks` and fake `osv-scanner` as in ARK-T401 and ARK-T402; the scenario's `config` argument carries `security: { accepted: [...] }` in ark.yml. The suite command writes its JUnit report to `{report}` as `scenario` has it.
- Vulnerabilities: a `CRITICAL` finding `GHSA-aaaa-bbbb-cccc` (aliases `CVE-2026-0001`) on `left-pad@1.3.0`, and a `HIGH` finding `GHSA-dddd-eeee-ffff` on `lodash@4.17.0`, both in the head `bun.lock`.
- Secret: one marker commit on the run branch with rule `generic-api-key` in `src/config.ts` at line 12; its accept id is the gitleaks fingerprint `<commit>:src/config.ts:generic-api-key:12`, built by the test from `git rev-parse` of its own commit.
- The reason strings are `waived: not reachable from the CLI` and `waived: test fixture key` so the test can find them in the body.

## Steps

1. Accept by id. `accepted: [{id: "GHSA-aaaa-bbbb-cccc", reason: "waived: not reachable from the CLI"}]`, only the critical finding in the report. Assert `ark merge-request open <run>` exits 0 with one `create` call. Assert the body holds a Security section with `GHSA-aaaa-bbbb-cccc`, the word `accepted`, `left-pad` and `waived: not reachable from the CLI`, and that this finding is not listed as an open finding.
2. Accept by alias. `accepted: [{id: "CVE-2026-0001", ...}]` for the same finding. Assert exit 0 and the body shows it as accepted.
3. Partial accept. Both findings in the report and only the critical accepted. Assert a non-zero exit, an error that names `GHSA-dddd-eeee-ffff` (`lodash`) and does not name `GHSA-aaaa-bbbb-cccc` as the cause, and no `create` call. Then accept both: exit 0 and the body lists both as accepted.
4. Accept does not widen. `accepted: [{id: "GHSA-zzzz-0000-0000", ...}]`, which matches nothing; the critical finding is in the report. Assert the refusal; and that an accept entry that matches no finding is not an error when the report is clean (exit 0).
5. Accepted secret. `accepted: [{id: <fingerprint>, reason: "waived: test fixture key"}]` with the marker commit. Assert exit 0, and that the body holds the fingerprint, `accepted`, `src/config.ts`, the rule and the reason, and neither the body nor any output holds `SENTINEL-SECRET-VALUE-4242`. A marker in a second commit that the list does not name still refuses and names only that one.
6. Accepted refresh. With the MR open from step 1, call the open again. Assert exit 0, and that the edited body still lists the finding as accepted.
7. The accepted list lives outside the repo. Assert that adding the entry to ark.yml changes no head: `git rev-parse HEAD` of the worktree is the same before and after, and `ark merge-request open` does not ask for a new `ark test` run.
8. Config validation. For each ark.yml, run `ark merge-request open <run>` and assert a non-zero exit, no `create` call, and an error that names the field: `security.accepted[0].reason` for an entry with no `reason` and for `reason: ""`; `security.accepted[0].id` for `id: ""` and for a missing `id`; `security.accepted[1]` (naming the repeated id) for two entries with the same id; the unknown key (`security.extra`, and `security.accepted[0].why`) for an unknown key at each level; `security.accepted` for a value that is not a list. Control: `security: {accepted: []}` and a config with no `security` key both load.

## Expected results

- When ark.yml lists a finding in `security.accepted` with an id and a reason, and the id equals the finding's id, one of its aliases, or its secret fingerprint, the system shall not refuse `ark merge-request open` for that finding.
- The system shall show each accepted finding in the Security section of the MR body as accepted, with its id and its reason.
- While one finding stays out of the list, the system shall refuse and name that finding.
- If the security block has an entry with an empty or missing id or reason, a duplicate id, or an unknown key, then the system shall refuse to load ark.yml and name the field.
- The system shall not print or post a secret value for an accepted secret.

## Screenshot checkpoints

none: integration case on CLI output, config errors and the posted MR body; no UI surface.
