/**
 * events.ts — the ledger vocabulary. @layer core.
 *
 * Two disjoint families, separated by TYPE so they cannot be confused:
 *
 *   AuthoritativeEvent  - facts. `fold` / `foldWorld` consume these and ONLY these.
 *   ObservationEvent    - telemetry/lifecycle. Stored for timelines; no fold accepts one.
 *
 * Authoritative events split by stream:
 *   TicketEvent  - in `ticket:<id>` streams. Folded by state.ts#fold into TicketState.
 *   WorldEvent   - in the `world` stream (environment registry, human resource clearing).
 *                  Never routed through decide(): no transition logic, only validation by the engine.
 *   World state (tainted resources, slot leases, env registry) is folded by world.ts#foldWorld from BOTH
 *   streams in global seq order, so a taint raised in one ticket's stream blocks every ticket.
 *
 * Ticket events split by author:
 *   Inbound  - arrive from outside the pure core: human commands, executor reports, engine wake-ups.
 *   Decided  - produced by decide() as its answer to an inbound event.
 * `effect.requested` is emitted by decide() like any other decided event; `effectsOf(decision)` derives the
 * effect list from it, so each effect is stated once.
 *
 * Every event is a past-tense FACT with all the data fold needs. fold never reads a file, never re-runs
 * decide, and never calls a clock.
 *
 * Identity and order: the ENGINE mints every inbound event's id (a ULID) and ts BEFORE decide runs; decide derives
 * the ids of the events it emits deterministically (`${inbound.id}.${i}`). The ledger assigns ONLY `seq`, in the
 * committing transaction. So decide() and fold() work on `Draft<E>` (no seq) and never fabricate placeholders.
 */
import type {
  EventId, GateId, GitSha, IsoTime, RunId, Sha256, StageId, StreamId, TicketId, EnvId,
  EffectKey, SlotId,
} from "./ids.ts";
import type { AnyRecorded, ArtifactKind, LockSet } from "./contracts.ts";
import type { GateDecision, Pipeline, RunManifest } from "./pipeline.ts";
import type { EffectRequest, Outcome, Resource, Signal, TicketInput } from "./effects.ts";

interface Envelope<T extends string, D> {
  readonly id: EventId; //  see "Identity and order" above
  /** Event schema version. fold rejects versions it does not know; upcasters arrive when a ledger must outlive a release. */
  readonly v: 1;
  /** Global monotone ledger position. Assigned by the ledger on commit; absent from Drafts. */
  readonly seq: number;
  readonly ts: IsoTime; // stamped by the engine on receipt of an inbound; decide() copies it, never reads a clock
  readonly stream: StreamId;
  readonly type: T;
  readonly data: D;
}
type Authoritative<T extends string, D, S extends "human" | "orchestrator" = "orchestrator"> = Envelope<T, D> & {
  readonly authority: "authoritative";
  /** "human": a person via CLI/dashboard. "orchestrator": the engine (decide output, executor report, wake-up). */
  readonly source: S;
};

// ----------------------------------------------------------------------- reasons

export type NeedsHumanReason =
  | { readonly kind: "repair_cap"; readonly count: number; readonly cap: number }
  | { readonly kind: "ambiguous_effect"; readonly key: EffectKey; readonly why: string }
  | { readonly kind: "attempt_failed"; readonly stage: StageId; readonly slot: SlotId; readonly detail: string }
  | { readonly kind: "timed_out"; readonly key: EffectKey }
  | { readonly kind: "pipeline_escalation"; readonly stage: StageId; readonly outcome: string } // verify flaky/env_failure, qe flaky, ...
  | { readonly kind: "inconsistent"; readonly why: string } //            stale head at publish, missing input at a stage
  | { readonly kind: "prepare_failed"; readonly why: string };

export type HumanChoice =
  /**
   * `to: null` is for a ticket that never got a run (prepare failed): resume re-requests run.prepare.
   * Otherwise `to` is the stage to re-enter.
   */
  | { readonly kind: "resume"; readonly to: StageId | null; readonly raiseCapBy: number }
  | { readonly kind: "abort" };

export type RepairReason = "review_blockers" | "qe_defect" | "ci_blockers";

/** Hashes the human claims to have seen. A stale pin is refused, never silently accepted. */
export type Pins = Readonly<Partial<Record<ArtifactKind, Sha256>>>;

// ----------------------------------------------------------------------- inbound (ticket stream)

export type TicketCreated = Authoritative<"ticket.created", {
  readonly ticket: TicketId; readonly env: EnvId; readonly input: TicketInput;
}, "human">;
export type RunRequested = Authoritative<"run.requested", { readonly ticket: TicketId }, "human">;
export type GateDecided = Authoritative<"gate.decided", {
  readonly ticket: TicketId; readonly gate: GateId; readonly decision: GateDecision;
  readonly pins: Pins; readonly decider: string; readonly comment: string;
}, "human">;
export type HumanResolved = Authoritative<"human.resolved", { readonly ticket: TicketId; readonly choice: HumanChoice }, "human">;
/** `ark verify --check <id>`: a NON-FLOW run of the verify handler (defect repro). Never advances the pipeline. */
export type VerifyRequested = Authoritative<"verify.requested", { readonly ticket: TicketId; readonly check: string }, "human">;
/** The executor's one report per effect. Late/duplicate reports are no-ops (key not in state.inflight). */
export type EffectSettled = Authoritative<"effect.settled", {
  readonly ticket: TicketId; readonly key: EffectKey; readonly outcome: Outcome;
}>;
/**
 * Engine wake-up for a ticket whose stage is `waiting` on a resource: emitted after a lease is freed or a
 * taint is cleared (FIFO: the oldest waiter first, one per release). decide() re-checks availability; if still unavailable the stage keeps waiting.
 */
export type ResourceReleased = Authoritative<"resource.released", { readonly ticket: TicketId; readonly resource: Resource }>;

// ----------------------------------------------------------------------- decided (ticket stream)

export type RunStarted = Authoritative<"run.started", {
  readonly runId: RunId; readonly manifest: RunManifest; readonly pipeline: Pipeline; readonly head: GitSha;
}>;
export type StageEntered = Authoritative<"stage.entered", {
  readonly stage: StageId; readonly visit: number;
  /** The edge that led here; null for the entry stage. Doubles as the timeline. */
  readonly via: { readonly from: StageId; readonly outcome: string } | null;
}>;
/**
 * The stage needs `resource` and cannot have it now (tainted, or every slot leased). No effect was requested.
 * One waiting state: busy and tainted are not distinguished (the dashboard asks World why), so nothing goes stale.
 */
export type StageWaiting = Authoritative<"stage.waiting", { readonly stage: StageId; readonly resource: Resource }>;
export type EffectRequested = Authoritative<"effect.requested", { readonly request: EffectRequest }>;
export type AttemptRetried = Authoritative<"attempt.retried", {
  readonly stage: StageId; readonly slot: SlotId; readonly n: number; readonly why: string;
}>;
export type ArtifactRecorded = Authoritative<"artifact.recorded", {
  readonly stage: StageId; readonly slot: SlotId; readonly artifact: AnyRecorded;
}>;
/** Result of a non-flow verify. Kept apart from `artifacts` so a repro can never be mistaken for the stage's verification. */
export type ReproRecorded = Authoritative<"repro.recorded", { readonly key: EffectKey; readonly artifact: AnyRecorded }>;
/** The shared repair cap: the ONLY place the counter moves. */
export type RepairCounted = Authoritative<"repair.counted", {
  readonly n: number; readonly cap: number; readonly reason: RepairReason; readonly trigger: AnyRecorded;
}>;
export type GateOpened = Authoritative<"gate.opened", {
  readonly gate: GateId; readonly stage: StageId; readonly pins: Pins;
}>;
/** Locks acceptance inputs at plan approval. Written once per approval, from artifact.pinned (roots + per-file hashes). */
export type LocksPinned = Authoritative<"locks.pinned", { readonly locks: readonly LockSet[] }>;
export type HeadAdvanced = Authoritative<"head.advanced", { readonly from: GitSha; readonly to: GitSha }>;
/** Folded by foldWorld across ALL tickets. Blocks every verify lease on `resource` until `resource.cleared`. */
export type ResourceTainted = Authoritative<"resource.tainted", {
  readonly ticket: TicketId; readonly resource: Resource; readonly key: EffectKey; readonly reason: string;
}>;
export type NeedsHumanRaised = Authoritative<"needs_human.raised", { readonly reason: NeedsHumanReason }>;
export type NeedsHumanCleared = Authoritative<"needs_human.cleared", { readonly choice: HumanChoice }>;
export type TicketLanded = Authoritative<"ticket.landed", Record<string, never>>;
export type TicketAborted = Authoritative<"ticket.aborted", Record<string, never>>;

export type Inbound = TicketCreated | RunRequested | GateDecided | HumanResolved | VerifyRequested | EffectSettled | ResourceReleased;

export type TicketEvent =
  | Inbound
  | RunStarted | StageEntered | StageWaiting | EffectRequested | AttemptRetried | ArtifactRecorded | ReproRecorded
  | RepairCounted | GateOpened | LocksPinned | HeadAdvanced | ResourceTainted
  | NeedsHumanRaised | NeedsHumanCleared | TicketLanded | TicketAborted;

/** What decide() may emit: everything except the inbound itself. `effect.requested` is how decide states an effect. */
export type Decided = Exclude<TicketEvent, Inbound>;

// ----------------------------------------------------------------------- world stream

/** `ark env add`. */
export type EnvRegistered = Authoritative<"env.registered", { readonly env: EnvId; readonly path: string; readonly configHash: Sha256 }, "human">;
/** `ark env unblock <resource>`: a human asserts the residue is cleaned. Valid only for a currently tainted resource. */
export type ResourceCleared = Authoritative<"resource.cleared", { readonly resource: Resource; readonly by: string }, "human">;

export type WorldEvent = EnvRegistered | ResourceCleared;
export type AuthoritativeEvent = TicketEvent | WorldEvent;

/** A fact before commit: everything but `seq`, which only the ledger assigns. */
export type Draft<E> = E extends unknown ? Omit<E, "seq"> : never;

// ----------------------------------------------------------------------- observations

export interface ObservationEvent {
  /** Deterministic: `${key}:${line}`. INSERT OR IGNORE makes re-ingesting a reattached transcript idempotent. */
  readonly id: EventId;
  readonly v: 1;
  readonly seq: number;
  readonly ts: IsoTime;
  readonly stream: StreamId; //   `obs:<ticket>`: never a `ticket:<id>` stream, so it cannot disturb that stream's versioning
  readonly type: "observation";
  readonly authority: "observation";
  readonly source: "harness" | "lifecycle" | "watcher";
  readonly data: { readonly key: EffectKey; readonly signal: Signal };
}

export type StoredEvent = AuthoritativeEvent | ObservationEvent;
