# Interrogate verdict: Phase 1 design sketch

Date: 2026-10-08. Skill: pstack `interrogate` (pstack-claude 0.9.74), lead judgment by the session agent. Raw reviews kept outside the repo in `/tmp/ark-interrogate/`.

## Intent

> Ark is a local, harness-agnostic software factory. This is the Phase 1 walking-skeleton design (planning only; bodies are `not implemented`). It must replay the pilot ticket end to end as a background service with agent stages, a human plan gate that locks acceptance checks, build, a local review panel, verification in real Docker Compose with an evidence bundle, QE, GitLab MR, CI and merge waits, a shared repair cap of 3, and crash recovery with no second writer. Agents run unsandboxed, so tampering is detected after each attempt. Shape: event-sourced ledger, pure `decide`, idempotent effect handlers with a required recovery policy per effect kind.

## Reviewers

| Reviewer | Harness | Model | Findings |
|---|---|---|---|
| A | Claude Code | opus | 0, not run: Claude session limit reached |
| B | Claude Code | fable | 0, not run: needs usage credits |
| C | Claude Code | sonnet | 6 |
| A′ | OMP | anthropic/claude-opus-5-5 | 24 |

Two models on the approved Anthropic route, run through two harnesses. GPT models were available in OMP but are not an approved route for the pilot's material (decision 13 / S2), so they were not used.

## Act on

Each was traced to the sketch before acceptance.

1. **`decide` reads stale state inside one call** (opus #1). Helpers take the pre-call `state`; after `onAttemptProduced` emits `head.advanced`, `enter(review)` still reads the old `state.run.head` (`decide.ts:220`). Fix: fold-as-you-emit accumulator inside `decide`; the engine mints event ids before `decide` (opus #10); `run.prepare × prepared` reads the pipeline from the folded state (opus #11).
2. **Second writer at startup and across tickets** (opus #2, #9; sonnet #1, consensus). `serve` opens the ledger and runs recovery before the socket bind that acts as singleton lock (`cli.ts:8`), so a second `ark serve` fences out the live one and tears down its verify slot. Lease uniqueness across tickets depends on no `await` between `decide` and the world update. Fix: exclusive `flock` on `~/.ark/ark.lock` as the first action of `serve`; one global serial queue for all `apply` calls (Phase 1 runs one ticket at a time anyway).
3. **The tamper story has a hole: control files and evidence are agent-writable** (opus #3, #15; sonnet #4). `output.json` sits next to `outcome.json`/`exit`/`claim`, and recovery adopts `outcome.json` without re-sealing. QE can rewrite `evidence/` and `SHA256SUMS` after verify. Agent-editable `.git/config` hooks run during seal and publish. Verify checks git objects while executing `git archive` output (`.gitattributes export-ignore` can diverge them). Fix: control files in a directory the agent is not told about; re-seal on adoption; re-hash artifacts against the ledger on read; record the `SHA256SUMS` digest in the ledger; run seal and publish git with hooks, fsmonitor and filters disabled and fail on changes to `.git/config`, hooks, or `.gitattributes`; verify hashes the materialized files.
4. **The review panel collapses to one reviewer** (sonnet #2, opus #6, consensus). `RunState.artifacts` and `AdmitInputs.artifacts` hold at most one artifact per kind (`state.ts:75`, `contracts.ts:150`), and the join's inputs don't include the fan slots. Fix: join inputs are the slot outputs (`StageProgress.slots[*].done`), as a list.
5. **Locks block the Acceptance Author and the spec's re-plan path** (opus #5, sonnet #6, consensus). `guardFor` applies `run.locks` to every role, and the fold says locks never shrink, so a return to `acceptance` can never edit a check. `build: material_change` goes to `needs_human` instead of the plan gate, and this is undeclared. Fix: exempt the role whose output a locking gate approves; each `locks.pinned` replaces the previous locks; route `material_change` to `plan`.
6. **No way to give the ticket a base revision vector** (opus #7). `TicketInput` and `PrepareSpec` carry no base, so the pilot-ticket replay (acceptance 1) cannot be expressed; env config commit and env materialize sha are conflated. Fix: `base: { env?, repos }` on `ticket.created`; separate `configCommit` from `vector.env`.
7. **Process liveness for attempts and verify** (opus #22, #16, #8; sonnet #3, consensus). Replace claim + pid + start-time with a detached wrapper that holds an `flock` on `claim` for the process tree's life: lock busy means alive (attach), lock free means adopt or report interrupted. This removes the `unknown` attempt window. The seal kills the process group first (OMP backgrounds jobs, S1). Verify runs its subprocesses under the same wrapper so recovery can kill orphans before `down -v`. Remove per-attempt worktrees after the outcome is written.

## Consider

- Human commands come over an unauthenticated socket that agents also use for `ark emit` (opus #14). Peer-process check (refuse human commands from inside a live attempt's process tree) plus a per-attempt emit token. Real, given decision 44; cost is small.
- QE has no real choice under `admissible`, and `flaky`/`env_failure` are dead vocabulary (sonnet #5, opus #17, consensus). Drop them; add `check_invalid → needs_human` (not counted against the cap).
- `onSettled` precedence: taint and repro results can be dropped by the status gate; restart cancels running repros (opus #4). Fold into the `decide` rework in Act on 1.
- `forge.wait` deadlines reset on restart and merge waits take days (opus #18). Waits get no deadline, only heartbeats.
- `prepare_failed` is a dead end (opus #19). `resume` with `run === null` re-requests prepare.
- Crash-matrix assertions compare artifact hashes that legitimately differ after recovery; MODULES and RATIONALE disagree on when it runs (opus #20). Compare outcomes and facts; fix MODULES.
- `parsePipeline` can't check write-scope rules without roles; dependency rules contradicted by the call graph (opus #12, #13).
- `tickets` projection table has no reader (opus #21). Delete it.
- Gate pin example would be refused; `stale_pins` can't fire (opus #23).

## Noted

Nits in opus #24: inverse maps `holders`/`leases`, two "unknown usage" forms, stream-name comment mismatch, duplicate `COMMANDS` export, test harness in the production registry, stale `waiting.why`, observations vs `expectLastSeq`, `ARK_CRASH` runtime check, `route` identity wrapper.

## Dismissed

None of substance. Both reviewers stayed on concrete execution paths; the main filter applied was merging duplicates.

## Agreement map

Consensus (both models): cross-ticket lease race, fan-out cardinality, the ambiguous pid window, the QE dead vocabulary, `material_change` routing. Opus alone, all verified in the sketch: stale state in `decide`, startup second writer, agent-writable footprint, missing base vector, verify orphans. Opus read the call graph end to end (24 findings over 22 files); Sonnet reviewed narrower. No reviewer argued for a different overall shape: the reducer base holds, and every Act on item is a local fix inside it.
