---
name: ark
description: Entry point for Ark, the system that takes tickets to merge-ready changes. Use `/skill:ark chief`, `/skill:ark run-lead <run>`, `/skill:ark worker <run> <step>`, `/skill:ark bootstrap`, `/skill:ark retro <run>` or `/skill:ark retro interview`. Use it to run a ticket, plan or build one step of a run, onboard a project, close out a run, or interview the human across several runs.
---

# Ark

This skill is the only entry to Ark. It picks one playbook, loads it, and follows it.

## Pick the playbook

Read the first word of the arguments. It is the playbook name.

| Name | Arguments | Playbook file | Who runs it |
| --- | --- | --- | --- |
| `chief` | none | `playbooks/chief.md` | The human opens it in an Orca terminal. It is Master Chief. |
| `run-lead` | `<run>` | `playbooks/run-lead.md` | Master Chief starts it, one per run. |
| `worker` | `<run> <step>` | `playbooks/worker.md` | A run lead starts it, one per step. |
| `bootstrap` | none | `playbooks/bootstrap.md` | The human, once per project. |
| `retro <run>` | `<run>` | `playbooks/retro.md`, Part 1: Close check | The run lead writes `retro.md`, then Master Chief asks the human three questions. |
| `retro interview` | `interview` | `playbooks/retro.md`, Part 2: Deep interview | Master Chief, on request or every few runs. |

## Steps

1. Take the first word of the arguments as the name.
2. If the name is missing or is not one of the five above, or if it is `retro` without `<run>` or `interview`, do nothing else. Print this list and stop:

   ```text
   Unknown playbook "<name>". Use one of:
     chief                    Master Chief: evaluate, queue and supervise tickets
     run-lead <run>           Run lead: plan and drive one run
     worker <run> <step>      Worker: do one step of a run
     bootstrap                Teach Ark a new project
     retro <run>              Close check for one run
     retro interview          Deep interview across several runs
   ```

3. Check that the playbook has the arguments it needs. `run-lead` needs a run name, `worker` needs a run name and a step name, and `retro` needs a run name or the word `interview`. If one is missing, print the usage line from the table and stop.
4. Read the playbook file from this skill's folder, in full.
5. Follow it. Pass the remaining arguments to it as `<run>` and `<step>`.

## Rules for every playbook

- The `ark` command does the repeatable work: run state, worktrees, tests, MRs and metrics. Never edit `events.ndjson` or `state.json` by hand.
- Answers at a gate are the human's decisions. An agent never answers a gate for the human.
- Master Chief and run leads never write product code. Only an implementer worker does.
- Run folders live under `$ARK_HOME/projects/<project>/runs/<run>/`. `ARK_HOME` defaults to `~/.ark`.
