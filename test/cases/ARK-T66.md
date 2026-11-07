---
id: ARK-T66
title: ARK-T66 same_vendor_review is judged on a checker's own sessions, and helper models are listed apart
level: integration
technique: decision table on (checker own vendor equals implementer vendor) x (overlapping run lead vendor) x (helper call present); equivalence classes
priority: high
risk: same_vendor_review is true because of run lead, unassigned or helper messages, or stays false for a real same-vendor review; helper models leak into actual_models; helper cost is dropped from step cost
status: active
changed_by: 2026-11-07-ARK-348-1
---

## Objective

Prove that `same_vendor_review` is true only when a validator or reviewer step's own sessions used the vendor of an implementer step in the same repo, and that records with a `purpose` count for no vendor and are listed in `helper_models` with their cost. Serves ARK-348/AC2.

Expected: If a message belongs to the run lead, to an unassigned file or to a helper call, then the system shall not count it for any step's vendor.

## Preconditions

- Three temporary runs, each with an omp implementer step (Anthropic) and a reviewer step, one session file per step and one for the run lead, same repo and worktree.
  - Run A (true same-vendor): the reviewer's own file has Anthropic replies.
  - Run B (cross-vendor, overlapping lead): the reviewer's own file has OpenAI replies only; the run lead file has Anthropic replies inside the reviewer window.
  - Run C (helper call): as run B, and the reviewer's file also holds `{"type":"model_usage","purpose":"job-widget","model":"gpt-6-luna",...}` and one `"purpose":"find"` record with a `typesafe/jev-1.14` model and a cost; and an Anthropic helper record in the reviewer's file.
- An unassigned file with Anthropic replies in run B.

## Steps

1. Run `ark retro` on runs A, B and C.
2. Read `same_vendor_review`, `actual_models`, `helper_models` and the cost of the reviewer step in each `metrics.json`.
3. Run `bun test test/retro.test.ts`.

## Expected results

- Run A: `same_vendor_review` is true.
- Run B: `same_vendor_review` is false; run lead and unassigned Anthropic messages count for nothing.
- Run C: `same_vendor_review` is false, including with the Anthropic helper record.
- Run C: `actual_models` of the reviewer holds the OpenAI model only; `helper_models` lists `gpt-6-luna` and `typesafe/jev-1.14` (and the Anthropic helper model) with their cost.
- Run C: the helper cost is still part of the reviewer's step cost and of the run total.
- Older `metrics.json` files without `helper_models` still load in `comparison`.
- `bun test test/retro.test.ts` exits 0.

## Screenshot checkpoints

None. The surface is CLI output and JSON; no screenshot applies.
