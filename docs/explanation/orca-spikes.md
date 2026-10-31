# Orca spikes: ARK-150 and ARK-151

Run on 2026-10-29 with Orca 1.4.237, Docker 29.6.1 and Docker Compose 5.3.0. Both spikes are a **go**. They also changed two parts of the design: how a run folder is laid out, and where Master Chief runs.

## ARK-150: side-by-side worktrees for a Clara run

**Question:** can Ark create worktrees at `<run>/repos/<name>` for two Clara repos, have Orca launch an agent into each, and have docker compose resolve against them?

**Result: go.**

| Check                                   | Result                                                                                                                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ark-made worktrees                      | `git worktree add` for `platform` and `shared/packages` under `~/.ark/projects/clara/runs/<run>/repos/`                                                                                  |
| Orca adopts them                        | After `orca repo add` and `orca repo set --external-worktree-visibility show`, `orca worktree list` shows both as `<repoId>::<path>`                                                     |
| Agent launched into each                | `orca agent launch --agent omp --worktree path:<worktree>`. Each agent's `pwd` and `git rev-parse --show-toplevel` were its worktree                                                     |
| Downstream sees an upstream-only change | A module added only in the `shared/packages` worktree was importable in `tenant-manifest-service`, and a file added only in the `platform` worktree showed in the service's source mount |

### What changed in the design

**The run folder is a mirror of the workspace.** The first layout held only the touched repos, which caused two problems:

- Agents lost the Clara root context. The agent's session had no reference to `clara-agentic-environment`, so it loaded no root `AGENTS.md`, no `knowledge/` and no `.mcp.json`.
- Compose needed a generated override, and the first attempt missed floci's `repos/platform/emulator` mount.

The fix is for `ark worktree create` to build the run folder as a mirror:

- Every root entry of the workspace except `.git` and `repos/` is a symlink (`AGENTS.md`, `CLAUDE.md`, `knowledge/`, `.claude/`, `.mcp.json`, `docker-compose.yml` and so on).
- Each repo the run touches is a worktree at its usual path under `repos/`.
- Every other repo is a symlink to the workspace checkout.

With the mirror:

- An agent launched in `repos/platform` loaded the Clara root `AGENTS.md` and `platform/CLAUDE.md`.
- `docker compose --project-directory <run>` resolved every `./repos/*` path into the run with no override file, and the service saw both changes.

### Open items

- **Workspace skills don't load.** OMP did not load Clara's `.claude/skills` (`factory-*`) from the mirror. It seems not to look for skills above the worktree's git root. ARK-158 needs to solve this, for example by pointing the harness at the workspace skills directory.
- **Image builds not tested.** We reused the existing `tenant-manifest-service` image. Building from a worktree context needs `~/.netrc` and an `linux/amd64` build, which ARK-159 covers.

## ARK-151: Master Chief → run lead → worker

**Question:** can Master Chief start a run lead, and can the run lead start a worker, without `nested_worker_depth_exceeded`? Do gate questions travel from the run lead to Master Chief to you and back?

**Result: go, once Orca's nesting depth is set to 2.**

| Check          | Result                                                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default depth  | Refused: `Sub-worker dispatch is not permitted at depth 2 (max 1)`                                                                                                                |
| Depth set to 2 | In Orca, Settings → Orchestration → Nested worker depth = 2. The run lead's Dispatch completed at depth 1, and its worker completed at depth 2 in the run lead's own Run          |
| `worker_done`  | The worker's report reached the run lead, and the run lead's report reached Master Chief's Run                                                                                    |
| Gate relay     | The run lead's `orca orchestration ask` reached Master Chief as a `question`. Master Chief put it to you, sent your answer back with `reply`, and the run lead received `approve` |

### What changed in the design

- **Master Chief must run inside an Orca terminal.** The spike ran Master Chief from a session outside Orca, which has no Orca identity. When the run lead ran `run-create`, it silently rebound that session to the run lead's own Run. Inside an Orca terminal, each agent has its own binding.
- **Bootstrap must check the nesting depth.** The setting is only in the desktop app, and no CLI reads it, so bootstrap asks you to set it to 2 and confirms by starting a throwaway nested worker.
- **Read history with `inbox`.** `check` consumes deliveries, so a message read by one `check` doesn't reappear. Use `orca orchestration inbox` to see history.
- **`run-use` takes `--id`,** not `--run`.

## Tickets that change

- **ARK-154:** `worktree create` builds the workspace mirror, and `ark test` runs compose with `--project-directory <run>`. There is no compose override.
- **ARK-156:** the `chief` playbook must run inside an Orca terminal.
- **ARK-158:** bootstrap checks the nesting depth, registers each nested repo in Orca with non-Orca worktrees shown, and makes workspace skills reachable.

The spike evidence is kept in `~/.ark/projects/ark/runs/2026-10-29-SPIKE-150-1/` and `2026-10-29-SPIKE-151-1/`.
