# Phase 1 design: event-sourced pure reducer + effect executor

Planning only. Types and signatures are in `sketch/` (`tsc --noEmit --strict` passes on both `tsconfig.json` and the pure-layer `tsconfig.core.json`); the module map and call graphs are in `MODULES.md`. This revision incorporates the interrogate verdict (`interrogate-verdict.md`); "Interrogate changes" below lists what moved.

## Problem

Phase 1 must run the pilot ticket end to end (intake → analyze → plan → acceptance → plan gate → build → review panel → verify → QE → MR → CI → landing) as a background service that survives `kill -9` mid-build without starting a second writer. The hard parts are not the happy path. They are **recovery** (any crash, any step, must re-derive truth from durable records or stop as ambiguous), **single ownership** (ticket state, attempts, leases, artifacts each have one writer), **one boundary each** for schema validation, tamper detection and path checks, and **testing at real boundaries** without mocking ark's own modules. Constraints honored: SQLite append-only ledger with rebuildable projections (31), canonical JSON artifacts (33), typed stage kinds with declarative transitions and no embedded code (34), unsandboxed so tamper is detected after each attempt (44), thin harness adapters (S1: both CLIs are "spawn argv, JSONL out, SIGTERM kills the tree"), a clean verification environment per run with a run-scoped identity and private-package secrets held only by the runner (S3), and a verification input that is a *revision vector* of seven repos, not one sha (S4).

## Usage (caller's view)

Operator (CLI is a table over `ArkApi`; the dashboard calls the same seven methods):

```
ark serve &                                  # background service; exclusive lock on ~/.ark/ark.lock first, socket last
ark env add <path-to-environment-repo>
ark ticket new --id <ticket> --env pilot --title "..." --intent "..." \
  --base env=<sha> --base app=<sha>~1 --base lib=<sha> ...   # the multi-repo revision vector (7 repos in the pilot, S4)
ark run <ticket>
ark status                                   # board: stage, role, harness, model, elapsed, cost|unknown, repairs, leases
ark gate decide <ticket> --approve           # echoes view.gate.pins verbatim (the decision record); a different echo is refused
kill -9 $(pgrep -f 'ark serve'); ark serve & # recovery = replay + recovery-mode dispatch of in-flight effects; no flag, no command
ark resume <ticket> --to build --raise-cap-by 1   # after a repair_cap needs-human
ark verify <ticket> --check acc-missing-artifact-422   # defect repro: same handler, same slot lease, via the service
ark env unblock env:pilot                    # after a failed teardown tainted the environment
```

A transition rule under test is a pure call: no database, clock, or process (`sketch/usage.ts`):

```ts
const d = decide(atTwoRepairs, settled(key, { tag: "produced", artifact: reviewBlockers, usage: null }), world);
expect(d.events.map(e => e.type)).toEqual(["artifact.recorded", "repair.counted", "needs_human.raised"]);
expect(effectsOf(d)).toEqual([]);            // third failed round: no fourth Build is requested
```

State anywhere (dashboard, recovery, tests) is `replay(ticket, ledger.read(stream))`; cross-ticket facts are `foldWorld` over `ledger.readAll()`.

Adding a harness is one pure object, no lifecycle code: `HARNESSES["omp"] = { id, invocation({prompt, model, workdir}) -> {argv, env, configFingerprint}, parseLine(line) -> Signal[], usage(transcript) -> Usage | null }`.

Adding an effect kind forces its recovery policy: `Handler<K> = { run, recover }` with `recover` required (`"rerun"` or a probe), and `HandlerTable` is a mapped type over `EffectKind`.

Adding a stage instance is yaml only. A second human gate after planning:

```yaml
stages:      { design_gate: { kind: gate, approves: [plan], locks: false } }
transitions: { plan: { done: design_gate }, design_gate: { approved: acceptance, changes_requested: plan, rejected: needs_human } }
```

`parsePipeline(doc, roles)` rejects it if any outcome edge is missing or an engine rule is violated (the locking gate dominates every writing stage except its own artifacts' authors; verify dominates publish and routes `fail` to QE; every cycle passes a repair edge or a gate).

## Shape

**Data first.** Ticket state is `events.reduce(fold, emptyState)` and nothing else (`state.ts`), including the run's validated `Pipeline`, so `decide` takes no pipeline parameter and the engine keeps no second cache of it. Events are past-tense facts carrying everything `fold` needs, so replay never reads a file, re-runs `decide`, or consults a clock. The engine mints each inbound event's id and ts before `decide`; `decide` derives the ids of its own events; the ledger assigns only `seq`. Authoritative events and observations are separate types, so no fold accepts telemetry (decision 31 as a type). The attempt table, repair counter, locks, needs-human queue and gate are fields of that one state. Facts that span tickets (tainted environment, slot leases, env registry) are the second and only other fold, `World` (`world.ts`), derived from the same ledger. The dashboard row is `view(state)` over the engine's fold cache; there is no projection table to drift.

**All transition logic is one pure function.** `decide(state, inbound, world) -> {events, cancel, refusal?}` (`decide.ts`). Inputs are facts only: human commands, executor reports, and engine wake-ups. A single inbound can trigger a chain of transitions (build produced ⇒ head advanced ⇒ review entered ⇒ reviewers requested on the new head), so `decide` runs a **fold-as-you-emit accumulator**: every helper reads `acc.s`/`acc.w`, and `emit` folds each event into them immediately; an effect is stated once, as an `effect.requested` event. It owns edge selection, the shared repair cap (the `countsRepair` flag in the catalog, so a pipeline file cannot dodge it), bounded retries with feedback, lease acquisition (smallest free slot of a non-tainted resource), taint emission, and the building of every `EffectRequest`. `onSettled` has a fixed precedence (inflight lookup, taint unconditionally, repro regardless of status, then the status gate for flow effects), so a taint or a repro result is never lost to a ticket's status. Effect keys, lease slots and event ids derive from state, so `decide` is deterministic, and a duplicate or late report yields an empty decision.

**Effects are self-contained requests with a mandatory recovery policy.** An `EffectRequest` carries everything the executor needs (spec, guard, locked sets, full revision vector, lease, deadline or none). Each kind is a `Handler = { run, recover }`. `run` is idempotent per key and **never believes a stored verdict toward acceptance**. `recover` is **required** and is either `"rerun"` (run is safe from scratch because it cleans up first) or a probe over the effect's footprint answering `done` (adopt it), `absent` (start fresh), or `unknown` (a writer may exist and the footprint cannot say: the executor does not call `run`, reports `ambiguous`, and `decide` raises `needs_human`). Process-backed effects (agent attempts and the verification worker) share one mechanism, `proc.ts`: a detached wrapper holds a kernel `flock` on the effect's `claim` file for the life of its process tree, so liveness is "is the lock busy", with no pid, no start-time matching and no spawn-to-pid window; attempts therefore have no `unknown` case. First dispatch and crash recovery are the same executor call; recovery only adds the policy step. The log is the outbox: `effect.requested` commits in the same transaction as the decision that caused it, before dispatch.

**One boundary each.** Schema validation *and* cross-artifact truth: `admit()`, the only producer of `RecordedArtifact`. It runs `CATALOG[kind].admissible(body, inputs)`: QE `pass` needs a current verification `pass` for this head; every QE defect cites a failed check with existing evidence files; the review lead's blockers exist in the fan-out findings; acceptance rejection-style checks carry a positive control and every check declares limitations. Artifact bytes come back out through one function, `readArtifact`, which re-hashes against the ledger. Tamper, allowed paths, locks, git control surface, evidence integrity, head ancestry: the *seal* at the end of `attempt`, built on `guard.ts` (`pathsOutside` over `git diff --no-renames`, `inspectLocks` over locked roots plus per-file hashes so a file *added* under a root is caught) and `git.ts` (hardened flags; fingerprint of `.git/config`, hooks and `.gitattributes`). The seal kills the attempt's process tree before it reads anything, and it is a pure function of output plus git objects, so recovery **re-seals** instead of adopting a stored result. Control files live in a directory the agent is not told about; the only marker believed is one that can only push toward rejection. `decide` never re-checks; it sees `produced` or `rejected`. A rejected attempt is reset to `baseHead` before it reports.

**One verify path, one environment identity.** `verify` is one effect kind used by the flow stage and by `ark verify --check` (a non-flow request, same handler, same lease, `repro.recorded` instead of an edge). The cycle runs as a worker tree under the same wrapper as attempts, so a crash leaves something recovery can find and kill before the successor's teardown. Its compose project is `ark-<env>-s<slot>`, named by the leased slot; the first steps of every run reap the predecessor tree and `down -v` that project, so a successor cleans a crashed predecessor of any run. A teardown that cannot complete (or a tree that will not die) returns a `Taint`; `decide` emits `resource.tainted`, and World blocks every later verify for that environment until a human `resource.cleared`. Verification materializes the full revision vector (env sha plus every mounted repo; `base.env` is distinct from the config commit), hashes the *materialized* files against the lock, and writes the vector, lock roots, recipe and per-check limitations into `environment.json`; the `SHA256SUMS` digest goes into the ledger via `facts.sumsDigest`, which QE's seal and `publish` re-check. Outcomes are `pass | fail | flaky | env_failure`; `fail` goes to QE (which emits `defect`, or `check_invalid` for a human), `flaky` and `env_failure` go to `needs_human`.

**Interface depth.** Public surface: `decide` (one function plus `effectsOf`, essentially all policy), `Handler` (two members per effect kind), `ArkApi` (7 methods), `HarnessAdapter` (3 pure functions), `proc.ts` (4 functions shared by two handlers), one `CATALOG` row per artifact kind. Hidden: process groups, locks, footprint layout, SQL, transactions, git plumbing and flags, GitLab REST. Boundaries are compile-checked, not reviewed: `tsconfig.core.json` (`types: []`, `noResolve`) fails on any I/O or shell import in core; `HandlerTable`, `CATALOG`, `OutcomeTable` are mapped over their key unions (per *encode-lessons-in-structure*, *boundary-discipline*, *make-operations-idempotent*).

**Red-flag screen.** Shallow module: `cli.ts`/`api.ts` carry no policy and `submit` is refusal-aware. Split ownership: the footprint vs the ledger is the only duplicate record, a cache of an effect result never read for state and never believed toward acceptance; World is the single owner of cross-ticket facts instead of a side table; there is no projection table. Hand-synced lists: handlers, recovery policies, outcomes, facts and schema names derive from `EffectKind` / `ArtifactKind`; the `HandlerTable` literal in `cli.ts` is the single registration site. Two ways to do one task: recovery has no separate path; verify has no ledger-free entry; one git wrapper; one process mechanism. Importable internals: ledger reachable only through `engine.ts`, handlers only through the `cli.ts` composition root (dependency rule in CI, consistent with the call graph). Temporal decomposition: seal and launch live together in `attempt.ts`; the seal's lock check and verify's share `guard.ts`.

## Synthesis decision

Base A (reducer). The judge recommended B (durable step journal); overridden because ark's maintainers will be agents, and B's determinism contract makes a locally plausible edit to workflow code (a clock read, a `Promise.all`) break replay of live runs, while A confines policy to a pure function and compile-checked catalogs. Grafted from B: a required per-effect recovery policy (as `Handler.recover`, type-enforced), the crash-at-every-commit recovery test (`MODULES.md` §6), environment taint (`resource.tainted`/`resource.cleared`, folded in World), and locked roots with per-file hashes. Grafted from C: slot-named compose projects with a first-step `down -v`, and cross-artifact `admissible` inside `admit()`. From the judge: full revision vector, verify outcome classes, acceptance positive control plus `limitations[]`, and a single verify path. Rejected: B's workflow-as-code and its `RunLog` second writer surface; C's filesystem-as-flow-authority and `ps`-environment liveness.

Adaptations made while folding (accuracy notes): B's probe verdicts map onto A's detached-process design as `done` meaning "adopt" (attach, re-seal, or report a reaped death as `interrupted`), so attach survives; C's slot lease became folded World state (allocated in `decide`) rather than an executor-side semaphore; `decide` takes `world` because taint and leases span tickets; the QE-vs-verification guard moved out of `decide` into `admit` so the rule exists once.

## Tradeoffs accepted

- We accept 8 core files of event/state/effect/world vocabulary (more types than a mutable `tickets` row plus step table) in exchange for one recovery path, free replay-based tests, and state that cannot drift from the log.
- We accept at-least-once effects (verify reruns from a freshly torn-down slot; an interrupted attempt reruns from `baseHead`, discarding partial work since S1 shows no resume) in exchange for ambiguity only where a writer may exist and cannot be proven: a foreign branch on publish, a worktree at another sha on prepare, a reaped tree that will not die.
- We accept that taint is cleared only by a human, so after a teardown escalation the engineer takes two actions (`resume`, then `env unblock`) in exchange for never running verify on an environment that may hold fixed-name residue (S3 finding 3).
- We accept that changing `fold` or an event shape can invalidate old ledgers. Phase 1 ledgers are disposable; events carry a schema version and fold rejects unknown ones. Upcasters wait until a ledger must outlive a release.
- We accept a full refold per ticket and a World refold at startup (O(events)). `// ponytail:` snapshot only when it exceeds ~100 ms.
- We accept that `HarnessAdapter` is smaller than spec §11 (no `launch/cancel/reattach`): both harnesses share one process contract. A non-CLI harness would add an optional `launch` override then.
- We accept that timeouts and ambiguous effects never auto-retry, and that rejected/crashed attempts retry up to `maxRetries` (default 2) outside the repair cap.
- We accept clients reaching state only through the service socket, so single-writer has no exceptions. The dashboard pays one local hop.
- We accept a test-only `crash` option on `openLedger` (one branch on an option; TypeScript has no build-time switch) and labelled crash points in handlers, in exchange for the recovery claim being a test that runs, not a table in a doc.
- We accept observations in the same table as facts (volume), excluded from folds by type and deduped by deterministic id.
- Reviewers fan out in private detached worktrees; without them one rejected sibling would contaminate another's seal.
- We accept one global serial queue for decide+commit (effects still run concurrently) in exchange for stating cross-ticket lease safety once, in the engine, instead of in the absence of an `await`. Phase 1 runs one ticket at a time.
- We accept a dependency on native `fs-ext` flock(2) in exchange for liveness with no pid file, no start-time match and no ambiguous spawn window. Its Node launcher passes the locked descriptor into the shell process tree, so the kernel releases it only after the last inherited descriptor closes.
- We accept that the protections against an unsandboxed agent are detection and refusal on the likely paths (re-seal on adoption, hardened git, evidence digests, peer-pid refusal of human commands, per-attempt emit tokens), not prevention. A same-user process that deliberately escapes the process tree can still do harm; the manifest says "unsandboxed" and Box (decision 43) is the real fix. The lock covers files under its roots only (stated in `contracts.ts`).

## Alternatives considered

- **Durable step journal / workflow-as-code (B).** Strong on recovery (every step declares rerun/probe/unknown) but replay determinism is a discipline imposed on arbitrary code: a clock read or `Promise.all` in a workflow breaks live runs, and it needs a version fence plus a lint. It also keeps a second write surface (`RunLog`). Lost on agent-maintainability and single ownership; its recovery vocabulary, taint and crash test were adopted instead.
- **Filesystem as flow authority with a per-tick reconciler (C).** Small and testable, but flow lives in folders while the ledger is a witness (split authority), and liveness depends on `ps` showing a process's environment. Lost on single ownership and recoverability; slot naming and `admissible` were adopted.
- **Mutable ticket row + step table with per-step resume code.** Every step needs its own "was I interrupted here?" branch and state lives in the row and the process. Lost on recoverability.
- **Outbox table + independent workers mutating state rows.** At-least-once, but splits state ownership between workers and the orchestrator.

## Phase 1 build order

Each unit ends in a check against real boundaries (real git, real subprocess, real Compose, a real HTTP stub for GitLab). Dependency order.

1. **Core: `ids`, `contracts`, `pipeline`, `events`, `state`, `world`, `decide`.** Check: replay tests over literal event lists for the default pipeline's happy path, the repair-cap path (3 failures ⇒ `needs_human`, no effect), retry-with-feedback, chained transitions (build produced ⇒ reviewers requested on the advanced head), fan-out join sees every reviewer, pin-echo mismatch refusal, taint emitted before the status gate, repro recorded while `needs_human`, `material_change` re-locking through the gate, prepare-failed resume, taint and slot waiting, `parsePipeline(doc, roles)` accept/reject of the rule set; `tsc -p tsconfig.core.json` green. No I/O exists yet.
2. **`ledger`.** Check: real SQLite file; atomic batch (ledger assigns only `seq`), epoch fence rejects a second opener's commit, UPDATE/DELETE trigger, observation id dedupe, full refold equals the incremental cache, crash `before`/`after` at commit `N` leaves exactly the durable prefix.
3. **`git` + `guard` + `admit`.** Check: temp git repos for edited lock, deleted lock, file added under a locked root, rename into scope from outside scope, history rewrite, a hook in `.git/config`, a `.gitattributes` export-ignore on a locked file (caught by hashing materialized files); schema rejects; `admissible` cases (QE pass vs failed verification, defect without evidence, blocker absent from the fan findings, rejection check without positive control); admit is idempotent on content; `readArtifact` throws on a tampered file.
4. **`flock` + `proc` + `attempt` handler + harness adapters + `executor`.** Check: scripted harness script plus `parseLine`/`usage` over recorded S1 JSONL for both CLIs; kill the service with the harness running and attach; kill the harness group while down and observe `interrupted`; a wrapper spawned but not yet locked loses the race to `abandoned`; forged `outcome`/`exit` files under the control dir change nothing (re-seal); a backgrounded child is killed before the seal; deadline and cancel leave no process group; read-only worktrees are removed.
5. **`prepare` + `engine` + `api`/`cli` through the plan gate.** Check: `ark env add` on a fixture environment, `ark ticket new --base ...` resolves a historical vector, `ark run` with the scripted harness reaches the open plan gate; a second `ark serve` exits at the process lock having opened nothing; `ark gate decide` with an echo that differs from `view.gate.pins` is refused; human commands from inside an attempt's process tree are refused; approval writes `locks.pinned` with roots and per-file hashes; restart at each stage resumes.
6. **`verify` against real Compose.** Check: S3/S4 recipe over the full revision vector: the acceptance check fails at the pre-change revision and passes at the fixed revision; kill mid-run then successor on the same slot tears down and passes; forced failed `down` taints and blocks the next lease until `ark env unblock`; `ark verify --check` repro through the service.
7. **`forge` against a GitLab REST stub.** Check: `publish` rerun from every footprint state yields exactly one MR; foreign branch sha and duplicate MR yield `ambiguous`; `forge.wait` maps pipeline and merge states including `infra_failure`.
8. **The crash-at-every-commit acceptance test (`MODULES.md` §6).** Check: the full golden run with one injected QE defect, then the matrix over every commit and every handler crash label; normalized outcome (terminal state, per-kind `outcome` and `facts`, repair count; not hashes) equal to golden, exactly one MR, no live claim locks or compose projects.
9. **Minimal dashboard (client of `ArkApi`).** Check: board, needs-human queue with plan approval, ticket view with rendered plan/acceptance, evidence viewer (logs, HAR); driven end to end through the same API calls as the CLI.
10. **`ark doctor` + `ark-onboard` skill + plugin packaging.** `ark doctor` reuses `prepare.loadEnvironment` and the `verify` handler; no new state. Package the Claude Code plugin (skills, `/ark onboard`, `/ark run`) over the core CLI. Check: on a throwaway single-repo fixture (one service, one Compose file), `/ark onboard` in a real harness drafts `ark/`, `ark doctor` passes all six checks with a report; a deliberately broken contract (fixed container name reused, canary without positive control) fails doctor with the specific reason. Then run `/ark onboard` against the pilot environment to produce its `ark/` config; the engineer reviews and commits it.
11. **Live pilot-ticket replay.** Check: real Claude Code, base at the pre-change revision, using the onboarded config, real GitLab project (or the stub): MR with a green evidence bundle, then acceptance criteria 2–5 live (locked-check edit blocked, wrong build ⇒ defect ⇒ cap ⇒ needs-human, kill mid-build, dashboard fields).

## Interrogate changes

Applied from `interrogate-verdict.md` (operator approved all "Act on" and "Consider" items):

| Verdict item | Change |
|---|---|
| Act on 1: stale state inside `decide` | `decide` keeps a fold-as-you-emit accumulator (`acc.s`, `acc.w`); documented in the `decide.ts` header. The engine mints inbound event ids (ULID) and ts; `decide` derives its own ids; the ledger assigns only `seq` (`Draft` = no `seq`). `Pipeline` moved into `RunState`; `decide(state, inbound, world)` has no pipeline parameter. `effect.requested` is emitted by `decide`; `effectsOf(d)` derives the list. `onSettled` precedence fixed: inflight, taint, repro, status gate |
| Act on 2: second writer | `serve` takes the exclusive `flock` on `~/.ark/ark.lock` first (`flock.ts`); the socket binds last; the epoch fence is a backstop. One global serial apply queue replaces per-stream chains and the no-`await` invariant |
| Act on 3: tamper holes | Control files in `.ctl/` (not told to the agent) vs `out/` (told); no stored outcome: adoption re-seals; `rejected.json` is the only believed marker and only toward rejection. `readArtifact` re-hashes; `facts.sumsDigest` in the ledger, re-checked by QE's seal (`Guard.evidence`) and by `publish`. `git.ts`: hardened flags, `gitFingerprint`, `git_tampered` on config/hooks/`.gitattributes` changes. verify hashes materialized files (`inspectMaterialized`). The lock scope limitation is stated in `contracts.ts` |
| Act on 4: review panel collapse | Join inputs are the fan slots' artifacts as a list (`AttemptSpec.fanInputs`, `AdmitInputs.fan`); `admissible(review)` checks blockers against all of them; `review_findings` facts carry finding ids |
| Act on 5: locks vs authors | `guardFor` exempts the role producing a locking gate's approved kinds; `locks.pinned` replaces; "never shrinks" removed; `build.material_change → plan` |
| Act on 6: base vector | `TicketInput.base`/`BaseSpec` on `ticket.created` and `ark ticket new --base`; `RevisionVector` in the manifest; `manifest.env.configCommit` separate from `base.env`; `RepoPin` no longer carries shas |
| Act on 7: liveness | `proc.ts`: detached wrapper holds a `flock` on `claim`; states `absent/alive/exited/dead`; `abandoned` marker closes the spawn race; the attempt `unknown` case and its crash label are gone. Seal kills the process group first (`reap`); verify's cycle runs as a worker under the same wrapper; per-attempt worktrees are removed after the outcome |
| Consider: casual agent access | `serve` takes an agent-peer check (`Executor.isAgentProcess`) and refuses `submit` from inside a live tree; `emit` needs the per-attempt token |
| Consider: QE vocabulary | `qe_report` is `pass \| defect \| check_invalid`; `flaky`/`env_failure` removed from QE; `check_invalid → needs_human`, not counted |
| Consider: waits | `timeoutMs: null` for `forge.wait`; `heartbeat` observation signal |
| Consider: prepare dead end | `HumanChoice.resume.to` may be `null`; resume with `run === null` re-requests `run.prepare`; `TicketState.prepares` counts keys |
| Consider: crash matrix | Compares outcomes and facts, not hashes; MODULES now says on demand, before sign-off, real pilot-service slice (CI keeps a cheap compose-free subset) |
| Consider: `parsePipeline`, dependency rules | `parsePipeline(doc, roles)` called from `loadEnvironment`; `loadEnvironment` injected into `Engine`; `Engine.start` opens the ledger; `cli.ts` is the composition root and sole handler importer |
| Consider: `tickets` table | Deleted (`project`, `TicketRow`, three ledger methods); `view(state)` over the fold cache is the projection |
| Consider: gate pins | CLI echoes `view.gate.pins`; refusal renamed `pins_mismatch`; documented as the decision record, not a second safety |
| Noted nits | `world.holders` removed (one lease map); one usage representation (`Usage` or `null`; `basis` has no "unknown"); stream comment fixed (`world`, `obs:<id>`); `COMMANDS` is `pipeline.ts`' and the CLI table is `CLI_COMMANDS`; `scripted` harness lives only in test tables (`makeAttemptHandler(harnesses)`); `stage.waiting` has no stale `why`; observations in `obs:<id>` streams so versioning is authoritative-only; `ARK_CRASH` is now a ledger option, honestly described; `route` wrapper deleted |

Not applied: none rejected. Considered and kept as is: verification slot arithmetic (`acquire`, `projectName`) stays, because spec §13/§17 lets a project declare more slots once S3's `container_name: !reset null` is applied to its services; with `slots: 1` it reduces to a single lease.

## Implementation reconciliation

Unit 1 (`src/core/`: `ids`, `contracts`, `pipeline`, `events`, `state`, `world`, `decide`, plus `effects` ported unchanged). Where the sketch was silent or could not be implemented as written, the smallest change:

- **`hash.ts` (new core file).** `Pipeline.hash` is "of the canonical form" and core may not import `node:crypto`, so core carries a pure `sha256` and `canonicalJson` (checked against the published vectors). `decide` also uses `canonicalJson` to compare a gate echo with the open gate's pins. Shell code hashing file bytes still uses `node:crypto`.
- **`ids.ts`: `effectKeyParts` added.** Keys are `ticket/run/stage/visit/slot/n`; the inverse lets `decide` tell a late report for an earlier stage visit (ignored: audit-only) from one for the current visit, which the status check alone cannot (needs_human then resume re-enters a running stage while the old effect is still reporting). `parsePipeline` therefore restricts stage ids to `[A-Za-z][A-Za-z0-9_-]*` and forbids `prepare`/`repro`; `effectKey` throws on a `/` in a part.
- **State has two more fields.** `TicketState.prepare = {runId, inflight}`: the sketch had no place for the run-less prepare request (`onSettled` step 1 needs it) or for a run id that stays stable across `resume` of a failed prepare (so the retry finds its own footprint). `RunState.reproRequests`: the visit of the next repro key must count requested repros, not recorded ones, or two repros requested before the first settles collide.
- **`needs_human.raised` cancels flow effects at raise time** (`Decision.cancel`), instead of only at recovery: a timed-out reviewer otherwise leaves its sibling running. Repros are never cancelled.
- **`guardFor(acc, stage, role)` takes the stage.** The evidence guard applies to an agent stage whose `in` contains `verification` (derived from the pipeline) rather than to "the qe role", which core has no way to identify. The lock exemption is role-level, as in `parsePipeline`: a role is exempt iff some stage with that role produces a kind approved by a `locks: true` gate. `locks.pinned` takes the `pinned` lock sets of every approved kind's current artifact (only acceptance has any).
- **`parsePipeline` rule details.** "Dominates" is reachability from `entry` with the dominating stages removed; several locking gates (or verify stages) count together. Added: `entry` is not `ark.publish`; a gate approves at least one kind; `in` kinds must be produced on EVERY path to the stage; `material_change` must reach a locking gate (a `needs_human` target is rejected). Documents use the yaml's snake_case keys; the returned `Pipeline` is camelCase.
- **Catalog body fields.** `CATALOG` needs body field names; they are listed in `contracts.ts` (snake_case, the contract with `schemas/*.v1.json`). `review`'s outcome is derived from `blockers` (present ⇒ `blockers`), not stored. `REPAIR_REASON` (kind ⇒ `repair.counted` reason) lives next to `countsRepair`.
- **Refusals** are decided against the pre-inbound state (`refusalFor`) before anything is folded; `ticket.created` for an unregistered env is `env_unknown`. Timeouts for `run.prepare` (10 min), `publish` (5 min) and the wait poll (30 s) are constants in `decide.ts` (`ponytail:` until a manifest knob is needed).
- **Unit 4 shell lifecycle.** `flock.ts` uses the native `fs-ext` addon (Node >=26; macOS arm64 build verified); installation requires node-gyp build tooling. `proc.ts` launches a Node lock holder that locks before checking `abandoned`, records its pid, then passes the descriptor to the wrapper tree. `attempt.wait` treats writable `exit` as a hint, confirms the wrapper leader has ended before sealing, then reaps descendants and re-derives admission from output and git. Shell tests use installed `@types/node` and `@types/fs-ext`.
- **Unit 4 exercised evidence (2026-10-09).** The real scripted subprocess smoke passed for both Claude Code and OMP adapters (2/2). The full suite passed (156/156), including service SIGKILL with attach, harness-group SIGKILL with interrupted recovery, abandoned spawn-race refusal, forged outcome/exit hint resealing, descendant group reap, deadline/cancel cleanup, and read-only worktree removal; both `tsconfig.json` and `tsconfig.core.json` typechecks passed. No evidence-backed source defect was found in this review.

## Open questions and risks

Resolved by the operator (2026-10-08):

- Locked-check edit or out-of-scope diff: reset, retry with feedback up to `maxRetries`, then `needs_human` (as sketched).
- `classify`, `reclassify`, `qms_gate`: omitted from the Phase 1 pipeline; added in Phase 2 as stages.
- Phase 1 evidence: MR description only (SHA256SUMS, revision vector, local bundle path); retained GitLab upload in Phase 2.
- Crash matrix: always runs against the real pilot-service slice, not a minimal fixture. Accept the long runtime; unit 8 is run on demand and before Phase 1 sign-off, not on every change.

Still open:

- A locked-input mismatch discovered by `verify` is reported as `env_failure` (bundle reason "locked inputs differ") and goes to `needs_human`; the seal already catches tamper earlier. Is one reason string enough, or should it be its own outcome?
- `check_invalid` always goes to a human. Is there a case where QE should send a bad check back to the Acceptance Author without a full plan gate?
- Node cannot read a unix-socket peer's pid. Native `fs-ext` provides flock(2) on supported local filesystems; peer-pid refusal still needs a native addon or helper, or the human-command refusal could rely on an ark-issued CLI session token.
- CI `blockers` vs `infra_failure` is classified from GitLab job `failure_reason`; Arbiter's finding format is unspecified (decision 5). Is `failure_reason` plus failed job names enough input for the repair build in Phase 1?
- Claude Code flags that pin inherited config (`--strict-mcp-config`, `--settings`) are unverified (S1); `configFingerprint` records whatever is used, but reproducibility depends on that spike.
- Does discarding partial builder work on an interrupted attempt (reset to `baseHead`) cost enough to justify a resume path later?
- The peer-pid refusal and emit token stop the casual path (a backgrounded agent job running `ark gate decide`); they do not stop an agent that spawns a process outside its tree (decision 44). Acceptable for Phases 0-1?
- Verify slot capacity is per environment (`recipe.slots`, default 1); agent-slot limits are not modelled in Phase 1 (one ticket at a time, reviewers fan out unlimited). Phase 3 adds them as another leased resource through `acquire`. Right deferral?

## Next implementation step

Write `core/` (`ids`, `contracts`, `pipeline`, `events`, `state`, `world`, `decide`) with a replay-driven test for the default pipeline's happy path and the repair-cap path, before any I/O exists.
