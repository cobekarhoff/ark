---
id: ARK-T390
title: ARK-T390 ark status exits 1 and prints the unknown-key error when a project's ark.yml holds a typo
level: e2e
technique: state transition (valid config exit 0, same config with one typo exit 1), error guessing (the `merge_request: none` typo of the ticket)
priority: high
risk: `loadConfig` throws but `ark status` hides the error, takes the default and exits 0, or the exit code is 1 with no key in the output, so a person who typed `merge_request: none` is told nothing before a run pushes
status: active
changed_by: 2026-11-13-ARK-332-1
---

## Objective

`ark status` is the check a person runs after editing `ark.yml`. It exits 1 and prints the unknown-key error of ARK-T389, with the project name and the file.

## Preconditions

- A temp `ARK_HOME` with a project `demo` and a valid `ark.yml`.
- The harnesses of the roles in that `ark.yml` are on PATH (a stub `PATH` that holds each one), as in ARK-T166. Without them `ark status` exits 1 on `role ...: harness ... not installed`, so steps 1 and 4 would not show a valid config.
- The `ark` CLI run as a child process (`bun cli/ark.ts status`), with `ARK_PROJECT=demo`.

## Steps

1. Run `ark status`. Note the exit code.
2. Append `merge_request: none` to `ark.yml`. Run `ark status`.
3. Replace it with `concurency: 1`. Run `ark status`.
4. Fix the key (`merge_requests: none`). Run `ark status`.

## Expected results

- Step 1: exit 0.
- Steps 2 and 3: exit 1, and the output holds `config error: demo: <path>/ark.yml: ` followed by the key and the nearest valid key (`merge_request` ... `merge_requests`; `concurency` ... `concurrency`).
- Step 4: exit 0 again; the first run no longer meets a project that would push.

## Screenshot checkpoints

none: terminal output only; the proof is the exit code and the text.
