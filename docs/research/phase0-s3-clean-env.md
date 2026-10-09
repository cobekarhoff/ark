# Phase 0 S3: clean environment

Date: 2026-10-08. Method: pstack Prototype. Throwaway script (not kept). Scope: one service slice (cloud emulator, a docker-socket proxy, the service under test, a seed job), not the full multi-service stack.

Result: **pass.** A runner can stand up the slice from pinned revisions, seed it, health-check it, and tear it down, repeatably, without touching the engineer's checkouts, images, or dev stack. Verification cycle: 17–70 s (cold cache vs warm BuildKit cache).

## Recipe that worked

1. Clean source: `git archive <sha> | tar -x` of the environment repo and each needed product repo into a run folder. No worktree metadata lands in the engineer's repos. Record the revision vector.
2. Compose override per run:
   - `image: ark-<run>-<service>:<tag>`: run-scoped image tag. **Required.** The base file tags the service `:latest`, shared with the dev stack. Without the override, run 1 silently reused a 6-week-old dev image, and `--build` would have overwritten the engineer's image.
   - `container_name: !reset null`: removes the fixed name so runs can coexist with the dev stack (Compose v5.3.0).
   - `ports: !override` onto run-scoped loopback ports.
3. `docker compose -p ark-<run> ... up -d --build --wait <services>`, then run the seed job, health check, `down -v --remove-orphans`.

## Findings for Phase 1

1. **The environment recipe must own image identity.** Ark's verification runner always overrides image tags per run and forces `--build`. Record image digests in `environment.json`.
2. **Not fully hermetic yet.** The seed job installs an unpinned package from the network at start, the build pulls private packages using a build secret (held by the runner only, never by agents), and base images use tags rather than digests. Acceptable for Phase 1; list them as `limitations` in evidence.
3. **Fixed `container_name` is solvable per service** with `!reset null`. Other services need the same treatment before the full stack can run concurrently.
4. **The emulator may reach the host Docker socket** through a proxy. Irrelevant while unsandboxed; relevant when isolation returns.
5. **Product env tasks belong in the environment repo** (`ark/tasks/up|seed|health|down`) as this override plus commands, not in ark.

Product-specific findings live in the pilot environment repo.
