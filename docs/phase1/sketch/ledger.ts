/**
 * ledger.ts — SQLite append-only event log. @layer shell.
 *
 * Owned by exactly one writer: engine.ts (it opens the ledger in Engine.start). Nothing else imports this
 * module (dependency rule in MODULES.md).
 *
 * Tables
 *   events(seq INTEGER PRIMARY KEY, id TEXT UNIQUE, ts, stream, type, authority, source, v, data JSON)
 *   meta(epoch)                                                             <- writer fencing token
 * No projection table: the read model is `state.ts#view` over the engine's fold cache, rebuilt by replay at
 * startup. (A `tickets` table would have had no reader and would be a second copy that can drift.)
 * No UPDATE or DELETE on `events` anywhere in the codebase (a trigger raises on both).
 * Streams: `ticket:<id>` (authoritative, per ticket), `world` (env registry, human resource clearing),
 * `obs:<id>` (observations; never read by a fold and never counted by a stream version).
 *
 * "No second writer" has two layers:
 *   1. PRIMARY: `serve` takes an exclusive flock on ~/.ark/ark.lock BEFORE it opens this ledger, before recovery,
 *      before binding the socket (cli.ts, flock.ts). A second `ark serve` exits at that line having touched nothing.
 *   2. BACKSTOP: openLedger() bumps meta.epoch in one transaction; every commit re-reads epoch in its own
 *      transaction and aborts if it moved. Reaching this means layer 1 was bypassed.
 *
 * Event identity: ids are minted by the engine (inbound: ULID; decided: `${inbound.id}.${i}`); the ledger assigns
 * ONLY `seq`, in the committing transaction.
 *
 * Reads decode JSON back into event types. `decodeEvent` is the ledger's one sanctioned cast to
 * RecordedArtifact (besides admit.ts): it TRUSTS the ledger, because only values admit() produced were ever
 * committed. It performs no validation; a row whose `v` is unknown throws.
 */
import type { AbsPath, StreamId } from "./ids";
import type { Draft, AuthoritativeEvent, ObservationEvent } from "./events";

export interface CommitBatch {
  readonly stream: StreamId;
  /**
   * Sanity version: the stream's last seq as the engine last saw it. Mismatch = bug and throws. Not a concurrency
   * control (there is one serial writer); a tripwire for a missed event.
   */
  readonly expectLastSeq: number;
  /** The inbound event first, then Decision.events (which include effect.requested). Order is fold order. */
  readonly events: readonly Draft<AuthoritativeEvent>[];
}

/**
 * TEST-ONLY crash injection (the Phase 1 recovery acceptance test, MODULES.md §6). The ledger SIGKILLs its own
 * process at the Nth COMMIT, either inside the transaction just before COMMIT ("before": nothing of that
 * batch is durable) or immediately after it ("after": durable, but nothing after it ran: no dispatch, no cache
 * update, no reply). N counts commits (batches), which is the unit of durability. Only the test composition root
 * passes `crash`; it is one branch on an option, not a build-time switch (TypeScript has none).
 */
export interface CrashPoint {
  readonly commit: number;
  readonly when: "before" | "after";
}

export interface Ledger {
  readonly epoch: number;

  /**
   * ONE transaction: fence check -> append events. Either every event of the batch is durable
   * (fsync'd, WAL synchronous=FULL) or none is. Returns stored events with seq, in order.
   */
  commit(batch: CommitBatch): readonly AuthoritativeEvent[];

  /** Append an observation. Idempotent on `id` (INSERT OR IGNORE). */
  observe(draft: Draft<ObservationEvent>): void;

  /** Authoritative events of one stream in seq order. Observations are excluded by construction. */
  read(stream: StreamId, afterSeq?: number): readonly AuthoritativeEvent[];
  /** Every authoritative event of every stream in global seq order: the input of foldWorld. */
  readAll(afterSeq?: number): readonly AuthoritativeEvent[];
  streams(): readonly StreamId[];

  /** Observations of one ticket, for the timeline view. */
  observations(stream: StreamId, afterSeq?: number): readonly ObservationEvent[];

  close(): void;
}

/** Opens (creating/migrating schema), takes a new epoch. Called only by Engine.start, after `serve` holds the process lock. */
export function openLedger(path: AbsPath, opts?: { readonly crash?: CrashPoint }): Ledger {
  throw new Error("not implemented");
}

export const WORLD_STREAM: StreamId = "world" as StreamId;
