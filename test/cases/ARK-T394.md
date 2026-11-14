---
id: ARK-T394
title: ARK-T394 gates.manual in ark.yml stays an error, because the manual gate is never automatic
level: integration
technique: "error guessing (a value the schema once allowed: gates.manual set to auto) on an otherwise valid config"
priority: medium
risk: "a gates.manual setting in ark.yml loads without error, so a project turns the manual gate automatic and a manual criterion (analysis, inspection, demonstration) passes with no human answer"
status: active
changed_by: 2026-11-13-ARK-332-1
---

## Objective

Prove that a project config that is valid except for `gates: { manual: auto }` is refused, and that `ark status` exits 1 with an error that names `gates.manual`.

## Preconditions

- A temp ARK_HOME with a project `demo`: a git workspace, `ticket_source: local`, one valid e2e suite (`true {report}`), and the three roles `implementer`, `validator` and `reviewer`, each with a harness and a model.
- The project config also holds `gates: { manual: auto }`.
- Real `ark` as a child process. No mocks.

## Steps

1. Run `ark status`.
2. Read the exit code and the output.

## Expected results

- When `ark.yml` sets `gates.manual`, the system shall refuse the config, because the manual gate is never automatic: `ark status` exits 1 and the output names `gates.manual`.

## Screenshot checkpoints

none: a CLI exit code and text, no screen.
