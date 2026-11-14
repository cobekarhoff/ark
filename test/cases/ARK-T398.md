---
id: ARK-T398
title: ARK-T398 a run lead without harness and model shows roles.chief of ark.yml, marked configured
level: e2e
technique: "decision table, the fallback row: the run lead has no model from Orca or a session file, so the config value shows"
priority: medium
risk: "the run page shows no harness and no model for a run lead that has none from Orca or a session file, though ark.yml names one in roles.chief; or the page shows the configured value as if the lead ran it, with no `(configured)` mark"
status: active
changed_by: 2026-11-13-ARK-332-1
---

## Objective

Prove that the run page shows, for a run lead with no harness and no model of its own, the harness and the model of `roles.chief` in `ark.yml`, each marked `(configured)`.

## Preconditions

- A temp ARK_HOME with a project `p` whose roles hold `implementer`, `validator`, `reviewer` and `chief` (`claude`, `claude-opus`).
- A building run `ARK-722` with no steps and no session file.
- Fake `orca` with one connected terminal `term-lead` that reports no agent identity and no model, and an Orca run whose coordinator is that terminal.
- The real hub server in a real browser (Playwright).

## Steps

1. Open the page of the run: `#run/<run>`.
2. Read the agent row with `data-role="run lead"`.

## Expected results

- When the run lead has no harness and no model, the page shall show `claude (configured)` and `claude-opus (configured)` in the run lead row.

## Screenshot checkpoints

none: the case reads the text of the row; ARK-T395 pins the data behind it.
