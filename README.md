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
ark gate packet <run_id> <G0|G1|G2>   # build gates/<gate>.packet.md from run artifacts, print its sha256
ark gate answer <run_id> <gate> <answer> --packet <sha256>   # G0 accept|edit|abort, G1 approve|change|abort, G2 approve|send_back|abort
```

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

`.ark/repo.yml` lists suites (see [docs/prd.md](docs/prd.md)): `format`, `level`, `run` (with a `{tags}` selector; `$ARK_OUT` is `<run>/artifacts/test/<attempt>/`), `junit` (glob in the last path segment), optional `env.up`/`env.down` and `env.vars` (name→string map: the only variables a suite gets besides the allowlist below), and optional `tests` globs (default: bun's discovery, `**/*{.test,_test,.spec,_spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}`, plus everything under `test/`, `tests/` and `__tests__/`, so helpers a test imports are overlaid too) that decide which changed files red-green overlays and which files the implementer step may not touch when they carry an AC tag. Suite commands and globs are read from `.ark/repo.yml` **as committed at the repo's `base_sha`**, so a config edit on the branch changes nothing. Both the green and the red run happen in clean temporary checkouts of the recorded SHAs (red: base plus the head's test files), never in the agent's worktree, so an untracked or uncommitted file cannot make a test pass. A checkout is written from the object database (no smudge filters, attributes or hooks, no `.git`), and a committed symlink that points outside it makes the run `inconclusive`. Suites run with an allowlisted environment (`PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_*`, `ARK_OUT`) plus `env.vars` of the suite, never the caller's own. Optional `commands.build` runs in each checkout before its run (dependencies are not checked in, so put `bun install` or the like there). Every suite runs for every `ark test`; give each suite its own JUnit file name. Each attempt saves JUnit, `<suite>.{stdout,stderr}.log` and `fingerprint.json` (git SHA, bun version, OS, `docker compose images` when an env is declared), and appends a `test.result` or `test.red_green` event.

`ark advance <run_id> implementer.completed --data '{"repo":"<name>"}'` refuses when base..HEAD of that worktree touches a test file carrying an AC ID, and otherwise records the head SHA.

`--red-green` also refuses until `implementer.completed` is recorded for every repo of the run.

Red needs a JUnit record per selected test with a failure or error; tests are told apart by file, describe path, name and line. A selected test with no record (a file that fails to load, a runner that did not start), or one that was skipped (on either side), makes the AC `inconclusive`, not red; a selected test that passes on base makes it `no-red` even when it is skipped on head; a head suite that has selected records and exits non-zero with no failing selected test fails the run (`fail` / `green-failed`). To prove a missing module, load it inside the test (`await import(...)`) so the failure is a recorded result.

## Router, agents, hook

Start with `/skill:ark ticket <ID>` (the skill is `disable-model-invocation`; it is still reachable as `skill://ark`). It runs `ark run start`, logs the route, copies `skills/ark/playbooks/ticket.md`'s steps into the todo list and names every CLI call per step.

```sh
ark preflight                                  # .omp/config.yml modelRoles: validate and review-x must not share implement's provider, review-s must
ark log route [<run_id>] <playbook> "<why>"    # route.chosen, the first event after run.started (no run_id: the active run)
ark artifact record <run_id> <implementer|validator|reviewer> <file.json>   # schema-check an agent result, keep it as artifacts/<agent>/<n>.json
ark findings record <run_id> <file.json>       # judging state: bucket + reason per finding; act_on P0/P1 needs evidence {failing_test} or {trace_path}
```

`ark run start` runs the preflight first. Agents (`agents/`) bind the role aliases `@implement`, `@validate`, `@review-x`; the project `.omp/config.yml` maps them to models (verify selectors with `omp models <provider>`). Each agent's `output:` frontmatter is its `schemas/*.schema.json` and `structured: true` makes omp enforce it through `yield`; `ark artifact record` re-checks it. The validator's last step audits every AC-tagged test against `rules/test-audit.md` (`test_audit` in its output).

`extensions/index.ts` is a `tool_call` shim for the **main session only** (`ctx.agent.kind === "main"`; subagents, `/tan` clones and the advisor are `"sub"`). It calls `ark hook tool_call`, which blocks `edit`/`write`/`ast_edit` outside the active run folder or inside its `ws/` worktrees, any write to the run's `state.json` or `ledger.ndjson`, an edit/write that names no checkable path, `eval`, every `lsp` action that can apply edits, and bash redirects/moves onto the two files. Writable URLs are checked too: `conflict://`, `vault://`, `ssh://` and the other schemes that reach files are blocked, `local://`, `agent://` and `proc://` pass, and `xd://<tool>` applies this policy to the call in its JSON `content`. A path with a selector (`archive.zip:member`, `file:10-20`) is checked as every prefix before a colon, so a symlinked archive resolves to its real container. The run that binds the session is the one it started or resumed: `ark run start` records the run folder in `$ARK_HOME/bindings/<session id>` under the `PI_SESSION_ID` its bash tool exports, and the shim sends `ctx.sessionManager.getSessionId()` with every call, so the binding holds from any cwd and whatever the project's `active-run` pointer says. A session with no binding falls back to that pointer; with neither it is not an Ark session and nothing is restricted. A done or aborted run no longer binds the session. Fail closed: a binding whose run folder is gone, a pointer that names no run, or a run whose `state.json` cannot be read blocks every guarded call (bash still passes the redirect check, so `ark run start` can repair it). Paths with globs and `ast_edit` directories are checked at their literal prefix (the run folder itself is refused), and `edit` rename destinations are checked like paths. The hook is a speed bump; tampering is caught by the ledger's hash chain and by attributing worktree changes to recorded implementer steps (ARK-115). A session that has no `ark.yml` above its cwd is never restricted.
