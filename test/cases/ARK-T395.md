---
id: ARK-T395
title: ARK-T395 an agent gets the model Orca reports, else the last message of its newest session file, else the plan model, and a run lead gets the roles.chief model
level: integration
technique: "decision table over the sources of an agent's model (Orca, newest session file, plan, roles.chief), with a row for each fall-through and a model change inside one file as the boundary"
priority: high
risk: "the hub shows the wrong model for an agent: it reads a session file when Orca reports a model, reads an older file or an earlier message instead of the newest file's last message, keeps an older file's model when the newest file has none, shows no model where the plan or roles.chief has one, or marks a plan or configured model as if the agent ran it"
status: active
changed_by: 2026-11-13-ARK-332-1
---

## Objective

Prove that the hub snapshot gives each agent of a run the model from the first source that has one: the model Orca reports, else the last message of the newest session file in the agent's window, else the plan model (marked `planned`, source `plan`); and that a run lead with no model gets the `roles.chief` model (source `configured`).

## Preconditions

- A temp ARK_HOME with a project `p` whose roles hold `implementer`, `validator`, `reviewer` and `chief` (`claude`, `claude-opus`).
- A building run with 8 implementer steps, each with a plan model `plan/<step>` and its own time window, and a second building run with no steps and no session file.
- omp session files under a temp sessions folder, in the run workspace, one window per step:
  - `orca`: a file with `ignored-session`.
  - `single`: one file with `single-session`.
  - `newest`: two files: `old-session` (earlier start, older file time) and `new-session` (later start, newer file time).
  - `changes`: one file whose messages name `first-model`, `second-model`, `last-model`.
  - `emptynew`: an older file with `obsolete-model` and a newest file with no message.
  - `lastunknown`: a file whose messages are `known-model`, then `unknown`.
  - `noharness`: one file with `session-model`, and the Orca terminal reports no agent identity.
  - `bare`: no file.
  - One file before the first step: the run lead's, with `lead-session`.
- Fake `orca` that answers the terminals, runs and workers of both runs, and reports the model `orca/reported` for the `orca` worker only.
- The real hub server and the real snapshot. No mock of the model reader.

## Steps

1. Start the hub.
2. Wait for a snapshot in which the `changes` agent has a model.
3. Read `model` and `planned` of each agent of the first run, and of the run lead of the second run.

## Expected results

- `orca` shall show `orca/reported` and `planned: null`; the file `ignored-session` is not shown.
- `single` shall show `single-session`; `newest` shall show `new-session` (the newest file wins whatever the names and starts say); `changes` shall show `last-model`; the run lead shall show `lead-session`. In each, `planned` is null.
- When the newest file holds no message (`emptynew`) or its last message names no model (`lastunknown`), the agent shall show model null and `planned` = `{ harness: omp, model: plan/<step>, source: plan }`; the older model is not shown.
- `bare` (no session file) shall show model null and the plan model, source `plan`.
- `noharness` shall show the harness `omp` (the plan's) beside the model `session-model`, with `planned: null`.
- The run lead of the first run shall show harness `omp`.
- The run lead of the second run (no model anywhere) shall show model null and `planned` = `{ harness: claude, model: claude-opus, source: configured }`.

## Screenshot checkpoints

none: the case reads the snapshot data, not the screen. The e2e case ARK-T398 shows the configured model on the page.
