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
} from "./ids";
import type { AnyRecorded, ArtifactKind, LockSet, RecordedArtifact } from "./contracts";
import type { Pipeline, RevisionVector, RunManifest, Stage } from "./pipeline";
import type { EffectRequest, Outcome, Resource, TicketInput, Usage } from "./effects";
import type { Draft, NeedsHumanReason, Pins, RepairReason, TicketEvent } from "./events";

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
}

export interface TicketState {
  readonly ticket: TicketId;
  readonly env: EnvId | null;
  readonly input: TicketInput | null;
  readonly status: Status;
  readonly run: RunState | null;
  /** run.prepare effects requested so far (1 after run.requested); the `n` of the next prepare key. */
  readonly prepares: number;
  readonly needsHuman: NeedsHumanReason | null;
}

export function emptyState(ticket: TicketId): TicketState {
  throw new Error("not implemented");
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
  throw new Error("not implemented");
}

export function replay(ticket: TicketId, events: Iterable<Draft<TicketEvent>>): TicketState {
  throw new Error("not implemented");
}

/** Latest artifact of `kind`, or null if it is headBound (CATALOG) and was produced for another head. The one staleness rule. */
export function current<K extends ArtifactKind>(run: RunState, kind: K): RecordedArtifact<K> | null {
  throw new Error("not implemented");
}

/**
 * The full revision vector verify runs against: manifest.base with the primary repo at `run.head`.
 * The ONLY place a vector is assembled.
 */
export function revisionVector(run: RunState): RevisionVector {
  throw new Error("not implemented");
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
  throw new Error("not implemented");
}
