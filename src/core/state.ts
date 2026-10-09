/**
 * state.ts — TicketState and its only constructor, `fold`. @layer core.
 *
 *   TicketState === ticketEvents.reduce(fold, emptyState(ticket))
 *
 * There is no other way to build or change a TicketState: no setters, every field
 * readonly, fold is the only function that returns one. Everything the rest of the
 * system calls "ticket state", "attempt table", "repair counter", "needs-human queue",
 * "locked checks", "the pipeline this run follows" is a field here or a `view()` over it.
 * (Cross-ticket facts — taint, slot leases, env registry — are world.ts.)
 *
 * fold is TOTAL and pure: exhaustive switch over TicketEvent (compile error on a new event type
 * until handled), no I/O, no clock, no randomness, no file reads. It accepts `Draft<TicketEvent>`
 * (no `seq`), so decide() can advance a private copy of the state while it emits (decide.ts header).
 * The state carries NO ledger position: the engine tracks `lastSeq` per stream next to the state it caches.
 * Observations and world events are not accepted by its signature.
 */
import type {
  EffectKey, EnvId, GateId, GitSha, RunId, SlotId, StageId, TicketId, Sha256, IsoTime,
} from "./ids.ts";
import { CATALOG } from "./contracts.ts";
import type { AnyRecorded, ArtifactKind, LockSet, RecordedArtifact } from "./contracts.ts";
import { producesOf } from "./pipeline.ts";
import type { Pipeline, RevisionVector, RunManifest, Stage } from "./pipeline.ts";
import type { EffectRequest, Outcome, Resource, TicketInput, Usage } from "./effects.ts";
import type { Draft, NeedsHumanReason, Pins, RepairReason, TicketEvent } from "./events.ts";

export type Status =
  | "unborn" //      before ticket.created
  | "created" //     ticket exists, not started
  | "preparing" //   run.requested seen; run.prepare in flight
  | "running" //     a stage is active (including an open gate or a stage waiting on a resource)
  | "needs_human" // (run may be null: prepare failed; resume re-requests prepare)
  | "landed"
  | "aborted";

/** One agent attempt's slot inside the current stage visit. */
export interface SlotProgress {
  readonly n: number; //                          current attempt ordinal (1-based)
  readonly done: AnyRecorded | null; //           artifact once sealed
  readonly retries: number; //                    consumed against RoleBinding.maxRetries
  readonly feedback: string | null; //            rejection text to attach to the next attempt
}

export interface StageProgress {
  readonly stage: StageId;
  readonly visit: number; //                      1-based count of entries into this stage in this run
  readonly kind: Stage["kind"];
  /** agent stages only: "fan" while fanout slots run, then "join"; "main" when no fanout. */
  readonly phase: "main" | "fan" | "join" | null;
  /** The join's inputs are `Object.values(slots).map(s => s.done)` of the fan phase, in slot order. */
  readonly slots: Readonly<Record<SlotId, SlotProgress>>;
  /** Set by stage.waiting, cleared by effect.requested. The engine wakes waiters with resource.released. */
  readonly waitingOn: Resource | null;
}

/** Dashboard row for one attempt: role, harness, model, elapsed (requestedAt..settledAt), cost or "unknown". */
export interface AttemptRecord {
  readonly role: string; readonly harness: string; readonly model: string;
  readonly stage: StageId; readonly slot: SlotId; readonly n: number;
  readonly requestedAt: IsoTime;
  readonly settledAt: IsoTime | null;
  readonly result: Outcome["tag"] | null; // null while running
  readonly usage: Usage | null; //             null = unknown, never zero-by-default (decision 39)
}

export interface OpenGate {
  readonly gate: GateId;
  readonly stage: StageId;
  readonly pins: Pins; //                         the hashes of `approves`; the decision records them
}

export interface RunState {
  readonly runId: RunId;
  readonly manifest: RunManifest;
  /** The validated pipeline, from run.started. decide() reads it here; there is no pipeline parameter and no engine-side cache. */
  readonly pipeline: Pipeline;
  readonly stage: StageProgress | null; //        null only between run.started and the first stage.entered
  readonly visits: Readonly<Record<StageId, number>>;
  /** Latest recorded artifact per kind. Stale ones stay (history) but `current()` filters by head. */
  readonly artifacts: Readonly<{ [K in ArtifactKind]?: RecordedArtifact<K> }>;
  /** Primary-repo head. The other repos of the revision vector are pinned in the manifest and never move. */
  readonly head: GitSha;
  /** The locks of the LATEST approval at a locking gate (each locks.pinned replaces the previous). */
  readonly locks: readonly LockSet[];
  readonly repairs: {
    readonly count: number;
    readonly cap: number;
    /** The artifact that caused the latest repair; becomes an input of the re-entered stage. Cleared when that stage's artifact records. */
    readonly trigger: AnyRecorded | null;
    readonly history: readonly { readonly n: number; readonly reason: RepairReason; readonly artifact: Sha256 }[];
  };
  readonly gate: OpenGate | null;
  /** Requested and not yet settled. This ticket's slice of the lease table, and the only liveness record. */
  readonly inflight: Readonly<Record<EffectKey, EffectRequest>>;
  /** Attempt table: one row per attempt effect, folded from effect.requested / effect.settled. History, not liveness. */
  readonly attempts: Readonly<Record<EffectKey, AttemptRecord>>;
  /** Non-flow verify results (defect repro), by effect key. */
  readonly repros: Readonly<Record<EffectKey, AnyRecorded>>;
  /** Non-flow verify effects requested so far (recorded or not): the visit of the next repro key. */
  readonly reproRequests: number;
}

export interface TicketState {
  readonly ticket: TicketId;
  readonly env: EnvId | null;
  readonly input: TicketInput | null;
  readonly status: Status;
  readonly run: RunState | null;
  /** run.prepare effects requested so far (1 after run.requested); the `n` of the next prepare key. */
  readonly prepares: number;
  /**
   * The run-less slice of the ticket: the run id minted by run.requested (`r_<event id>`, stable across prepare
   * retries so a resumed prepare finds its own footprint) and the run.prepare request in flight, if any.
   * Null before run.requested. Once a run exists its effects live in `run.inflight`.
   */
  readonly prepare: { readonly runId: RunId; readonly inflight: EffectRequest | null } | null;
  readonly needsHuman: NeedsHumanReason | null;
}

export function emptyState(ticket: TicketId): TicketState {
  return { ticket, env: null, input: null, status: "unborn", run: null, prepare: null, prepares: 0, needsHuman: null };
}

/**
 * The reducer. Pure, total, deterministic.
 * Invariants it maintains (and tests assert after every event over real logs):
 *  - run.repairs.count only moves on repair.counted and equals repairs.history.length
 *  - run.inflight gains a key on effect.requested and loses it on effect.settled, nothing else
 *  - run.locks is set only by locks.pinned, which REPLACES it (a re-approval after a re-plan re-locks)
 *  - run.head only moves on head.advanced / run.started
 *  - run.artifacts never receives a repro (repro.recorded writes run.repros)
 *  - status "landed" | "aborted" is absorbing
 *  - resource.tainted changes NO ticket state (World owns it)
 */
export function fold(state: TicketState, event: Draft<TicketEvent>): TicketState {
  if (event.v !== 1) throw new Error(`unknown event version ${String((event as { v: unknown }).v)}`);
  const terminal = state.status === "landed" || state.status === "aborted";
  // Absorbing: only late reports and repros (audit) still land on a finished ticket.
  if (terminal && event.type !== "effect.settled" && event.type !== "repro.recorded") return state;

  const run = state.run;
  const withRun = (patch: Partial<RunState>): TicketState => (run ? { ...state, run: { ...run, ...patch } } : state);
  const withStage = (patch: Partial<StageProgress>): TicketState => (run?.stage ? withRun({ stage: { ...run.stage, ...patch } }) : state);

  switch (event.type) {
    case "ticket.created":
      return { ...state, env: event.data.env, input: event.data.input, status: "created" };
    case "run.requested":
      return { ...state, status: "preparing", prepare: { runId: `r_${event.id}` as RunId, inflight: null } };
    case "run.started": {
      const d = event.data;
      return {
        ...state, status: "running",
        run: {
          runId: d.runId, manifest: d.manifest, pipeline: d.pipeline, stage: null, visits: {}, artifacts: {}, head: d.head,
          locks: [], repairs: { count: 0, cap: d.pipeline.repairCap, trigger: null, history: [] },
          gate: null, inflight: {}, attempts: {}, repros: {}, reproRequests: 0,
        },
      };
    }
    case "stage.entered": {
      if (!run) return state;
      const def = run.pipeline.stages[event.data.stage];
      const phase = def?.kind === "agent" ? (def.fanout ? "fan" : "main") : null;
      return withRun({
        visits: { ...run.visits, [event.data.stage]: event.data.visit },
        stage: { stage: event.data.stage, visit: event.data.visit, kind: def?.kind ?? "gate", phase, slots: {}, waitingOn: null },
      });
    }
    case "stage.waiting":
      return withStage({ waitingOn: event.data.resource });
    case "effect.requested": {
      const req = event.data.request;
      const spec = req.spec;
      if (spec.kind === "run.prepare") {
        return { ...state, prepare: { runId: spec.runId, inflight: req }, prepares: state.prepares + 1 };
      }
      if (!run) return state;
      const isRepro = spec.kind === "verify" && spec.repro !== null;
      const next = { ...run, inflight: { ...run.inflight, [req.key]: req }, reproRequests: run.reproRequests + (isRepro ? 1 : 0) };
      if (spec.kind !== "attempt" || !run.stage) {
        const stage = run.stage && !isRepro ? { ...run.stage, waitingOn: null } : run.stage;
        return { ...state, run: { ...next, stage } };
      }
      const prev = run.stage.slots[spec.slot];
      const slot: SlotProgress = { n: spec.n, done: null, retries: prev?.retries ?? 0, feedback: spec.feedback };
      const record: AttemptRecord = {
        role: spec.role, harness: spec.harness, model: spec.model, stage: run.stage.stage, slot: spec.slot, n: spec.n,
        requestedAt: event.ts, settledAt: null, result: null, usage: null,
      };
      return {
        ...state,
        run: {
          ...next, attempts: { ...run.attempts, [req.key]: record },
          stage: { ...run.stage, phase: spec.slot === "join" ? "join" : run.stage.phase, waitingOn: null, slots: { ...run.stage.slots, [spec.slot]: slot } },
        },
      };
    }
    case "effect.settled": {
      const key = event.data.key;
      const outcome = event.data.outcome;
      if (state.prepare?.inflight?.key === key) return { ...state, prepare: { ...state.prepare, inflight: null } };
      if (!run || !(key in run.inflight)) return state;
      const { [key]: _gone, ...inflight } = run.inflight;
      const rec = run.attempts[key];
      const usage = "usage" in outcome ? outcome.usage : null;
      const attempts = rec ? { ...run.attempts, [key]: { ...rec, settledAt: event.ts, result: outcome.tag, usage } } : run.attempts;
      return { ...state, run: { ...run, inflight, attempts } };
    }
    case "attempt.retried": {
      const prev = run?.stage?.slots[event.data.slot];
      if (!run?.stage || !prev) return state;
      return withStage({ slots: { ...run.stage.slots, [event.data.slot]: { ...prev, n: event.data.n, retries: prev.retries + 1, feedback: event.data.why } } });
    }
    case "artifact.recorded": {
      if (!run) return state;
      const { stage, slot, artifact } = event.data;
      const progress = run.stage;
      const prev = progress?.slots[slot];
      const def = run.pipeline.stages[stage];
      const clearsTrigger = def !== undefined && producesOf(def) === artifact.kind;
      return {
        ...state,
        run: {
          ...run,
          artifacts: { ...run.artifacts, [artifact.kind]: artifact } as RunState["artifacts"],
          repairs: clearsTrigger ? { ...run.repairs, trigger: null } : run.repairs,
          stage: progress ? { ...progress, slots: { ...progress.slots, [slot]: { n: prev?.n ?? 1, retries: prev?.retries ?? 0, feedback: prev?.feedback ?? null, done: artifact } } } : progress,
        },
      };
    }
    case "repro.recorded":
      return withRun({ repros: { ...run?.repros, [event.data.key]: event.data.artifact } });
    case "repair.counted": {
      if (!run) return state;
      const d = event.data;
      return withRun({
        repairs: {
          count: d.n, cap: d.cap, trigger: d.trigger,
          history: [...run.repairs.history, { n: d.n, reason: d.reason, artifact: d.trigger.hash }],
        },
      });
    }
    case "gate.opened":
      return withRun({ gate: { gate: event.data.gate, stage: event.data.stage, pins: event.data.pins } });
    case "gate.decided":
      return withRun({ gate: null });
    case "locks.pinned":
      return withRun({ locks: event.data.locks });
    case "head.advanced":
      return withRun({ head: event.data.to });
    case "needs_human.raised":
      return { ...state, status: "needs_human", needsHuman: event.data.reason };
    case "needs_human.cleared": {
      const c = event.data.choice;
      if (c.kind === "abort") return { ...state, needsHuman: null };
      const raised = run ? { ...state, run: { ...run, repairs: { ...run.repairs, cap: run.repairs.cap + c.raiseCapBy } } } : state;
      return { ...raised, needsHuman: null, status: run ? "running" : "preparing" };
    }
    case "ticket.landed":
      return { ...state, status: "landed" };
    case "ticket.aborted":
      return { ...state, status: "aborted" };
    case "resource.tainted": // World owns it
    case "human.resolved":
    case "verify.requested":
    case "resource.released":
      return state;
    default:
      return assertNever(event);
  }
}

function assertNever(x: never): never {
  throw new Error(`unhandled event ${JSON.stringify(x)}`);
}

export function replay(ticket: TicketId, events: Iterable<Draft<TicketEvent>>): TicketState {
  let s = emptyState(ticket);
  for (const e of events) s = fold(s, e);
  return s;
}

/** Latest artifact of `kind`, or null if it is headBound (CATALOG) and was produced for another head. The one staleness rule. */
export function current<K extends ArtifactKind>(run: RunState, kind: K): RecordedArtifact<K> | null {
  const a = run.artifacts[kind];
  if (!a) return null;
  return CATALOG[kind].headBound && a.head !== run.head ? null : a;
}

/**
 * The full revision vector verify runs against: manifest.base with the primary repo at `run.head`.
 * The ONLY place a vector is assembled.
 */
export function revisionVector(run: RunState): RevisionVector {
  const { env, repos } = run.manifest.base;
  return { env, repos: { ...repos, [run.manifest.primary]: run.head } };
}

// ------------------------------------------------------------------ projections

/**
 * Read model for CLI/dashboard. A pure function of state (derive instead of sync): board row, attempt table,
 * lease table, needs-human reason, repair count, same-model disclosure, cost-or-unknown. There is no
 * projection TABLE: the engine's fold cache IS the projection (decision 31 "rebuildable projections"), rebuilt by
 * replaying the log at startup, so there is no second copy that could drift.
 */
export interface TicketView {
  readonly ticket: TicketId;
  readonly status: Status;
  readonly stage: { readonly id: StageId; readonly visit: number; readonly kind: Stage["kind"] } | null;
  readonly waitingOn: Resource | null;
  readonly attention: "none" | "gate" | "needs_human"; // the needs-human queue is `attention != none`
  /** The open gate. Clients decide by echoing `gate.pins` verbatim (the CLI never reassembles them). */
  readonly gate: OpenGate | null;
  readonly needsHuman: NeedsHumanReason | null;
  readonly repairs: { readonly count: number; readonly cap: number };
  readonly attempts: readonly (AttemptRecord & { readonly key: EffectKey })[];
  readonly leases: readonly { readonly resource: Resource; readonly slot: number; readonly key: EffectKey }[];
  readonly repros: readonly { readonly key: EffectKey; readonly outcome: string; readonly evidenceDir: string }[];
  readonly disclosures: readonly string[];
  readonly artifacts: Readonly<{ [K in ArtifactKind]?: { readonly hash: Sha256; readonly outcome: string; readonly current: boolean } }>;
}
export function view(state: TicketState): TicketView {
  const run = state.run;
  const gate = run?.gate ?? null;
  const qe = run?.artifacts.qe_report;
  const artifacts: { [K in ArtifactKind]?: { hash: Sha256; outcome: string; current: boolean } } = {};
  if (run) for (const a of Object.values(run.artifacts) as AnyRecorded[]) artifacts[a.kind] = { hash: a.hash, outcome: a.outcome, current: current(run, a.kind) !== null };
  return {
    ticket: state.ticket,
    status: state.status,
    stage: run?.stage ? { id: run.stage.stage, visit: run.stage.visit, kind: run.stage.kind } : null,
    waitingOn: run?.stage?.waitingOn ?? null,
    attention: gate ? "gate" : state.status === "needs_human" ? "needs_human" : "none",
    gate,
    needsHuman: state.needsHuman,
    repairs: { count: run?.repairs.count ?? 0, cap: run?.repairs.cap ?? 0 },
    attempts: Object.entries(run?.attempts ?? {}).map(([key, a]) => ({ ...a, key: key as EffectKey })),
    leases: Object.values(run?.inflight ?? {}).flatMap((r) => (r.lease ? [{ resource: r.lease.resource, slot: r.lease.slot, key: r.key }] : [])),
    repros: Object.entries(run?.repros ?? {}).map(([key, a]) => ({
      key: key as EffectKey, outcome: a.outcome, evidenceDir: a.kind === "verification" ? a.facts.evidenceDir : "",
    })),
    disclosures: [...(run?.manifest.disclosures ?? []), ...(qe?.kind === "qe_report" && qe.facts.sameModelAsBuilder ? ["QE ran on the same model as the builder"] : [])],
    artifacts,
  };
}
