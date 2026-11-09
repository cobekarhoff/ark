---
id: ARK-T158
title: ARK-T158 ark status checks each role's harness on PATH and its omp model once per call, prints one line per failing role and exits 1
level: integration
technique: equivalence classes (harness missing / model missing / all ok / omp list fails) and state transition (no-run path vs run path vs other command)
priority: high
risk: a role with an uninstalled harness or a made-up model passes status and fails only when a worker starts; `omp models --json` runs once per role or per project and slows status; a failed model list fails status or prints nothing; the check leaks into `ark status <run>` or other commands; a project with no ark.yml crashes or fails the check, or an invalid config loses its existing failure or gets a role line; a failure line omits the role, the harness or model, or the cause
status: active
changed_by: 2026-11-09-ARK-340-1
---

## Objective

Prove that `ark status` with no run name reports each role that cannot run, once per call, fails only for real role failures, and leaves config-error and no-config handling as ARK-T19/T18 define it.

## Preconditions

- The real `ark` CLI run as a subprocess; every scenario gets its own scratch `ARK_HOME`, holding only the projects the scenario names.
- A fake `omp` executable on a controlled `PATH` that has no `codex`. Variant OK answers `models --json` with `{"models":[{"selector":"anthropic/claude-sonnet-5-5"}]}`; variant FAIL exits 1 with a message. Each `models` call appends one line to a counter file.
- Project `a` (failing): every role on omp `anthropic/claude-sonnet-5-5`, except `reviewer` on omp `openai-codex/gpt-6.1-solx` (not in the list) and `validator` on harness `codex`.
- Project `a-ok` (passing): every role on omp `anthropic/claude-sonnet-5-5`.
- Project `b`: same as `a-ok`, a second omp project.
- Project `a-codex` (unchecked-only): every role on omp `anthropic/claude-sonnet-5-5` except `validator` on harness `claude`, with a `claude` executable on PATH.
- Project `nocfg`: no `ark.yml`, one run folder under `runs/`. Project `badcfg`: invalid `ark.yml` (as in ARK-T19).

## Steps and expected results

Scenario S1 (failing roles, OK omp): `ark status` with projects `a` and `b`.

- Exit 1. One line names role `reviewer`, model `openai-codex/gpt-6.1-solx`, cause model not found by omp; one line names role `validator`, harness `codex`, cause not installed. Project `b` prints no role line. Counter file has exactly one `models` call although two projects use omp.

Scenario S2 (all passing): `ark status` with projects `a-ok` and `b`.

- Exit 0, no role line, counter file has one call.

Scenario S3 (omp list fails, no other failure): FAIL omp, `ark status` with project `a-codex`.

- stdout has `role models: unchecked (` followed by the reason; no role failure line; exit 0 (unchecked alone does not fail).

Scenario S4 (omp list fails plus a real failure): FAIL omp, `ark status` with project `a`.

- stdout has `role models: unchecked (` followed by the reason and the `codex` validator line; no reviewer model line; exit 1 because of the validator.

Scenario S5 (no config): `ark status` with projects `a-ok` and `nocfg`.

- `nocfg` is reported as in ARK-T19 ("project nocfg has no ark.yml", "project config(s) invalid") and exit is 1 from that, not from a role check; `nocfg` gets no role line; `a-ok` gets none either. Repeat with `nocfg` holding no run folder (ARK-T18): not reported, exit 0.

Scenario S6 (invalid config): `ark status` with projects `a-ok` and `badcfg`.

- Prints the existing config error for `badcfg` and no role line for it; exit 1 from the config error; no crash.

Scenario S7 (scope): with project `a` failing, run `ark status <run>` for an open run and one other command (for example `ark runs`).

- No role line; the fake omp is not called (counter file unchanged).

## Screenshot checkpoints

none: CLI text; the proof is the captured stdout and exit code in the test result.
