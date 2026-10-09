/**
 * decide.ts — ALL transition logic. @layer core. One exported function (plus one derived accessor).
 *
 *   decide(state, inbound, world) -> { events, cancel, refusal? }
 *
 * Pure, total, deterministic: same (state, inbound, world) => same Decision, including effect keys and lease
 * slots (derived from state and world; see effectKey, acquire), event ids (`${inbound.id}.${i}`) and timestamps
 * (copied from inbound.ts). No I/O, no clock, no randomness, no artifact-file reads: it reads only `state`
 * (= fold of the ticket stream, which includes the Pipeline), `world` (= foldWorld of the ledger), and facts
 * carried inside events.
 *
 * ---------------------------------------------------------------- the accumulator (READ THIS FIRST)
 * A single inbound can trigger a CHAIN of transitions: an attempt produced a build => record it, advance the head,
 * enter `review`, request the reviewer attempts, each of which must be built on the NEW head. Helpers therefore
 * never read the `state` argument. decide() creates
 *
 *     acc = { s: state, w: world, events: [], cancel: [] }
 *
 * and every private helper takes `acc` and calls `emit(acc, event)` — which appends to `acc.events` AND folds the
 * event into `acc.s` (state.ts#fold) and `acc.w` (world.ts#foldWorld) immediately. A helper that runs after another
 * has emitted therefore sees the effects of the earlier events (new head, new stage, a lease already taken by the
 * previous request in this same call). An effect is stated ONCE, as an `effect.requested` event emitted through
 * `request(acc, req)`; there is no separate effects list to keep in step with the events. The ONLY way to read
 * "current state" inside decide is `acc.s`; reading the `state` parameter after the first emit is a bug
 * (a lint rule forbids referencing the parameter outside `decide` itself).
 *
 * Callers never "advance" a ticket. They hand decide() a fact and commit its answer:
 *   human commands   (ticket.created, run.requested, gate.decided, human.resolved, verify.requested)
 *   executor reports (effect.settled)
 *   engine wake-ups  (resource.released)
 * Every state change in the system is one of these inputs.
 *
 * Contract with the engine (engine.ts):
 *   events  are appended AFTER the inbound itself, in order, in one transaction (ledger.commit).
 *   effects: the engine dispatches every `effect.requested` in `events`, only after that commit succeeded
 *           (transactional outbox: the log IS the outbox; a crash after commit re-dispatches via recovery).
 *   cancel  keys whose effects must stop.
 *   refusal means NOTHING is recorded and nothing happens; the API returns it to the caller (wrong state, resource
 *           busy, unknown stage...). Executor reports and wake-ups are never refused: late/duplicate ones yield an
 *           empty Decision.
 *
 * Idempotence: a replayed or duplicated inbound whose effect is no longer in `inflight` does nothing.
 *
 * `world` is read in exactly two places: lease acquisition (enter, onVerifyRequested) and wake-ups.
 */
import type { EffectKey, SlotId, StageId } from "./ids";
import type { AnyRecorded } from "./contracts";
import type { Decided, Draft, Inbound } from "./events";
import type { EffectRequest, Guard, Outcome, Resource } from "./effects";
import type { RoleBinding, WriteScope } from "./pipeline";
import type { TicketState } from "./state";
import type { World } from "./world";

type In<T extends Inbound["type"]> = Draft<Extract<Inbound, { type: T }>>;

export type Refusal = {
  readonly code:
    | "pins_mismatch" | "no_open_gate" | "wrong_state" | "unknown_stage" | "bad_choice"
    | "env_unknown" | "unknown_check" | "resource_unavailable";
  readonly message: string;
};

export interface Decision {
  readonly events: readonly Draft<Decided>[];
  readonly cancel: readonly EffectKey[];
  readonly refusal?: Refusal;
}

export function decide(state: TicketState, inbound: Draft<Inbound>, world: World): Decision {
  throw new Error("not implemented");
}

/** The effects a Decision requests: its `effect.requested` events, in order. Derived, never stored separately. */
export function effectsOf(d: Decision): readonly EffectRequest[] {
  throw new Error("not implemented");
}

// =====================================================================================
// Private structure. Not exported: the public surface is `decide` alone. Listed here so
// the transition logic is traceable from signatures. All are pure over `acc`.
// =====================================================================================

interface Acc {
  s: TicketState;
  w: World;
  readonly events: Draft<Decided>[];
  readonly cancel: EffectKey[];
}

/** Append `event` (id = `${inbound.id}.${events.length}`) to acc.events and fold it into acc.s and acc.w. */
function emit(acc: Acc, event: Omit<Draft<Decided>, "id">): void {
  throw new Error("not implemented");
}

/** emit(effect.requested{req}); acc.w then shows the lease as held, so a second request in this call cannot take the same slot. */
function request(acc: Acc, req: EffectRequest): void {
  throw new Error("not implemented");
}

/*
 * decide() switches directly over inbound.type (no router function):
 *   ticket.created    -> []                         (fold creates the state)
 *   run.requested     -> status must be "created"; request run.prepare (n = prepares+1); fold sets "preparing"
 *   gate.decided      -> onGateDecided
 *   human.resolved    -> onHumanResolved
 *   verify.requested  -> onVerifyRequested
 *   effect.settled    -> onSettled
 *   resource.released -> onResourceReleased
 */

/**
 * effect.settled. FIXED PRECEDENCE, each step independent of the next:
 *   1. req = acc.s.run.inflight[key] (or the prepare effect of a run-less ticket); absent => empty Decision
 *   2. outcome.taint => emit resource.tainted{resource, key, reason} UNCONDITIONALLY, whatever the ticket's status:
 *      the block must be durable even if the ticket was aborted or has since escalated
 *   3. req.spec is a repro verify (spec.repro != null) => produced: repro.recorded; anything else: nothing.
 *      INDEPENDENT of ticket status (a repro after the repair cap is the acceptance-3 case) and never a transition
 *   4. status != "running" (flow effect arriving at a needs_human/aborted/landed ticket) => emit nothing more;
 *      fold clears inflight; the late result is audit-only
 *   5. otherwise by req.spec.kind x outcome.tag:
 *
 *  run.prepare x prepared        -> run.started{manifest, pipeline: outcome.pipeline, head}; then enter(pl.entry)
 *                                   where pl = acc.s.run.pipeline (read from the state just folded, not from the outcome)
 *  run.prepare x anything else   -> needs_human.raised(prepare_failed)  (resume re-requests prepare)
 *  attempt     x produced        -> onAttemptProduced
 *  attempt     x rejected|crashed|interrupted -> retryOrEscalate
 *  verify (flow) x produced      -> complete(stage, artifact)        pass|fail -> qe, flaky|env_failure -> needs_human by pipeline
 *  publish|forge.wait x produced -> complete(stage, artifact)
 *  verify|publish|forge.wait x crashed|interrupted -> needs_human(attempt_failed); recovery re-runs these, so
 *                                  reaching here means the handler gave up
 *  any         x timed_out       -> needs_human.raised(timed_out). NEVER auto-retried (timeout is a failure class).
 *  any         x ambiguous       -> needs_human.raised(ambiguous_effect). NEVER auto-retried.
 *  any         x cancelled       -> [] (fold clears inflight)
 */
function onSettled(acc: Acc, inbound: In<"effect.settled">): void {
  throw new Error("not implemented");
}

/**
 * attempt produced an artifact:
 *  - artifact.recorded (slot done); head.advanced if artifact.head moved
 *  - fanout: when every fan slot is done -> request the join attempt (phase "join"); the join's `inputs` are the
 *    fan slots' artifacts AS A LIST (attemptRequestFor)
 *  - otherwise complete(stage, artifact)
 * (Cross-artifact validity — QE vs verification, review blockers vs findings — was already established by admit().)
 */
function onAttemptProduced(acc: Acc, req: EffectRequest, artifact: AnyRecorded): void {
  throw new Error("not implemented");
}

/**
 * Rejected/crashed/interrupted attempt. If slot.retries < binding.maxRetries:
 *   attempt.retried + a NEW AttemptSpec (n+1, same baseHead, feedback = rejection text).
 * Else needs_human(attempt_failed). Retries never touch the repair cap: an attempt that
 * the seal refused or that died is not a verified failed round.
 */
function retryOrEscalate(acc: Acc, req: EffectRequest, outcome: Outcome): void {
  throw new Error("not implemented");
}

/**
 * A stage produced artifact A (outcome o = A.outcome). Then advance(stage, o).
 * Before ENTERING `ark.publish` (in enter(), not here): current(verification) and current(qe_report) must both exist,
 * be `pass`, and carry head === acc.s.run.head; violation -> needs_human(inconsistent), nothing requested. That is a
 * head-currency check (a new head may have appeared since), not a cross-artifact one.
 */
function complete(acc: Acc, stage: StageId, artifact: AnyRecorded): void {
  throw new Error("not implemented");
}

/**
 * Take edge `acc.s.run.pipeline.transitions[stage][outcome]`:
 *  - if countsRepair(kind, outcome): repair.counted{n+1, reason, trigger}; if n+1 >= cap -> needs_human(repair_cap)
 *    INSTEAD of entering the target ("reaching the cap escalates before another automatic Build round")
 *  - target "needs_human"  -> needs_human.raised(pipeline_escalation{stage,outcome})
 *  - target "landed"       -> ticket.landed
 *  - else enter(target) with via = {stage, outcome}
 * Staleness: entering a stage never deletes older artifacts; `current()` simply stops
 * returning ones whose head differs. "A new source head invalidates review, verification,
 * and CI" is therefore not a mutation, it is a comparison.
 */
function advance(acc: Acc, from: StageId, outcome: string): void {
  throw new Error("not implemented");
}

/**
 * Enter stage S (visit = visits[S]+1): stage.entered, then by kind:
 *   agent   -> one effect per fan slot (or "main"): attemptRequestFor()
 *   command -> COMMANDS[run] -> verifyRequestFor() / publishRequestFor()
 *   wait    -> waitRequestFor()   (timeoutMs null)
 *   gate    -> gate.opened{pins: current hashes of stage.approves}; NO effect (a human is the executor)
 * Verify entry takes a lease: acquire(acc.w, `env:<id>`, recipe.slots).
 *   ok          -> effect with lease {resource, slot}
 *   not ok      -> stage.waiting{resource}; NO effect. Wake-up arrives as resource.released.
 * An agent stage whose `in` kind is missing or stale -> needs_human(inconsistent): a pipeline
 * that reaches a stage without its inputs was mis-edited; parsePipeline should have caught it.
 */
function enter(acc: Acc, target: StageId, via: { from: StageId; outcome: string } | null): void {
  throw new Error("not implemented");
}

/**
 * resource.released for a ticket whose stage.waitingOn matches: retry the lease. Available -> effect requested
 * (stage.entered is NOT repeated). Still blocked -> nothing and the stage keeps waiting.
 * Anything else (not waiting, different resource) -> nothing.
 */
function onResourceReleased(acc: Acc, inbound: In<"resource.released">): void {
  throw new Error("not implemented");
}

/**
 * verify.requested (defect repro). Refuse unless run exists, status is running|needs_human, `check` is a check
 * id of current(acceptance).facts.checks. Takes a lease like a flow verify but NEVER waits: unavailable ->
 * refusal resource_unavailable (the engineer is at the keyboard and can retry). Effect: VerifySpec with
 * `repro: {check}`, key stage "repro", visit = number of repros so far + 1, vector = revisionVector(run).
 */
function onVerifyRequested(acc: Acc, inbound: In<"verify.requested">): Refusal | null {
  throw new Error("not implemented");
}

/**
 * gate.decided. Refuse unless an open gate has this id (`GateId` = stage#visit already identifies the content: no
 * artifact can change while a gate is open). `decision.pins` must equal the open gate's pins; the echo is the
 * DECISION RECORD of spec §10 (which hashes the human approved), so a client that echoes anything else (it should
 * echo `view.gate.pins` verbatim) is refused with pins_mismatch. It is not a second safety mechanism. Then:
 *   approve          -> if stage.locks: locks.pinned{ LockSet[] from current(acceptance).pinned } REPLACING locks;
 *                       advance(stage, "approved")
 *   request_changes  -> advance(stage, "changes_requested")
 *   reject           -> advance(stage, "rejected")
 * A plan amendment (build material_change -> plan -> acceptance -> plan_gate) re-locks through this same gate:
 * the acceptance author is exempt from locks (guardFor) and the new approval replaces them (decision 9).
 */
function onGateDecided(acc: Acc, inbound: In<"gate.decided">): Refusal | null {
  throw new Error("not implemented");
}

/**
 * human.resolved on a needs_human ticket.
 *   resume{to, raiseCapBy}:
 *     run === null (prepare failed): `to` must be null; request run.prepare again (n = prepares+1); needs_human.cleared.
 *     otherwise refuse if `to` is not a stage; if the reason was repair_cap, require raiseCapBy >= 1 (otherwise the
 *     very next failure re-escalates); needs_human.cleared + enter(to). Fold resets nothing but the flag and cap:
 *     heads, artifacts, counter history stay.
 *   abort: needs_human.cleared + ticket.aborted + cancel every inflight key (repros included).
 */
function onHumanResolved(acc: Acc, inbound: In<"human.resolved">): Refusal | null {
  throw new Error("not implemented");
}

// ---------------------------------------------------------------- request builders (pure over acc.s)

/**
 * AttemptSpec for (role, slot, n): resolves binding from manifest.roles, `inputs` = current recorded
 * artifacts named by stage.in plus repairs.trigger (in full), `fanInputs` = for the JOIN phase,
 * `Object.values(stage.slots).map(s => s.done)` of the fan phase in slot order (the lead sees every reviewer; a
 * per-kind lookup would see one), `guard` from guardFor(), baseHead = acc.s.run.head (the head AS ADVANCED by
 * earlier events of this call), feedback from SlotProgress.
 */
function attemptRequestFor(acc: Acc, stage: StageId, slot: SlotId, n: number): EffectRequest {
  throw new Error("not implemented");
}

/**
 * The Guard the seal enforces. The ONE place WriteScope becomes globs and locks become exemptions:
 *   allowedPaths: none -> []; plan.allowedPaths -> current(plan).facts.allowedPaths; globs -> scope.globs
 *   locked:       acc.s.run.locks (roots + per-file hashes), EXCEPT [] for a role that produces a kind in `approves`
 *                 of a `locks: true` gate (it authors the locked material; the gate re-locks it)
 *   evidence:     for the qe role, the verification facts {evidenceDir, sumsDigest}; null otherwise
 */
function guardFor(acc: Acc, role: RoleBinding, scope: WriteScope): Guard {
  throw new Error("not implemented");
}

/**
 * VerifySpec: vector = revisionVector(run) (env sha + EVERY repo sha), checks = current(acceptance).facts.checks,
 * locks = run.locks, recipe from the manifest, project = projectName(env, slot) (world.ts), n = verifications so far + 1.
 */
function verifyRequestFor(acc: Acc, stage: StageId, lease: { resource: Resource; slot: number }): EffectRequest {
  throw new Error("not implemented");
}
function publishRequestFor(acc: Acc, stage: StageId): EffectRequest {
  throw new Error("not implemented");
}
function waitRequestFor(acc: Acc, stage: StageId): EffectRequest {
  throw new Error("not implemented");
}
