# Phase 1 modules: event-sourced reducer + effect executor

Synthesized design (see RATIONALE.md "Synthesis decision" and "Interrogate changes"). Types and signatures: `sketch/*.ts` (`tsc --noEmit --strict -p sketch/tsconfig.json` passes; `sketch/tsconfig.core.json` checks the pure layer alone). `sketch/usage.ts` is deleted at implementation.

Ticket state is `fold(events)`. `decide(state, inbound, world)` owns every transition. A thin executor performs effects and reports outcomes back as events. Recovery is replay plus re-dispatch of whatever is still in flight, under a recovery policy each handler must declare.

## 1. Module map

Two layers. **core** is pure: no `node:*`, no DOM, checked by `tsconfig.core.json` (`lib: ES2022`, `types: []`, `noResolve: true`, explicit `files`), so an `fs`/`fetch` use or an `import "./attempt"` in core fails the build (verified on the sketch with a negative test). **shell** does all I/O.

| Module | Layer | Owns (single owner of) | Never does | Imports |
|---|---|---|---|---|
| `ids.ts` | core | Branded ids; `effectKey` (only idempotency-key constructor) | | – |
| `contracts.ts` | core | `CATALOG`: kinds, outcome vocab, repair-spending outcomes, `headBound`, facts, pinned roots, **`admissible`** rules; `LockSet`; `CheckSpec` (positive control, limitations) | Validate JSON (admit does) | ids |
| `pipeline.ts` | core | `Pipeline`/`Stage`, `parsePipeline(doc, roles)` engine-rule checks, `COMMANDS`/`WAITS`, `RunManifest`/`RoleBinding`/`VerifyRecipe`/`RevisionVector` | Read files | ids, contracts |
| `effects.ts` | core | `EffectRequest`/`EffectSpec`/`Outcome`/`Guard`/`Lease`/`Taint`/`BaseSpec`: the contract with the executor | | above |
| `events.ts` | core | Event vocabulary; authoritative vs observation by type; ticket vs world stream; `Draft` (no `seq`) | | above |
| `state.ts` | core | `TicketState` (carries the run's `Pipeline`), **`fold`**, `view`, `current()` staleness rule, `revisionVector` | I/O, clock, `decide` | above |
| `world.ts` | core | `World`, **`foldWorld`**: env registry, tainted resources, slot leases; `acquire`; `projectName` | I/O | above |
| `decide.ts` | core | **All transition logic**, via a fold-as-you-emit accumulator: edges, repair cap, retries, gates, lease acquisition, taint emission, request building, guard resolution | I/O, clock, reading artifact files | above |
| `ledger.ts` | shell | SQLite log, epoch fence, atomic commit (assigns `seq` only), test-only crash hook | Interpret events, hold projections | events (types) |
| `engine.ts` | shell | Global serial loop `inbound → decide → fold → commit → dispatch → wake`; mints event ids and ts; fold caches; recovery pass | Transition logic | decide, state, world, ledger, executor |
| `executor.ts` | shell | `Executor.run/cancel/emitTokenValid/isAgentProcess`, deadlines, `HandlerTable` (mapped over `EffectKind`; **`recover` required**) | Ticket state, leases | effects |
| `flock.ts` | shell | The kernel-lock primitive (service singleton, effect liveness) | | – |
| `proc.ts` | shell | Detached lock-guarded process trees: `launch`, `inspect`, `reap`, `tail`. Shared by `attempt` and `verify` | Interpret results | flock |
| `git.ts` | shell | Every git invocation (hardened flags), `gitFingerprint` | | – |
| `attempt.ts` | shell | `attempt` handler, `HARNESSES`, **the seal** | Choose next stage | effects, admit, guard, proc, git |
| `guard.ts` | shell | `pathsOutside`, `hashLocked`, `inspectLocks`, `inspectMaterialized`, `evidenceDigest`: the only tamper rules | | contracts, git |
| `admit.ts` | shell | **Only** constructor of `RecordedArtifact`; schema + `admissible` + hash + store; `readArtifact` (re-hash) | | contracts |
| `verify.ts` | shell | `verify` handler for flow AND repro: slot teardown, full-vector materialization, checks, evidence, redaction; the worker body | Interpret failures (QE does) | effects, guard, admit, proc |
| `forge.ts` | shell | `publish` and `forge.wait` handlers (GitLab REST) | Merge, approve | effects, admit, guard, git |
| `prepare.ts` | shell | `loadEnvironment` (only reader of an env's `ark/`), `run.prepare` handler | | pipeline, effects, git |
| `api.ts` | shell | `ArkApi` (7 methods) + unix-socket transport, peer check, emit token check | Write events | engine (types) |
| `cli.ts` | shell | argv → one `ArkApi` call; **composition root** for `ark serve` | Logic | everything it wires |

Call chain depth: CLI → `api.ts` → `engine.ts` → `decide.ts` (3 files). Executor side: `engine.ts` → `executor.ts` → one handler file (3 files).

### Boundaries that fail the build, not review

- `tsconfig.core.json` (above). Core imports nothing from shell.
- Importers (dependency-cruiser rule in CI, consistent with the call graph below):
  - `ledger.ts` ← `engine.ts` only (`Engine.start` opens it; `serve` never touches it).
  - handler modules (`attempt`, `verify`, `forge`, `prepare`) ← `cli.ts` only, which builds the `HandlerTable` literal. The engine receives `loadEnvironment` as an injected function, so `ark env add` and `run.prepare` share one loader without `engine.ts` importing `prepare.ts`.
  - `proc.ts` ← `attempt.ts`, `verify.ts`. `flock.ts` ← `proc.ts`, `cli.ts`. `git.ts` is the only module that spawns git (lint bans `spawn("git"` elsewhere).
  - `package.json#exports` exposes only `cli`/`api`.
- `RecordedArtifact` carries an unexported `unique symbol` brand. Two sanctioned casts: `admit.ts` (construction) and `ledger.ts#decodeEvent` (rehydration; trusts the ledger because only admit-produced values were committed). A lint rule bans assertions to it elsewhere; test fixtures call `admit` against a temp dir. No footprint file contains an artifact; bytes read back from `artifacts/` are re-hashed (`readArtifact`).
- `HandlerTable`, `CATALOG`, `OutcomeTable`, `FactsTable` are mapped/indexed over `EffectKind` / `ArtifactKind`. A new effect kind without a handler **and a recovery policy**, or a new artifact kind without a catalog row, does not compile (verified: omitting `recover` in `usage.ts` is TS2741).
- Inside `decide.ts`, a lint rule forbids referencing the `state` parameter outside `decide` itself; helpers read `acc.s` (the accumulator).

## 2. Who owns which state

| State | Single owner | Others |
|---|---|---|
| Ticket status, stage, pipeline, artifacts, repair counter, locks, head, gate, needs-human, attempts | `state.ts#fold` over the ticket stream. No setters | `view()`, `decide()` read |
| Tainted resources, slot leases, env registry | `world.ts#foldWorld` over the whole ledger (derived by the engine, never stored) | `decide()` reads `world`; dashboard via `view.leases`/needs-human queue |
| Event log | `ledger.commit`, called only from `engine.ts`, one global serial queue, process lock + epoch fence | clients get `TicketView` via `ArkApi`, never the file |
| Read model | `view(state)` over the engine's fold cache. **No projection table** | |
| What is physically running | the effect **footprint**: `.ctl/<key>/claim` lock, compose project `ark-<env>-s<slot>`, remote branch. Evidence for recovery probes; never state, never believed toward acceptance | |
| Artifact bytes | `admit.ts` (content-addressed `artifacts/<hash>.json`); ledger holds `{kind, hash, outcome, facts, pinned}`; reads re-hash | `ArkApi.artifact` renders |
| Ticket worktree | `attempt`/`prepare` handlers; one writer stage at a time | `publish` reads (push) |
| Locked checks | `locks.pinned` event (replaces), from the approved acceptance artifact's measured roots + per-file hashes | `guard.inspectLocks` compares |

## 3. Default Phase 1 pipeline

```yaml
version: 1
repair_cap: 3
entry: intake
stages:
  intake:     { kind: agent,   role: intake, out: ticket }
  analyze:    { kind: agent,   role: analyst, in: [ticket], out: analysis }
  plan:       { kind: agent,   role: planner, in: [ticket, analysis], out: plan }
  acceptance: { kind: agent,   role: acceptance-author, in: [plan], out: acceptance }
  plan_gate:  { kind: gate,    approves: [plan, acceptance], locks: true }
  build:      { kind: agent,   role: builder, in: [plan, acceptance], out: build }
  review:     { kind: agent,   fanout: { role: reviewer, out: review_findings }, role: review-lead, in: [build], out: review }
  verify:     { kind: command, run: ark.verify }
  qe:         { kind: agent,   role: qe, in: [verification], out: qe_report }
  publish:    { kind: command, run: ark.publish }
  ci:         { kind: wait,    for: gitlab.pipeline }
  landing:    { kind: wait,    for: gitlab.merged }
transitions:
  intake:     { done: analyze }
  analyze:    { done: plan }
  plan:       { done: acceptance }
  acceptance: { done: plan_gate }
  plan_gate:  { approved: build, changes_requested: plan, rejected: needs_human }
  build:      { done: review, material_change: plan }
  review:     { pass: verify, blockers: build }
  verify:     { pass: qe, fail: qe, flaky: needs_human, env_failure: needs_human }
  qe:         { pass: publish, defect: build, check_invalid: needs_human }
  publish:    { opened: ci }
  ci:         { pass: landing, blockers: build, infra_failure: needs_human }
  landing:    { merged: landed, closed: needs_human }
```

The `verify` row is deliberate: a red run (`fail`) goes to QE, which either confirms a source defect (`defect`, counts against the repair cap, needs a cited failed check and evidence files) or concludes the check itself is wrong (`check_invalid`, does not count, goes to a human because an approved check changes only through a human gate). `flaky` and `env_failure` never reach QE. `build.material_change` returns to `plan`, then `acceptance`, then the locking `plan_gate`, which re-locks. `classify`/`reclassify`/`qms_gate` are omitted (not in the Phase 1 brief); they re-enter as a command name or gate stage with no engine change.

## 4. Call graph: one full ticket run (the pilot ticket)

Notation: `inbound ⇒ [events] + {effects}`; each line is one engine iteration on the global queue = one SQLite transaction; effects dispatch only after commit. `decide` chains transitions internally through its accumulator, so one iteration can record an artifact, advance the head, enter the next stage and request its effects, each seeing the previous one's result.

```
ark serve                      flock ~/.ark/ark.lock → createExecutor(handlers) → Engine.start (open ledger, replay, recover) → api.serve (socket last)
ark env add <path>            api.envAdd → Engine.registerEnv → injected loadEnvironment → commit(world) [env.registered]
ark ticket new --id <ticket> --base env=<sha> --base app=<sha>~1 …   ticket.created{input.base}  ⇒ []   (fold creates state)
ark run <ticket>              run.requested                                    ⇒ {run.prepare}
  executor.run(prepare)       prepare.ts: resolve base vector (multi-repo), worktree at the pre-change revision, manifest.json (configCommit ≠ base.env)
effect.settled(prepared)                                                       ⇒ [run.started{pipeline}, stage.entered intake] + {attempt intake}
effect.settled(produced ticket)   attempt.ts: proc.launch claude -p … ; seal; admit
                                                                               ⇒ [artifact.recorded, stage.entered analyze] + {attempt analyst}
… analyze → plan → acceptance   (acceptance author is exempt from locks; commits check files: head.advanced; admit pins roots → LockSet with per-file blobs;
                                 admissible: rejection-style check has positive control, limitations declared)
effect.settled(produced acceptance)                                            ⇒ [artifact.recorded, stage.entered plan_gate, gate.opened{pins}]   (no effect)
ark gate decide … --approve   gate.decided{pins = view.gate.pins}              ⇒ [locks.pinned (replaces), stage.entered build] + {attempt builder, guard: allowed_paths + LockSets}
effect.settled(produced build)    seal: kill tree, git fingerprint, diff --no-renames ⊆ allowed, locks unchanged AND nothing added, head descends
                                                                               ⇒ [artifact.recorded, head.advanced, stage.entered review] + {attempt reviewer×N on the NEW head (private worktrees)}
effect.settled(produced findings) ×N, last one                                 ⇒ [artifact.recorded] + {attempt review-lead, inputs = the N findings as a list}
effect.settled(produced review: pass)  admit: every blocker id exists in the fan findings
                                                                               ⇒ [artifact.recorded, stage.entered verify] + {verify, lease env:pilot slot 0}
effect.settled(produced verification)   verify worker (under proc wrapper): reap predecessor → down -v ark-pilot-s0 → archive full vector →
                                        hash materialized locks → up → seed → health → checks → down → SHA256SUMS → admit(sumsDigest in facts)
                                                                               ⇒ [artifact.recorded, stage.entered qe] + {attempt qe, guard.evidence}   (pass or fail; flaky/env_failure ⇒ needs_human)
effect.settled(produced qe_report: pass)  admit already required a current verification pass for this head
                                                                               ⇒ [artifact.recorded, stage.entered publish] + {publish}
effect.settled(produced mr)       forge.ts: evidence digest vs ledger, push (no hooks), create/update the one MR   ⇒ [… stage.entered ci] + {forge.wait gitlab.pipeline}
effect.settled(produced ci: pass)                                              ⇒ [… stage.entered landing] + {forge.wait gitlab.merged}   (no deadline; heartbeats)
effect.settled(produced landing: merged)                                       ⇒ [artifact.recorded, ticket.landed]
```

**Repair loop (acceptance 3).** `qe_report: defect` ⇒ `[artifact.recorded, repair.counted{n:1}, stage.entered build via qe/defect] + {attempt builder, inputs += qe_report}`. The third counted failure yields `[artifact.recorded, repair.counted{n:3}, needs_human.raised{repair_cap}]` and **no** effect. `ark resume --to build --raise-cap-by 1` is `human.resolved` ⇒ `[needs_human.cleared, stage.entered build] + {attempt}`.

**Attempt rejection (acceptance 2).** Builder edits a locked check, adds a file under a locked root, or touches `.git/config`, hooks or a `.gitattributes` ⇒ seal returns `rejected` after `git reset --hard baseHead` ⇒ `[attempt.retried{n:2}] + {attempt builder n=2, feedback}`; after `maxRetries` ⇒ `needs_human.raised{attempt_failed}`. Rejections never count against the repair cap.

**Environment taint and slots.** Verify entry calls `acquire(acc.w, env:pilot, slots)`. Free ⇒ effect with `lease{env:pilot, slot}`. Tainted or full ⇒ `stage.waiting`, no effect. A freed lease or `resource.cleared` makes the engine submit `resource.released` to the oldest waiter; `decide` re-checks. A failed `down -v` (step 0 or step 5) or a verify tree that will not die returns an outcome with `taint{env:pilot}`; `decide` emits `resource.tainted` first, unconditionally, then escalates normally. `ark env unblock env:pilot` appends `resource.cleared` to the world stream and wakes the oldest waiter.

**Defect repro.** `ark verify --check <id>` ⇒ `verify.requested` ⇒ `{verify with repro:{check}, lease}` (refused immediately if no lease). The result lands as `repro.recorded` regardless of ticket status, visible in `view.repros`; no edge, no repair, no stage change.

**Prepare failure.** `run.prepare` failing ⇒ `needs_human{prepare_failed}` with `run === null`. `ark resume` (`to: null`) re-requests `run.prepare` with the next `n`.

## 5. Call graph: crash and restart

`ark serve` takes the exclusive process lock first; a second `serve` exits there, having touched nothing. Then `Engine.start` = `openLedger` (new epoch) → replay each stream → fold World → recovery: `status ∈ {preparing, running}` → `dispatch(req, "recovery")` for each `run.inflight` entry; `needs_human` → re-dispatch inflight repros, cancel the rest; `aborted`/`landed` → cancel; `stage.waitingOn` → wake. Nothing else. In `"recovery"` mode the executor applies the handler's **declared recovery policy** before `run`:

| Kind | `recover` | `done` means | `absent` means | `unknown` means |
|---|---|---|---|---|
| `run.prepare` | probe | `manifest.json` exists | no worktree, no manifest | worktree at a different sha |
| `attempt` | probe | `claim` present; `run` then asks `proc.inspect`: **alive** ⇒ attach, **exited** ⇒ re-seal, **dead** ⇒ reap, reset, report `interrupted` | no `claim` | – (never) |
| `verify` | `"rerun"` | – (run reaps the predecessor tree, then slot teardown) | – | – (a tree or teardown that cannot be cleaned ⇒ taint) |
| `publish` | probe | branch at spec head + one MR | no branch, no MR; or branch at an ancestor (republish) | foreign sha on our branch, or >1 MR |
| `forge.wait` | `"rerun"` | – | – | – |

`unknown` never reaches `run`: the executor reports `ambiguous` and `decide` raises `needs_human{ambiguous_effect}`. An attempt can also report `ambiguous` if the reaped tree is `stuck` (a descendant escaped the process group).

| Crash point | Durable record | Restart behavior |
|---|---|---|
| Before commit of an iteration | nothing | human retries; executor report is re-produced from the footprint |
| After commit, before dispatch | `effect.requested` ⇒ in `inflight` | recovery dispatches it |
| `prepare` mid-way | partial worktree, no manifest | probe `absent` ⇒ run again (`git worktree add` iff absent) |
| Between `claim` creation and the wrapper taking its lock | `claim`, lock free, no `exit` | `inspect` = dead; it writes `abandoned` first, so a late wrapper exits without launching. No second writer, no ambiguous window |
| Builder running, service killed | wrapper holds the `claim` lock | `inspect` = alive ⇒ **attach**; observation ids are deterministic so re-ingest is idempotent. Acceptance 4 |
| Builder finished during downtime | `exit`, maybe `out/output.json` | `inspect` = exited ⇒ **re-seal** from output + git objects. No stored outcome is trusted |
| Builder died during downtime | `claim`, lock free, no `exit` | dead ⇒ reap, reset worktree, `interrupted` ⇒ retry n+1 from `baseHead` (bounded by `maxRetries`) |
| Seal finished (rejected), commit lost | `ctl/rejected.json`, worktree reset | re-seal returns the rejection (a marker believed only toward rejection) |
| Verify mid-run | wrapper tree, compose project `ark-<env>-s<slot>`, `evidence/<n>.partial/` | `rerun`: reap the tree, `down -v` the slot project (any predecessor's residue), wipe partial, fresh run. Cannot clean ⇒ taint |
| Verify finished, commit lost | `evidence/<n>/` + `SHA256SUMS` that verifies | run adopts it without rerunning |
| Publish mid-way | remote branch ± MR | probe; converge to spec. Exactly one MR |
| `forge.wait` | none | poll again (no deadline to reset) |
| Two services started | | second fails the process lock before opening anything; if it somehow got further, its first `commit` fails the epoch fence |
| `needs_human` with a flow effect still running | `inflight` entry | recovery cancels it; late report is audit-only. A repro in flight is re-dispatched, not cancelled |
| Tainted env, service restarted | `resource.tainted` in the ledger | World refolds the taint; verify waits until `resource.cleared` |

Every row ends in: re-derive (idempotent), attach, or `needs_human` with a typed reason. There is no fourth "guess" outcome.

## 6. Test seams (real boundaries, no mocks of ark internals)

The harness stand-in is a real shell script run as a real subprocess through a `scripted` entry in a test-only harness table passed to `makeAttemptHandler` (it is not in the production `HARNESSES`); GitLab is a real HTTP server implementing the REST subset ark calls; git and Compose are real.

| Module | Seam |
|---|---|
| `contracts`, `pipeline`, `state`, `world`, `decide` | pure: literal values and `replay` of fixture event lists. No database, clock, or process. Includes chained-transition cases (build produced ⇒ reviewers requested on the advanced head), taint-before-status, repro-while-needs_human |
| `ledger` | real SQLite file; fence, trigger against UPDATE/DELETE, observation dedupe; crash hook leaves exactly the durable prefix |
| `guard`, `admit`, `attempt` seal | real temp git repos: edited lock, file added under a root, rename into scope from outside scope, history rewrite, `.git/config` hook, `.gitattributes` export-ignore, forged `outcome`/`exit` files, schema reject, QE-vs-verification mismatch, reviewer-blocker mismatch, evidence rewritten by QE |
| `proc`, `attempt` lifecycle | scripted harness script; real `kill -9` of service and of the harness group; recorded S1 JSONL through `parseLine`/`usage`; wrapper spawned-but-unlocked race |
| `verify` | real Compose, S3 recipe; S4 check fails at the pre-change revision, passes at the fixed revision; orphaned `compose up` killed by the successor |
| `forge` | local GitLab REST server; rerun `publish` from every footprint state, assert one MR |

### THE Phase 1 recovery acceptance test: crash at every commit

One test, **run on demand and before every phase sign-off**, against the **real pilot-service compose slice** (17–70 s per verify, so a full matrix takes hours; it is not wired into per-change CI). A cheap subset that skips verify (scripted harness, no Compose) runs in CI per change to `decide`, `engine`, `ledger`, `executor`.

1. **Golden run.** Real service subprocess, scripted harness (deterministic outputs for every role, including one injected QE defect to exercise a repair round), real git fixture environment, GitLab REST server, real Compose. Drive the plan gate with `ark gate decide`. Record the normalized outcome and the number of ledger commits `M`.
2. **Crash matrix.** For every commit `N` in `1..M` and `when ∈ {before, after}`: fresh environment; run the service with the crash point set so the ledger SIGKILLs its own process (before: inside the transaction, nothing of the batch durable; after: durable, but no dispatch, no cache update, no reply). Restart the service with no crash set; re-issue the gate decision if it was lost; wait for a terminal state.
3. **Handler crash labels.** Handlers declare labelled crash points (`attempt.after_claim`, `attempt.after_launch`, `verify.after_up`, `verify.during_down`, `publish.after_push`, `publish.after_mr`). The matrix repeats over every registered label. Expected normalized outcome differs only where the design says so: `during_down` must yield a taint, a blocked next verify, and the golden terminal state after `ark env unblock`.
4. **Normalized assertions.** Recovered runs legitimately differ in `attempt.retried`, `interrupted` events, seqs, timestamps, and in **commit hashes** (retried attempts make new seal commits) and so in artifact hashes. So the comparison is of **outcomes and facts, not hashes**: same terminal state as golden; same per-kind artifact `outcome` and `facts`; same repair count; **exactly one MR** on the forge server, at the final head; no process groups holding an `ark` claim lock; no `ark-*` compose projects left; every effect key settled exactly once; `replay` of the final ledger equals the cached state; the epoch never regressed. (The scripted harness may pin `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` if a hash comparison is ever wanted.)
5. The same matrix, with the harness process killed alone (`kill -9 <pgid>`) while the service is down, covers the `interrupted` path; and with `abandoned` raced against a late wrapper, the dead-before-lock path.

## 7. On-disk layout

```
<env>/.ark/runs/<ticket>/<run>/
  manifest.json  ticket.json  artifacts/<hash>.json  (+ rendered *.md)
  out/<key-dir>/output.json                                 the ONLY path an agent is told
  .ctl/<key-dir>/{claim,abandoned,exit,transcript.jsonl,rejected.json,gitfp,emit-token[,wt/]}   not told to the agent; nothing in it is believed toward acceptance
  evidence/<n>/{verification.json,environment.json,checks/,logs/,SHA256SUMS}    evidence/repro-<n>/ for non-flow runs
<env>/.ark/worktrees/<ticket>/<run>/<repo>/
~/.ark/ledger.sqlite   ~/.ark/ark.lock   ~/.ark/ark.sock
```

## 8. Phase 1 acceptance → mechanism

| Criterion | Mechanism |
|---|---|
| 1 Pilot ticket to MR with green bundle | default pipeline; `ticket.created{base}` expresses the multi-repo replay; `verify` runs the S3/S4 recipe over the full vector (`base.env` ≠ `configCommit`); the check has a positive control and carries its auth limitation into `environment.json` |
| 2 locked-check edit blocked | `guard.inspectLocks` in the seal (changed, missing, or added under a root) plus git-control-surface detection; rejected + reset; retry with feedback. Scope of the lock stated in `contracts.ts` |
| 3 wrong build → defect → cap → needs-human | `verify: fail` → QE → `qe_report.defect` (admitted only with failing check + evidence) is a `countsRepair` outcome; cap escalates instead of entering build |
| 4 kill mid-build, restart, no second writer | process lock; detached lock-guarded tree ⇒ attach on `alive`; epoch fence |
| 5 dashboard fields | `view.attempts` (role, harness, model, timing, usage or null), `view.repairs`, `view.disclosures`, `view.leases`, `view.repros` |
