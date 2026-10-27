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
- **Preflight** checks every model a role can reach, using OMP's own resolver and fallback functions rather than a copy of them: `cli/omp-models.ts` (the only file that imports OMP, run as a subprocess; the CLI core stays free of OMP imports) loads the installed OMP package (`omp` on PATH, or `$ARK_OMP_PACKAGE`), reads the effective settings (global and project) and walks the real fallback chain from every comma candidate of each role, through every reached model's own chain, until it is exhausted. Fuzzy selectors, thinking suffixes, wildcard entries and chain ownership therefore resolve exactly as OMP resolves them. If OMP cannot be loaded, preflight refuses. A refusal names the offending chain and the config file (project or global) that defines it. A subagent whose role has no working credential runs on the parent session's model whatever `retry.modelFallback` says, so what the `default` role (the orchestrator) can reach, with that model's own chain, also counts as reachable by `validate` and `review-x`: a `default` on the implementer's vendor is refused. `implement` and `review-s` are not widened this way, which keeps the PRD default (default on Opus, implement on Codex) valid. The suite needs OMP installed (CI installs the pinned version).

## Merge requests

```sh
ark mr <run_id>   # in mrs_open: push each run branch with the CLI's own credentials, open a GitHub PR per repo via gh
```

Per repo it pushes the approved `head_sha` to `ark/*` branches only (refusing if the worktree HEAD moved since), using the origin URL from the main checkout's config, with credentials redacted from errors. The PR description carries the ticket's ACs, `trace-matrix.md` and the evidence paths relative to the run folder. An open PR from this repo into the default branch is adopted instead of opening a second; a closed or merged one is refused by name. Until every repo has an MR the run's next action is `open_mrs` (orchestrator). `mr: false` in `ark.yml` makes the G2 approval itself record `run.closed` (`mr disabled`), leaving ready branches. `ark advance` refuses `mr.opened`, `run.closed` and `ws.created`. There is no merge command, and `ark mr` only ever calls `gh pr list` and `gh pr create`; agents get no gh or merge tool (ARK-108 owns agent tool lists).

## Launch and doctor (ARK-118)

```sh
ark launch [omp args]   # the orchestrator session: omp --tools <read-only built-ins, write, edit, task, wait, ask, todo, ark_*> --no-lsp -e <this package>
ark doctor              # exit 1 unless the host's default branch includes admins, requires a PR with no bypass allowances and a status check, and forbids force pushes and deletion
```

`ark launch` is the supported way to run the router skill; a plain `/skill:ark` session still has bash (step 0 of the skill tells it to stop). The session has no `bash`, `eval`, `lsp` or `find` (omp offers only what `--tools` names for built-ins, so the `xd://bash` device is gone too; `ask` only in an interactive session). Every `ark` call except a gate answer is a typed `ark_*` tool (`tools/ark.ts`; they export `PI_SESSION_ID` the way omp's bash tool does, so the hook finds the run). The launcher passes the package **directory** to `-e`: omp scans `tools/` (and `skills/`, `agents/`) only for a directory, and `package.json` brings the hook, so it works in any project with or without the plugin installed. `write` and `edit` stay, confined to the run folder by the `tool_call` hook once the session is bound (after `ark_run_start`). Use `--tools`, not `bash.enabled: false`: that setting is global and takes bash from the subagents, which need it.

The `ark_*` tools are `hidden`: they exist only where `--tools` or an agent's `tools` lists them, so a subagent (whose agent file does not) never has `ark_mr`, and the extension additionally blocks an `ark_*` call from any non-main agent. There is **no gate-answer tool**: a gate answer comes only from the human typing `ark gate answer` in their own terminal (ADR 0002); the orchestrator shows the options with `ask` and waits.

Subagents run inside the orchestrator's process, so they share its environment; omp has no per-agent environment. `ark launch` therefore starts the whole process without git or gh credentials: `credential.helper=` (empty) at command-line scope through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` (it outranks system, global, repository and worktree config and resets every helper read before it; your own `GIT_CONFIG_COUNT` entries are kept), `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, `GH_CONFIG_DIR` an empty directory under `$ARK_HOME/credential-free/`, and `GH_TOKEN`, `GITHUB_TOKEN` and the enterprise variants unset. Your other git config (identity, hooks, signing) still applies. Only the `ark_mr` tool's child gets your own values of exactly those variables back, so `ark mr` needs `gh auth login` (keyring) or a git credential helper, not a token in the environment. https remotes only: ssh keys and the ssh agent are not touched. This stops an honest agent's `git push` and `gh` calls. It does not stop a deliberate one: `gh auth token` still reads the keyring, and the agent can set the variables back in its own shell (ADR 0003). `ark mr`'s credentialed push runs with `core.hooksPath=/dev/null`, so no hook of the source repository runs in it.

## Worktrees and tests

```sh
ark ws create <run_id> [--repo path]   # worktree at <run>/ws/<repo> on ark/<ticket>-<slug>, push URL disabled and a pre-push hook that refuses every push (an accident guard: `--no-verify` or editing the worktree config is same-user tampering, see ADR 0003)
ark test <run_id> --acs ID,.. [--repo name]              # run the AC-tagged tests in the worktree
ark test <run_id> --acs ID,.. --red-green [--repo name]  # base source + head tests must fail, head must pass
```

## Trace matrix

```sh
ark trace-check <run_id>   # write <run>/trace-matrix.md, record trace.checked; exit 1 with the reasons when it fails
```

Inputs: `ac.yml` (schema-valid, listing exactly the run's ACs; `level` per AC, default `e2e`), the latest `ark test` / `ark test --red-green` evidence per AC and repo, and `<run>/manual/<AC-ID>.md` for `level: manual` ACs (needs `signed-by:` and `at:` lines). Evidence counts only for a repo of the run, when its `head_sha` is that worktree's current HEAD and the worktree is clean (`git status --porcelain` empty) (and red-green's `base_sha` is the repo's recorded base). It fails on an AC with no passing tagged test (flaky is not passing), a test report naming an AC of this ticket that the run does not have (`unknown_tags`, recorded by `ark test`; other tickets' IDs are ignored), an e2e/integration/unit AC without red-green proof, and an unsigned manual AC. The matrix has no timestamps: identical inputs give identical bytes. `ark gate packet <run_id> G2` recomputes the matrix and refuses unless it passes and equals `trace-matrix.md` byte for byte.

Events owned by a command (`gate.*`, `ws.created`, `test.*`, `trace.checked`; the `owner` map in `cli/transitions.ts`) are refused by `ark advance`.

`.ark/repo.yml` lists suites (see [docs/prd.md](docs/prd.md)): `format`, `level`, `run` (with a `{tags}` selector; `$ARK_OUT` is `<run>/artifacts/test/<attempt>/`), `junit` (glob in the last path segment), optional `env.up`/`env.down` and `env.vars` (name→string map: the only variables a suite gets besides the allowlist below), and optional `tests` globs (default: bun's discovery, `**/*{.test,_test,.spec,_spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}`, plus everything under any `test/`, `tests/` or `__tests__/` directory, so helpers a test imports are overlaid too) that decide which changed files red-green overlays and which files the implementer step may not touch when they carry an AC tag. Suite commands and globs are read from `.ark/repo.yml` **as committed at the repo's `base_sha`**, so a config edit on the branch changes nothing. Both the green and the red run happen in clean temporary checkouts of the recorded SHAs (red: base plus the head's test files), never in the agent's worktree, so an untracked or uncommitted file cannot make a test pass. A checkout is written from the object database (no smudge filters, attributes or hooks, no `.git`), and a committed symlink that points outside it makes the run `inconclusive`. So does a submodule (a gitlink in either recorded tree): its files are not materialized, so `ark test` refuses with "submodules are not supported by ark test yet: <path>". Suites run with an allowlisted environment (`PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_*`, `ARK_OUT`) plus `env.vars` of the suite, never the caller's own. Optional `commands.build` runs in each checkout before its run (dependencies are not checked in, so put `bun install` or the like there). Only the suites that hold a selected AC run (see below); give each suite its own JUnit file name. Each attempt saves JUnit, `<suite>.{stdout,stderr}.log` and `fingerprint.json` (git SHA, bun version, OS, `docker compose images` when an env is declared), and appends a `test.result` or `test.red_green` event.

`ark advance <run_id> implementer.completed --data '{"repo":"<name>"}'` refuses when base..HEAD of that worktree touches a test file carrying an AC ID, and otherwise records the head SHA.

`--red-green` also refuses until `implementer.completed` is recorded for every repo of the run.

Two testcases with the same identity in one report (a test registered in a loop) are ambiguous: the AC is `inconclusive`. Every suite runs for every `ark test` (red and green): selecting suites by the tag text of their files would miss a test whose name is built at run time. Every suite must exit 0: a non-zero exit with no failing selected test (a file that fails to load, a runner or a step that fails, an empty report) fails a green run and makes red `inconclusive`, and no runner output is read to excuse an exit, because a suite's `run` is a shell command and nothing in its output says which step failed. So that a suite without the selected ACs still exits 0, a `bun-test` suite's `run` must contain `--pass-with-no-tests` (bun exits 1 on a `-t` that matches nothing); `ark test` refuses before running, naming the suite, otherwise. An AC tagged in no suite is `missing`. A suite must also report, in its own JUnit, a record for each selected AC its files carry (a command that runs nothing, like `true # {tags}`, reports none): that AC fails on green and is `inconclusive` on red. `unknown_tags` is read from the files of every suite, run or not, so a mistyped tag in an unselected suite still reaches trace-check.

Red needs a JUnit record per selected test with a failure or error; tests are told apart by file, describe path, name and line. A selected test with no record (a file that fails to load, a runner that did not start), or one that was skipped (on either side), makes the AC `inconclusive`, not red; a selected test that passes on base makes it `no-red` even when it is skipped on head; a head suite that has selected records and exits non-zero with no failing selected test fails the run (`fail` / `green-failed`). To prove a missing module, load it inside the test (`await import(...)`) so the failure is a recorded result.

## Router, agents, hook

Start with `/skill:ark ticket <ID>` (the skill is `disable-model-invocation`; it is still reachable as `skill://ark`). It runs `ark run start`, logs the route, copies `skills/ark/playbooks/ticket.md`'s steps into the todo list and names every CLI call per step.

```sh
ark preflight                                  # effective OMP config (modelRoles, retry.fallbackChains): every model validate and review-x can reach must be on another vendor than implement, every review-s model on the same one
ark log route [<run_id>] <playbook> "<why>"    # route.chosen, the first event after run.started (no run_id: the active run)
ark artifact record <run_id> <implementer|validator|reviewer> <file.json>   # schema-check an agent result, keep it as artifacts/<agent>/<n>.json
ark findings record <run_id> <file.json>       # judging state: bucket + reason per finding; act_on P0/P1 needs evidence {failing_test} or {trace_path}
```

`ark run start` runs the preflight first. Agents (`agents/`) bind the role aliases `@implement`, `@validate`, `@review-x`; the project `.omp/config.yml` maps them to models (verify selectors with `omp models <provider>`). Each agent's `output:` frontmatter is its `schemas/*.schema.json` and `structured: true` makes omp enforce it through `yield`; `ark artifact record` re-checks it. The validator's last step audits every AC-tagged test against `rules/test-audit.md` (`test_audit` in its output).

`extensions/index.ts` is a `tool_call` shim for the **main session only** (`ctx.agent.kind === "main"`; subagents, `/tan` clones and the advisor are `"sub"`). It calls `ark hook tool_call`, which blocks `edit`/`write`/`ast_edit` outside the active run folder or inside its `ws/` worktrees, any write to the run's `state.json` or `ledger.ndjson`, an edit/write that names no checkable path, `eval`, every `lsp` action that can apply edits, and bash redirects/moves onto the two files. Writable URLs are checked too: `conflict://`, `vault://`, `ssh://` and the other schemes that reach files are blocked, `local://`, `agent://` and `proc://` pass, and `xd://<tool>` applies this policy to the call in its JSON `content`. A path with a selector (`archive.zip:member`, `file:10-20`) is checked as every prefix before a colon, so a symlinked archive resolves to its real container. The run that binds the session is the one it started or resumed: `ark run start` records the run folder in `$ARK_HOME/bindings/<session id>` under the `PI_SESSION_ID` its bash tool exports, and the shim sends `ctx.sessionManager.getSessionId()` with every call, so the binding holds from any cwd and whatever the project's `active-run` pointer says. A session with no binding falls back to that pointer; with neither it is not an Ark session and nothing is restricted. A done or aborted run no longer binds the session. Fail closed: a binding whose run folder is gone, a pointer that names no run, or a run whose `state.json` cannot be read blocks every guarded call (bash still passes the redirect check, so `ark run start` can repair it). Paths with globs and `ast_edit` directories are checked at their literal prefix (the run folder itself is refused), and `edit` rename destinations are checked like paths. The hook is a speed bump; tampering is caught by the ledger's hash chain and by attributing worktree changes to recorded implementer steps (ARK-115). A session that has no `ark.yml` above its cwd is never restricted.
