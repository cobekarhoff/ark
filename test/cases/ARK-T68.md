---
id: ARK-T68
title: ARK-T68 each pr-writing script answers --help, --json-schema and a bad argument by the CLI contract
level: integration
technique: equivalence classes (help, schema, bad argument) crossed with the four scripts; stream separation (stdout vs stderr)
priority: high
risk: a script prints prose to stdout on `--help`, `--json-schema` or a bad argument so JSON parsing breaks, prose goes to the wrong stream, `--help` lacks examples and exit codes, --help or --json-schema exits non-zero or needs git/network, a bad argument exits 0 or 2 or throws a stack trace, or a script does not import skills/pr-writing/lib/
status: active
changed_by: 2026-11-07-ARK-317-1
---

## Objective

Prove the shared CLI contract of `gather.ts`, `review.ts`, `lint_body.ts` and `post_mr.ts` (AC2: JSON to stdout, prose to stderr, exit 0, 1 or 2): `--help` with examples and exit codes, `--json-schema`, and a bad argument. Serves ARK-317/AC2 literally; the help-on-stdout line in `mockups/cli-output.md` is not followed.

Expected: Every script writes prose only to stderr and JSON only to stdout. `--help` prints its usage prose (examples, exit codes) on stderr, leaves stdout empty, and exits 0. `--json-schema` prints one JSON schema on stdout. An unknown option prints prose that points to `--help` on stderr, one JSON object with an `error` on stdout, and exits 1. No stream exception exists.

## Preconditions

- An empty temp directory that is not a git repo, used as the cwd of every run (so `--help` and `--json-schema` must work with no git, no host and no ledger).
- A `PATH` with fake `gh` and `glab` that record any call and exit 1 (a call proves a script touched the host).
- Scripts run as `bun <repo>/skills/pr-writing/scripts/<name>.ts`.

## Steps

1. For each of the four scripts, run `--help`. Capture exit code, stdout and stderr.
2. For each script, run `--json-schema`. Parse stdout as JSON.
3. For each script, run once with the unknown option `--bogus`. Capture exit code, stdout, stderr.
4. Read the source of each script and check it imports from `../lib/`.
5. Read the fake `gh`/`glab` call log.
6. Run `bun test test/pr-writing-skill.test.ts`.

## Expected results

- `--help`: exit 0, stdout empty, stderr is prose that contains the script's own file name, at least one example command line starting `bun skills/pr-writing/scripts/<name>.ts`, and the exit codes 0, 1 and 2 each with a meaning. The test matches these facts, not the section headings' capitalization.
- `--json-schema`: exit 0, stdout parses as one JSON object with `$schema` and `type: "object"`, stderr empty.
- Bad argument: exit 1, stdout parses as one JSON object with an `error` string that names `--bogus`, stderr is non-empty prose that names `--help`, and no stack trace. The exact hint wording is not asserted.
- For `--help`, `--json-schema` and the bad-argument runs, stdout is empty or exactly one JSON document, never prose.
- Each script source imports a module under `skills/pr-writing/lib/`.
- The fake host call log is empty: none of the three argument classes touched the host.
- `bun test test/pr-writing-skill.test.ts` exits 0.

## Screenshot checkpoints

None. The surface is CLI output; stdout, stderr and exit codes are asserted as text.
