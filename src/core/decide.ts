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
 * (a lint rule forbids referencing the parameter outside `decide` itself and the two functions it hands the
 * PRE-inbound state to: `refusalFor`, which must judge the inbound against what was true before it, and `reqOf`,
 * which finds the in-flight request that the inbound's own fold is about to clear).
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
 * `world` is read in exactly three places: lease acquisition (enter, onVerifyRequested), wake-ups, and the
 * refusal check for a repro (refusalFor).
 */
import { effectKey, effectKeyParts } from "./ids.ts";
import type { EffectKey, EventId, GateId, IsoTime, SlotId, StageId, StreamId } from "./ids.ts";
import { countsRepair, REPAIR_REASON } from "./contracts.ts";
import type { AnyRecorded, ArtifactKind } from "./contracts.ts";
import { canonicalJson } from "./hash.ts";
import type { Decided, Draft, Inbound, NeedsHumanReason } from "./events.ts";
import type { EffectRequest, Guard, Lease, Outcome, Resource } from "./effects.ts";
import { COMMANDS, GATE_OUTCOME, producesOf } from "./pipeline.ts";
import type { AgentStage, RoleBinding } from "./pipeline.ts";
import { current, fold, revisionVector } from "./state.ts";
import type { RunState, TicketState } from "./state.ts";
import { acquire, foldWorld, projectName } from "./world.ts";
import type { World } from "./world.ts";

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

/*
 * Deadlines are measured from the handler's own start marker (effects.ts). Attempts use the role binding's
 * deadline and verify the recipe's; these three have no per-environment knob in the manifest.
 * ponytail: constants; move into RunManifest when an environment needs to tune them.
 */
const PREPARE_TIMEOUT_MS = 10 * 60_000;
const PUBLISH_TIMEOUT_MS = 5 * 60_000;
const WAIT_POLL_MS = 30_000;

const MAIN = "main" as SlotId;

export function decide(state: TicketState, inbound: Draft<Inbound>, world: World): Decision {
  const refusal = refusalFor(state, inbound, world);
  if (refusal) return { events: [], cancel: [], refusal };

  // The inbound is already a fact: fold it first, so every helper sees it (cleared inflight, closed gate, ...).
  const acc: Acc = {
    s: fold(state, inbound), w: foldWorld(world, inbound), events: [], cancel: [],
    id: inbound.id, ts: inbound.ts, stream: inbound.stream,
  };
  switch (inbound.type) {
    case "ticket.created":
      break;
    case "run.requested":
      requestPrepare(acc);
      break;
    case "gate.decided":
      onGateDecided(acc, inbound);
      break;
    case "human.resolved":
      onHumanResolved(acc, inbound);
      break;
    case "verify.requested":
      onVerifyRequested(acc, inbound);
      break;
    case "effect.settled":
      onSettled(acc, inbound, reqOf(state, inbound.data.key));
      break;
    case "resource.released":
      onResourceReleased(acc, inbound);
      break;
    default:
      return assertNever(inbound);
  }
  return { events: acc.events, cancel: acc.cancel };
}

/** The effects a Decision requests: its `effect.requested` events, in order. Derived, never stored separately. */
export function effectsOf(d: Decision): readonly EffectRequest[] {
  return d.events.flatMap((e) => (e.type === "effect.requested" ? [e.data.request] : []));
}

function assertNever(x: never): never {
  throw new Error(`unhandled inbound ${JSON.stringify(x)}`);
}

// =====================================================================================
// Private structure. Not exported: the public surface is `decide` alone. All are pure over `acc`.
// =====================================================================================

interface Acc {
  s: TicketState;
  w: World;
  readonly events: Draft<Decided>[];
  readonly cancel: EffectKey[];
  /** The inbound's identity, from which decided events derive theirs. */
  readonly id: EventId;
  readonly ts: IsoTime;
  readonly stream: StreamId;
}

/** Append an event (id = `${inbound.id}.${events.length}`) to acc.events and fold it into acc.s and acc.w. */
function emit<T extends Decided["type"]>(acc: Acc, type: T, data: Extract<Decided, { type: T }>["data"]): void {
  const event = {
    id: `${acc.id}.${acc.events.length}` as EventId, v: 1, ts: acc.ts, stream: acc.stream,
    type, data, authority: "authoritative", source: "orchestrator",
  } as unknown as Draft<Decided>;
  acc.events.push(event);
  acc.s = fold(acc.s, event);
  acc.w = foldWorld(acc.w, event);
}

/** emit(effect.requested{req}); acc.w then shows the lease as held, so a second request in this call cannot take the same slot. */
function request(acc: Acc, req: EffectRequest): void {
  emit(acc, "effect.requested", { request: req });
}

/** Escalate. Flow effects still running are cancelled (their late reports would be audit-only); repros keep running. */
function raise(acc: Acc, reason: NeedsHumanReason): void {
  emit(acc, "needs_human.raised", { reason });
  for (const [key, r] of Object.entries(acc.s.run?.inflight ?? {})) {
    if (!(r.spec.kind === "verify" && r.spec.repro)) acc.cancel.push(key as EffectKey);
  }
}

function runOf(acc: Acc): RunState {
  if (!acc.s.run) throw new Error("decide: no run");
  return acc.s.run;
}

const currentAny = (run: RunState, kind: ArtifactKind): AnyRecorded | null => current(run, kind) as AnyRecorded | null;
const envResource = (acc: Acc): Resource => `env:${acc.s.env}`;

/** The in-flight request for `key`: a run effect, or the run-less prepare. Read from the PRE-inbound state. */
function reqOf(s: TicketState, key: EffectKey): EffectRequest | undefined {
  const r: EffectRequest | undefined = s.run?.inflight[key];
  return r ?? (s.prepare?.inflight?.key === key ? s.prepare.inflight : undefined);
}

const describe = (o: Outcome): string =>
  o.tag === "rejected" ? `${o.reason.class}: ${o.reason.details.join("; ")}`
  : o.tag === "crashed" ? `crashed: ${o.detail}`
  : o.tag === "ambiguous" ? o.why
  : o.tag;

// ---------------------------------------------------------------- refusals (checked against the PRE-inbound state, before anything is recorded)

function refusalFor(state: TicketState, inbound: Draft<Inbound>, world: World): Refusal | null {
  const no = (code: Refusal["code"], message: string): Refusal => ({ code, message });
  switch (inbound.type) {
    case "ticket.created":
      if (state.status !== "unborn") return no("wrong_state", `ticket already exists (${state.status})`);
      return Object.hasOwn(world.envs, inbound.data.env) ? null : no("env_unknown", `environment ${inbound.data.env} is not registered`);
    case "run.requested":
      return state.status === "created" ? null : no("wrong_state", `cannot run a ticket that is ${state.status}`);
    case "gate.decided": {
      const gate = state.run?.gate;
      if (!gate || gate.gate !== inbound.data.gate) return no("no_open_gate", `no open gate ${inbound.data.gate}`);
      return canonicalJson(inbound.data.pins) === canonicalJson(gate.pins)
        ? null : no("pins_mismatch", "pins differ from the open gate's pins (echo view.gate.pins verbatim)");
    }
    case "human.resolved": {
      if (state.status !== "needs_human") return no("wrong_state", `ticket is ${state.status}, not needs_human`);
      const c = inbound.data.choice;
      if (c.kind === "abort") return null;
      if (!state.run) return c.to === null ? null : no("bad_choice", "prepare failed: resume with to: null");
      if (c.to === null) return no("bad_choice", "resume needs a stage to re-enter");
      if (!Object.hasOwn(state.run.pipeline.stages, c.to)) return no("unknown_stage", `${c.to} is not a stage of this run's pipeline`);
      if (!Number.isInteger(c.raiseCapBy) || c.raiseCapBy < 0) return no("bad_choice", "raiseCapBy must be a non-negative integer");
      if (state.needsHuman?.kind === "repair_cap" && c.raiseCapBy < 1) return no("bad_choice", "the repair cap was reached: raiseCapBy must be >= 1");
      return null;
    }
    case "verify.requested": {
      const run = state.run;
      if (!run || (state.status !== "running" && state.status !== "needs_human")) return no("wrong_state", `cannot verify a ticket that is ${state.status}`);
      if (!current(run, "acceptance")?.facts.checks.some((c) => c.id === inbound.data.check)) return no("unknown_check", `${inbound.data.check} is not a check of the current acceptance`);
      const a = acquire(world, `env:${state.env}`, run.manifest.verify.slots);
      return a.ok ? null : no("resource_unavailable", `verification resource is ${a.why === "tainted" ? "tainted (ark env unblock)" : "busy"}`);
    }
    case "effect.settled":
    case "resource.released":
      return null; // executor reports and wake-ups are never refused
    default:
      return assertNever(inbound);
  }
}

// ---------------------------------------------------------------- inbound handlers

/** run.requested / resume of a run-less ticket: request run.prepare (n = prepares + 1) under the run id minted by run.requested. */
function requestPrepare(acc: Acc): void {
  const s = acc.s;
  if (!s.prepare || !s.env || !s.input) throw new Error("decide: prepare without run.requested/ticket.created");
  request(acc, {
    key: effectKey({ ticket: s.ticket, run: s.prepare.runId, stage: "prepare", visit: 1, slot: MAIN, n: s.prepares + 1 }),
    ticket: s.ticket, lease: null, timeoutMs: PREPARE_TIMEOUT_MS,
    spec: { kind: "run.prepare", env: s.env, runId: s.prepare.runId, ticketInput: s.input },
  });
}

/**
 * effect.settled. FIXED PRECEDENCE, each step independent of the next:
 *   1. req = the in-flight request for the key (a run effect, or the prepare effect of a run-less ticket); absent
 *      (late or duplicate report) => empty Decision
 *   2. outcome.taint => emit resource.tainted{resource, key, reason} UNCONDITIONALLY, whatever the ticket's status:
 *      the block must be durable even if the ticket was aborted or has since escalated
 *   3. req.spec is a repro verify (spec.repro != null) => produced: repro.recorded; anything else: nothing.
 *      INDEPENDENT of ticket status (a repro after the repair cap is the acceptance-3 case) and never a transition
 *   4. a flow effect arriving when the ticket is not in the status that effect belongs to (needs_human, aborted,
 *      landed), or one issued for an earlier stage visit => emit nothing more; fold clears inflight; the late
 *      result is audit-only
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
function onSettled(acc: Acc, inbound: In<"effect.settled">, req: EffectRequest | undefined): void {
  if (!req) return;
  const { outcome } = inbound.data;
  const spec = req.spec;

  if (outcome.taint) {
    emit(acc, "resource.tainted", { ticket: inbound.data.ticket, resource: outcome.taint.resource, key: req.key, reason: outcome.taint.reason });
  }
  if (spec.kind === "verify" && spec.repro) {
    if (outcome.tag === "produced") emit(acc, "repro.recorded", { key: req.key, artifact: outcome.artifact });
    return;
  }
  if (spec.kind === "run.prepare") {
    if (acc.s.status !== "preparing") return;
    if (outcome.tag === "prepared") {
      emit(acc, "run.started", { runId: spec.runId, manifest: outcome.manifest, pipeline: outcome.pipeline, head: outcome.head });
      enter(acc, runOf(acc).pipeline.entry, null);
    } else {
      raise(acc, { kind: "prepare_failed", why: describe(outcome) });
    }
    return;
  }

  const run = acc.s.run;
  if (acc.s.status !== "running" || !run?.stage) return;
  const parts = effectKeyParts(req.key);
  if (parts.stage !== run.stage.stage || parts.visit !== run.stage.visit) return;

  switch (outcome.tag) {
    case "cancelled":
      return;
    case "timed_out":
      return raise(acc, { kind: "timed_out", key: req.key });
    case "ambiguous":
      return raise(acc, { kind: "ambiguous_effect", key: req.key, why: outcome.why });
  }
  if (spec.kind === "attempt") {
    if (outcome.tag === "produced") onAttemptProduced(acc, req, outcome.artifact);
    else if (outcome.tag === "rejected" || outcome.tag === "crashed" || outcome.tag === "interrupted") retryOrEscalate(acc, req, outcome);
    else raise(acc, { kind: "inconsistent", why: `attempt reported ${outcome.tag}` });
  } else if (outcome.tag === "produced") {
    emit(acc, "artifact.recorded", { stage: run.stage.stage, slot: MAIN, artifact: outcome.artifact });
    complete(acc, run.stage.stage, outcome.artifact);
  } else if (outcome.tag === "crashed" || outcome.tag === "interrupted") {
    raise(acc, { kind: "attempt_failed", stage: run.stage.stage, slot: MAIN, detail: describe(outcome) });
  } else {
    raise(acc, { kind: "inconsistent", why: `${spec.kind} reported ${outcome.tag}` });
  }
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
  if (req.spec.kind !== "attempt") throw new Error("decide: onAttemptProduced on a non-attempt");
  const slot = req.spec.slot;
  const stage = runOf(acc).stage!.stage;
  emit(acc, "artifact.recorded", { stage, slot, artifact });
  const head = runOf(acc).head;
  if (artifact.head !== head) emit(acc, "head.advanced", { from: head, to: artifact.head });

  const def = runOf(acc).pipeline.stages[stage] as AgentStage;
  if (def.fanout && slot.startsWith("fan:")) {
    const fan = fanSlots(runOf(acc));
    if (fan.length === bindingOf(acc, def.fanout.role).count && fan.every((s) => s.done !== null)) {
      request(acc, attemptRequestFor(acc, stage, "join" as SlotId, 1));
    }
    return;
  }
  complete(acc, stage, artifact);
}

/** The fan slots' progress of the current stage visit, in slot order. */
function fanSlots(run: RunState) {
  return Object.entries(run.stage?.slots ?? {}).filter(([id]) => id.startsWith("fan:")).map(([, s]) => s);
}

/**
 * Rejected/crashed/interrupted attempt. If slot.retries < binding.maxRetries:
 *   attempt.retried + a NEW AttemptSpec (n+1, same baseHead, feedback = rejection text).
 * Else needs_human(attempt_failed). Retries never touch the repair cap: an attempt that
 * the seal refused or that died is not a verified failed round.
 */
function retryOrEscalate(acc: Acc, req: EffectRequest, outcome: Outcome): void {
  if (req.spec.kind !== "attempt") throw new Error("decide: retryOrEscalate on a non-attempt");
  const { slot, n, role } = req.spec;
  const stage = runOf(acc).stage!.stage;
  const used = runOf(acc).stage!.slots[slot]?.retries ?? 0;
  if (used < bindingOf(acc, role).maxRetries) {
    emit(acc, "attempt.retried", { stage, slot, n: n + 1, why: describe(outcome) });
    request(acc, attemptRequestFor(acc, stage, slot, n + 1));
  } else {
    raise(acc, { kind: "attempt_failed", stage, slot, detail: describe(outcome) });
  }
}

/**
 * A stage produced artifact A (outcome o = A.outcome). Then advance(stage, o).
 * Before ENTERING `ark.publish` (in enter(), not here): current(verification) and current(qe_report) must both exist,
 * be `pass`, and carry head === acc.s.run.head; violation -> needs_human(inconsistent), nothing requested. That is a
 * head-currency check (a new head may have appeared since), not a cross-artifact one.
 */
function complete(acc: Acc, stage: StageId, artifact: AnyRecorded): void {
  advance(acc, stage, artifact.outcome);
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
  const run = runOf(acc);
  const kind = producesOf(run.pipeline.stages[from]!);
  if (kind !== null && countsRepair(kind, outcome as never)) {
    const trigger = run.artifacts[kind]!;
    const n = run.repairs.count + 1;
    emit(acc, "repair.counted", { n, cap: run.repairs.cap, reason: REPAIR_REASON[kind as keyof typeof REPAIR_REASON], trigger });
    if (n >= run.repairs.cap) return raise(acc, { kind: "repair_cap", count: n, cap: run.repairs.cap });
  }
  const target = run.pipeline.transitions[from]?.[outcome];
  if (target === undefined) throw new Error(`decide: stage ${from} has no edge for outcome ${outcome}`);
  if (target === "needs_human") return raise(acc, { kind: "pipeline_escalation", stage: from, outcome });
  if (target === "landed") return emit(acc, "ticket.landed", {});
  enter(acc, target, { from, outcome });
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
 * The same holds for a gate whose `approves` kind, a publish without a current passing verification and QE report,
 * a verify without acceptance checks, and a wait without an MR.
 */
function enter(acc: Acc, target: StageId, via: { from: StageId; outcome: string } | null): void {
  const def = runOf(acc).pipeline.stages[target]!;
  const visit = (runOf(acc).visits[target] ?? 0) + 1;
  emit(acc, "stage.entered", { stage: target, visit, via });
  const missing = (kind: ArtifactKind): void => raise(acc, { kind: "inconsistent", why: `stage ${target} needs a current ${kind}` });

  switch (def.kind) {
    case "agent": {
      const absent = def.in.find((k) => !current(runOf(acc), k));
      if (absent) return missing(absent);
      if (!def.fanout) return request(acc, attemptRequestFor(acc, target, MAIN, 1));
      const width = bindingOf(acc, def.fanout.role).count;
      for (let i = 0; i < width; i++) request(acc, attemptRequestFor(acc, target, `fan:${i}` as SlotId, 1));
      return;
    }
    case "command": {
      if (COMMANDS[def.run] === "verification") return enterVerify(acc);
      const run = runOf(acc);
      const v = current(run, "verification");
      const qe = current(run, "qe_report");
      if (v?.outcome !== "pass" || qe?.outcome !== "pass") {
        return raise(acc, { kind: "inconsistent", why: `publish needs a current passing verification and QE report for head ${run.head}` });
      }
      return request(acc, publishRequestFor(acc, target));
    }
    case "wait": {
      const mr = current(runOf(acc), "mr");
      if (!mr) return missing("mr");
      return request(acc, waitRequestFor(acc, target));
    }
    case "gate": {
      const pins: { [K in ArtifactKind]?: AnyRecorded["hash"] } = {};
      for (const k of def.approves) {
        const a = currentAny(runOf(acc), k);
        if (!a) return missing(k);
        pins[k] = a.hash;
      }
      return emit(acc, "gate.opened", { gate: `${target}#${visit}` as GateId, stage: target, pins });
    }
  }
}

/** Verify stage entry: lease the smallest free slot, or wait. */
function enterVerify(acc: Acc): void {
  if (!current(runOf(acc), "acceptance")) return raise(acc, { kind: "inconsistent", why: "verify needs the current acceptance checks" });
  const lease = leaseFor(acc);
  if (lease) request(acc, verifyRequestFor(acc, lease, null));
  else emit(acc, "stage.waiting", { stage: runOf(acc).stage!.stage, resource: envResource(acc) });
}

function leaseFor(acc: Acc): Lease | null {
  const resource = envResource(acc);
  const a = acquire(acc.w, resource, runOf(acc).manifest.verify.slots);
  return a.ok ? { resource, slot: a.slot } : null;
}

/**
 * resource.released for a ticket whose stage.waitingOn matches: retry the lease. Available -> effect requested
 * (stage.entered is NOT repeated). Still blocked -> nothing and the stage keeps waiting.
 * Anything else (not waiting, different resource) -> nothing.
 */
function onResourceReleased(acc: Acc, inbound: In<"resource.released">): void {
  const stage = acc.s.run?.stage;
  if (acc.s.status !== "running" || stage?.waitingOn !== inbound.data.resource) return;
  const lease = leaseFor(acc);
  if (lease) request(acc, verifyRequestFor(acc, lease, null));
}

/**
 * verify.requested (defect repro). Refused (refusalFor) unless run exists, status is running|needs_human, `check` is a
 * check id of current(acceptance).facts.checks. Takes a lease like a flow verify but NEVER waits: unavailable ->
 * refusal resource_unavailable (the engineer is at the keyboard and can retry). Effect: VerifySpec with
 * `repro: {check}`, key stage "repro", visit = number of repros so far + 1, vector = revisionVector(run).
 */
function onVerifyRequested(acc: Acc, inbound: In<"verify.requested">): void {
  const lease = leaseFor(acc);
  if (!lease) throw new Error("decide: verify.requested passed refusalFor without a lease");
  request(acc, verifyRequestFor(acc, lease, inbound.data.check));
}

/**
 * gate.decided (refusalFor already required an open gate with this id and echoed pins: the echo is the DECISION
 * RECORD of spec §10, which hashes the human approved, not a second safety mechanism). Then:
 *   approve          -> if stage.locks: locks.pinned{ LockSet[] from the approved artifacts' `pinned` (the acceptance)}
 *                       REPLACING locks; advance(stage, "approved")
 *   request_changes  -> advance(stage, "changes_requested")
 *   reject           -> advance(stage, "rejected")
 * A plan amendment (build material_change -> plan -> acceptance -> plan_gate) re-locks through this same gate:
 * the acceptance author is exempt from locks (guardFor) and the new approval replaces them (decision 9).
 */
function onGateDecided(acc: Acc, inbound: In<"gate.decided">): void {
  const run = runOf(acc);
  const stage = run.stage!.stage;
  const def = run.pipeline.stages[stage]!;
  if (def.kind !== "gate") throw new Error(`decide: gate.decided but stage ${stage} is ${def.kind}`);
  const { decision } = inbound.data;
  if (decision === "approve" && def.locks) {
    emit(acc, "locks.pinned", { locks: def.approves.flatMap((k) => currentAny(run, k)?.pinned ?? []) });
  }
  advance(acc, stage, GATE_OUTCOME[decision]);
}

/**
 * human.resolved on a needs_human ticket (refusalFor validated the choice).
 *   resume{to, raiseCapBy}:
 *     run === null (prepare failed): request run.prepare again (n = prepares+1); needs_human.cleared.
 *     otherwise needs_human.cleared + enter(to). Fold resets nothing but the flag and cap:
 *     heads, artifacts, counter history stay.
 *   abort: needs_human.cleared + ticket.aborted + cancel every inflight key (repros included).
 */
function onHumanResolved(acc: Acc, inbound: In<"human.resolved">): void {
  const choice = inbound.data.choice;
  emit(acc, "needs_human.cleared", { choice });
  if (choice.kind === "abort") {
    emit(acc, "ticket.aborted", {});
    acc.cancel.push(...(Object.keys(acc.s.run?.inflight ?? {}) as EffectKey[]));
  } else if (choice.to === null) {
    requestPrepare(acc);
  } else {
    enter(acc, choice.to, null);
  }
}

// ---------------------------------------------------------------- request builders (pure over acc.s)

function bindingOf(acc: Acc, role: RoleBinding["role"]): RoleBinding {
  const b = runOf(acc).manifest.roles[role];
  if (!b) throw new Error(`decide: manifest has no binding for role ${role}`);
  return b;
}

/**
 * AttemptSpec for (role, slot, n): resolves binding from manifest.roles, `inputs` = current recorded
 * artifacts named by stage.in plus repairs.trigger (in full), `fanInputs` = for the JOIN phase,
 * the fan slots' artifacts in slot order (the lead sees every reviewer; a per-kind lookup would see one),
 * `guard` from guardFor(), baseHead = acc.s.run.head (the head AS ADVANCED by earlier events of this call),
 * feedback from SlotProgress.
 */
function attemptRequestFor(acc: Acc, stage: StageId, slot: SlotId, n: number): EffectRequest {
  const run = runOf(acc);
  const def = run.pipeline.stages[stage] as AgentStage;
  const isFan = slot.startsWith("fan:");
  const binding = bindingOf(acc, isFan ? def.fanout!.role : def.role);
  const inputs = def.in.map((k) => currentAny(run, k)).filter((a): a is AnyRecorded => a !== null);
  const trigger = run.repairs.trigger;
  if (trigger && !inputs.some((a) => a.hash === trigger.hash)) inputs.push(trigger);
  const fanInputs = slot === "join" ? fanSlots(run).flatMap((s) => (s.done ? [s.done] : [])) : [];
  const worktree = run.manifest.repos.find((r) => r.id === run.manifest.primary)?.worktree;
  if (!worktree) throw new Error("decide: the primary repo has no worktree in the manifest");
  return {
    key: effectKey({ ticket: acc.s.ticket, run: run.runId, stage, visit: run.stage!.visit, slot, n }),
    ticket: acc.s.ticket, lease: null, timeoutMs: binding.deadlineMs,
    spec: {
      kind: "attempt", role: binding.role, slot, n, harness: binding.harness, model: binding.model,
      repo: run.manifest.primary, workdir: worktree, baseHead: run.head, skills: binding.skills,
      inputs, fanInputs, feedback: run.stage!.slots[slot]?.feedback ?? null,
      out: isFan ? def.fanout!.out : def.out, guard: guardFor(acc, def, binding),
    },
  };
}

/**
 * The Guard the seal enforces. The ONE place WriteScope becomes globs and locks become exemptions:
 *   allowedPaths: none -> []; plan.allowedPaths -> current(plan).facts.allowedPaths; globs -> scope.globs
 *   locked:       acc.s.run.locks (roots + per-file hashes), EXCEPT [] for a role that produces a kind in `approves`
 *                 of a `locks: true` gate (it authors the locked material; the gate re-locks it)
 *   evidence:     for an agent stage that reads the verification bundle (`in` has "verification": QE), the
 *                 verification facts {evidenceDir, sumsDigest}; null otherwise
 */
function guardFor(acc: Acc, def: AgentStage, role: RoleBinding): Guard {
  const run = runOf(acc);
  const scope = role.writes;
  const stages = Object.values(run.pipeline.stages);
  const lockedKinds = stages.flatMap((s) => (s.kind === "gate" && s.locks ? s.approves : []));
  const authors = stages.some((s) => s.kind === "agent" && s.role === role.role && lockedKinds.includes(s.out));
  const v = def.in.includes("verification") ? current(run, "verification") : null;
  return {
    allowedPaths: scope.kind === "none" ? [] : scope.kind === "globs" ? scope.globs : (current(run, "plan")?.facts.allowedPaths ?? []),
    locked: authors ? [] : run.locks,
    evidence: v ? { dir: v.facts.evidenceDir, sumsDigest: v.facts.sumsDigest } : null,
  };
}

/**
 * VerifySpec: vector = revisionVector(run) (env sha + EVERY repo sha), checks = current(acceptance).facts.checks,
 * locks = run.locks, recipe from the manifest, project = projectName(env, slot) (world.ts), n = this visit's ordinal.
 * `repro` null = the flow stage (key stage = the current stage); non-null = `ark verify --check` (key stage "repro",
 * visit = repros requested so far + 1).
 * ponytail: `n` is the visit of this stage; two verify stages in one pipeline would share evidence/<n>/.
 */
function verifyRequestFor(acc: Acc, lease: Lease, repro: string | null): EffectRequest {
  const run = runOf(acc);
  const recipe = run.manifest.verify;
  const flow = repro === null;
  const visit = flow ? run.stage!.visit : run.reproRequests + 1;
  return {
    key: effectKey({ ticket: acc.s.ticket, run: run.runId, stage: flow ? run.stage!.stage : "repro", visit, slot: MAIN, n: 1 }),
    ticket: acc.s.ticket, lease, timeoutMs: recipe.timeoutMs,
    spec: {
      kind: "verify", primary: run.manifest.primary, vector: revisionVector(run),
      checks: current(run, "acceptance")!.facts.checks, locks: run.locks, recipe, n: visit, slot: lease.slot,
      project: projectName(run.manifest.env.id, lease.slot), repro: flow ? null : { check: repro },
    },
  };
}

function publishRequestFor(acc: Acc, stage: StageId): EffectRequest {
  const run = runOf(acc);
  const pin = run.manifest.repos.find((r) => r.id === run.manifest.primary);
  if (!pin?.branch) throw new Error("decide: the primary repo has no branch in the manifest");
  const describeKinds: ArtifactKind[] = ["plan", "acceptance", "build", "review", "verification", "qe_report"];
  return {
    key: effectKey({ ticket: acc.s.ticket, run: run.runId, stage, visit: run.stage!.visit, slot: MAIN, n: 1 }),
    ticket: acc.s.ticket, lease: null, timeoutMs: PUBLISH_TIMEOUT_MS,
    spec: {
      kind: "publish", repo: run.manifest.primary, branch: pin.branch, baseBranch: pin.baseBranch, head: run.head,
      describe: describeKinds.flatMap((k) => { const a = currentAny(run, k); return a ? [a] : []; }),
      evidence: currentAny(run, "verification")!,
    },
  };
}

function waitRequestFor(acc: Acc, stage: StageId): EffectRequest {
  const run = runOf(acc);
  const def = run.pipeline.stages[stage];
  const mr = current(run, "mr");
  if (def?.kind !== "wait" || !mr) throw new Error(`decide: ${stage} is not a wait stage with a current mr`);
  return {
    key: effectKey({ ticket: acc.s.ticket, run: run.runId, stage, visit: run.stage!.visit, slot: MAIN, n: 1 }),
    ticket: acc.s.ticket, lease: null, timeoutMs: null,
    spec: { kind: "forge.wait", for: def.for, mr: { iid: mr.facts.iid, branch: mr.facts.branch }, head: run.head, pollMs: WAIT_POLL_MS },
  };
}
