---
id: ARK-T655
title: ARK-T655 ark.yml companions entries load when each field is valid, and a bad trigger, a missing or escaping instructions file, a duplicate or unsafe name, a bad on list and a missing harness or model each stop the command with one `ark: <reason>` line
level: integration
technique: equivalence classes (one valid entry, one class for each refusal) and boundary values (on list of 0 and 1 triggers; name with a slash, `..` and a space; instructions path that leaves the project folder)
priority: high
risk: "a typo such as `run.merge` is stored and the companion never wakes, with no message; a missing instructions file starts a worker with no brief; a duplicate name makes two workers share one companions/<name>/ folder; a name or instructions path with `..` or a leading `/` lets a companion read or write outside the project folder; the new key breaks every ark command that has no companions block, or the loader crashes the other readers of ark.yml"
status: active
changed_by: 2026-11-14-ARK-480-1
---

## Objective

Prove the `companions` list of `ark.yml` is validated by the real loader: a good entry loads, and each refusal ends the command with exit 1 and one `ark: <reason>` line that names the entry and the field. Serves ARK-480/AC1.

## Preconditions

- A temp `ARK_HOME` and a temp project folder `projects/p/` with a minimal `ark.yml` and the instructions file `companions/docs.md` (the file of the entry, relative to the project folder).
- The command under test is the shipped `ark companions sync --project p`. Orca is the fake that fails every verb, so the case sees a validation refusal and never an Orca call.
- A valid entry: `name: docs`, `instructions: companions/docs.md`, `harness: claude`, `model: opus`, `on: [run.merged, run.started, criteria.opened, escalation, ci.failed]`.

## Steps

1. Run `ark companions sync --project p` with no `companions` key, then with `companions: []`.
2. Run it with the valid entry.
3. Run it once for each of these entries (all else valid), and keep stdout, stderr and the exit code:
   a. `on: [run.merge]` (unknown trigger).
   b. `on: [run.merged, nope]` (one good, one unknown).
   c. `on: []`, `on: run.merged` (a string, not a list), and no `on` key.
   d. `instructions: companions/missing.md` (file absent).
   e. `instructions: ../outside.md` and `instructions: /etc/hosts` (file exists, outside the project folder).
   f. Two entries with `name: docs`.
   g. `name: a/b`, `name: ..`, `name: has space`, `name: ""`.
   h. no `harness`, no `model`, no `instructions`, no `name`.
4. Run `ark status --project p` with the valid entry (another command that loads the config).

## Expected results

- Step 1: the config loads with no companions (same output as before this ticket); the loader returns no `companions` field, not an empty one; no Orca call.
- Step 2: the entry loads; the command gets past the loader (it fails later only on the fake Orca, never on the config).
- Step 3: each run exits 1 with exactly one line starting `ark: `, naming the entry (`docs` or its index) and the bad field and value (`run.merge`, `companions/missing.md`, `../outside.md`, `a/b`); no stack trace; nothing written under `companions/`. Case f names the duplicate name. Cases c and h name the field.
- Step 4: `ark status` loads the config and is not blocked by `companions is not a key`.

## Screenshot checkpoints

None. The surface is CLI output; no screenshot applies.
