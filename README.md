# Ark

Ark is an OMP plugin plus a deterministic `ark` CLI that takes a ticket across one or several dependent repos to merge-ready MRs with a complete, replayable record. Agents do the judgment and write the code; the CLI does everything mechanical. See [docs/prd.md](docs/prd.md).

## Dev setup

Requires [Bun](https://bun.sh) 1.4 and [OMP](https://omp.sh).

```sh
bun install         # dependencies
bun link            # puts `ark` on PATH (plugin install does not)
omp plugin link .   # installs this repo as an OMP plugin
bun test            # runs the tests
```

Undo with `bun unlink` and `omp plugin uninstall ark`.

## Run core

`ark` finds its project from the nearest `ark.yml` (`project:` key) above the current directory and keeps state under `$ARK_HOME` (default `~/.ark`): tickets in `projects/<project>/tickets/<ID>.md`, runs in `projects/<project>/runs/<date>-<ID>/`.

```sh
ark run start ARK-109                  # start the run, or show the existing one
ark advance <run_id> <event> [--data json]   # legal transitions only (cli/transitions.ts)
ark run replay <run_id> [--check]      # rebuild state.json from ledger.ndjson
ark gate packet <run_id> <G0|G1|G2|GE> # build gates/<gate>.<hash>.packet.md from run artifacts (each source listed with its sha256), print its sha256
ark gate answer <run_id> <gate> <answer> --packet <sha256>   # G0 accept|edit|abort, G1 approve|change|abort, G2 approve|send_back|abort, GE one_more_round|take_over|abort
```

Guardrail integrity (ARK-115). Trust model: v1 trusts the user's own processes (agents run as the user), so none of this stops a deliberate forger; it catches mistakes and bugs and makes honest runs auditable. See [docs/adr/0003-same-user-trust-for-v1.md](docs/adr/0003-same-user-trust-for-v1.md) for the decision.

- **Owned events.** `ark advance` refuses every event a command owns (`ws.created`, `test.*`, `trace.checked`, `gate.*`, `ge.*`, `mr.*`, `run.closed`, `route.chosen`, `findings.recorded`, `artifact.*`, `ac.*`), naming the command.
- **Hash chain.** Each ledger line carries `prev`, the sha256 of the previous line, and `state.json` records `ledger_seq` and `ledger_head`. Replay and every command refuse an edited, removed, reordered or cut-off line, naming the first bad seq. This detects accidental corruption and truncation relative to the cached head; it does **not** detect deliberate same-user tampering (anyone who can write the files can recompute the chain and the head).
- **Lock.** Writers hold `ledger.lock` (O_EXCL, naming its pid) around read-and-append. A lock is taken over only when its owner process is gone, never because it is old.
- **Resume.** `ark run start` on an existing run replays the ledger and rewrites a missing or stale `state.json`; the hook decides whether a run is open from the ledger, not `state.json`.
- **Attribution.** Product changes count only through recorded implementer steps: `build.completed`, `fix_round.started`, `ark trace-check`, the G2 packet and a G2/escalation answer refuse a worktree with commits to non-test files after its last recorded step head, an AC-tagged test changed after the newest recorded head (the validator's tests count once `ark test` ran on them), a HEAD that no longer descends from the recorded heads, or uncommitted files (including files hidden with `assume-unchanged`/`skip-worktree`), naming them. Git calls ignore `refs/replace`. The implementer guard diffs from the start of the step (the last recorded implementer head, or the HEADs recorded when a round started).
- **Gates.** A packet lists each source with its sha256 and is stored by hash. An approving answer rebuilds the packet and refuses when any source changed; the G2 packet binds `ac.yml` and `manual/*`, and a G2 approval recomputes the trace matrix.
- **Preflight** checks every model a role can reach, using OMP's own resolver and fallback functions rather than a copy of them: `cli/omp-models.ts` (the only file that imports OMP, run as a subprocess; the CLI core stays free of OMP imports) loads the installed OMP package (`omp` on PATH, or `$ARK_OMP_PACKAGE`), reads the effective settings (global and project) and walks the real fallback chain from every comma candidate of each role, through every reached model's own chain, until it is exhausted. Fuzzy selectors, thinking suffixes, wildcard entries and chain ownership therefore resolve exactly as OMP resolves them. If OMP cannot be loaded, preflight refuses. A refusal names the offending chain and the config file (project or global) that defines it. A subagent whose role has no working credential runs on the parent session's model whatever `retry.modelFallback` says, so what the `default` role (the orchestrator) can reach, with that model's own chain, also counts as reachable by `validate` and `review-x`: a `default` on the implementer's vendor is refused. `implement` and `review-s` are not widened this way, which keeps the PRD default (default on Opus, implement on Codex) valid. That is the only auth-fallback path checked statically: `implement` and `review-s` also fall back to the parent model, and with two vendors no static config can satisfy that for every role. So preflight requires `modelRoles.default` to be set (OMP otherwise picks a parent itself), and auth fallback to the parent model is not checked at all yet: auditing the model that actually answered each agent, from its session file, is planned under ARK-113 and does not exist today. The suite needs OMP installed (CI installs the pinned version).

## Merge requests

```sh
ark mr <run_id>   # in mrs_open: push each run branch with the CLI's own credentials, open a GitHub PR per repo via gh
```

Per repo it pushes the approved `head_sha` to `ark/*` branches only (refusing if the worktree HEAD moved since), using the origin URL from the main checkout's config, with credentials redacted from errors. The PR description carries the ticket's ACs, `trace-matrix.md` and the evidence paths relative to the run folder. An open PR from this repo into the default branch is adopted instead of opening a second; a closed or merged one is refused by name. Until every repo has an MR the run's next action is `open_mrs` (orchestrator). `mr: false` in `ark.yml` makes the G2 approval itself record `run.closed` (`mr disabled`), leaving ready branches. `ark advance` refuses `mr.opened`, `run.closed` and `ws.created`. There is no merge command, and `ark mr` only ever calls `gh pr list` and `gh pr create`; agents get no gh or merge tool (ARK-108 owns agent tool lists).

## Worktrees and tests

```sh
ark ws create <run_id> [--repo path]   # worktree at <run>/ws/<repo> on ark/<ticket>-<slug>, push URL disabled
ark test <run_id> --acs ID,.. [--repo name]              # run the AC-tagged tests in the worktree
ark test <run_id> --acs ID,.. --red-green [--repo name]  # base source + head tests must fail, head must pass
```

## Trace matrix

```sh
ark trace-check <run_id>   # write <run>/trace-matrix.md, record trace.checked; exit 1 with the reasons when it fails
```

Inputs: `ac.yml` (schema-valid, listing exactly the run's ACs; `level` per AC, default `e2e`), the latest `ark test` / `ark test --red-green` evidence per AC and repo, and `<run>/manual/<AC-ID>.md` for `level: manual` ACs (needs `signed-by:` and `at:` lines). Evidence counts only for a repo of the run, when its `head_sha` is that worktree's current HEAD and the worktree is clean (`git status --porcelain` empty) (and red-green's `base_sha` is the repo's recorded base). It fails on an AC with no passing tagged test (flaky is not passing), a test report naming an AC of this ticket that the run does not have (`unknown_tags`, recorded by `ark test`; other tickets' IDs are ignored), an e2e/integration/unit AC without red-green proof, and an unsigned manual AC. The matrix has no timestamps: identical inputs give identical bytes. `ark gate packet <run_id> G2` recomputes the matrix and refuses unless it passes and equals `trace-matrix.md` byte for byte.

Events owned by a command (`gate.*`, `ws.created`, `test.*`, `trace.checked`; the `owner` map in `cli/transitions.ts`) are refused by `ark advance`.

`.ark/repo.yml` lists suites (see [docs/prd.md](docs/prd.md)): `format`, `level`, `run` (with a `{tags}` selector; `$ARK_OUT` is `<run>/artifacts/test/<attempt>/`), `junit` (glob in the last path segment), optional `env.up`/`env.down`, and optional `tests` globs (default `**/*.test.ts`, `test/**`) that decide which changed files red-green overlays and which files the implementer step may not touch when they carry an AC tag. Optional `commands.build` runs in the temporary base worktree before the red run (dependencies are not checked in). Every suite runs for every `ark test`; give each suite its own JUnit file name. Each attempt saves JUnit, `<suite>.{stdout,stderr}.log` and `fingerprint.json` (git SHA, bun version, OS, `docker compose images` when an env is declared), and appends a `test.result` or `test.red_green` event.

`ark advance <run_id> implementer.completed --data '{"repo":"<name>"}'` refuses when base..HEAD of that worktree touches a test file carrying an AC ID, and otherwise records the head SHA.

`--red-green` also refuses until `implementer.completed` is recorded for every repo of the run.

## Router, agents, hook

Start with `/skill:ark ticket <ID>` (the skill is `disable-model-invocation`; it is still reachable as `skill://ark`). It runs `ark run start`, logs the route, copies `skills/ark/playbooks/ticket.md`'s steps into the todo list and names every CLI call per step.

```sh
ark preflight                                  # effective OMP config (modelRoles, retry.fallbackChains): every model validate and review-x can reach must be on another vendor than implement, every review-s model on the same one
ark log route [<run_id>] <playbook> "<why>"    # route.chosen, the first event after run.started (no run_id: the active run)
ark artifact record <run_id> <implementer|validator|reviewer> <file.json>   # schema-check an agent result, keep it as artifacts/<agent>/<n>.json
ark findings record <run_id> <file.json>       # judging state: bucket + reason per finding; act_on P0/P1 needs evidence {failing_test} or {trace_path}
```

`ark run start` runs the preflight first. Agents (`agents/`) bind the role aliases `@implement`, `@validate`, `@review-x`; the project `.omp/config.yml` maps them to models (verify selectors with `omp models <provider>`). Each agent's `output:` frontmatter is its `schemas/*.schema.json` and `structured: true` makes omp enforce it through `yield`; `ark artifact record` re-checks it. The validator's last step audits every AC-tagged test against `rules/test-audit.md` (`test_audit` in its output).

`extensions/index.ts` is a `tool_call` shim for the **main session only** (`ctx.agent.kind === "main"`; subagents, `/tan` clones and the advisor are `"sub"`). It calls `ark hook tool_call`, which blocks `edit`/`write`/`ast_edit` outside the active run folder or inside its `ws/` worktrees, any write to the run's `state.json` or `ledger.ndjson`, an edit/write that names no checkable path, and bash redirects/moves onto the two files. The active run is the id in `$ARK_HOME/projects/<project>/active-run`, written by `ark run start`; a done or aborted run no longer binds the session. A session that has no `ark.yml` above its cwd is never restricted.
