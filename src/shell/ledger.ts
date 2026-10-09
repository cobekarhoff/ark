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
 * Reads decode JSON back into event types. `decodeEvent` is the ledger's one sanctioned cast: it TRUSTS the
 * ledger, because only values admit() produced were ever committed. It performs no validation; a row whose `v`
 * is unknown throws.
 */
import { DatabaseSync } from "node:sqlite";
import process from "node:process";
import type { AbsPath, StreamId } from "../core/ids.ts";
import type { Draft, AuthoritativeEvent, ObservationEvent } from "../core/events.ts";

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
 * update, no reply). N counts commits (batches) made through this opener, from 1: the unit of durability. Only the test
 * composition root passes `crash`; it is one branch on an option, not a build-time switch (TypeScript has none).
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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events(
  seq       INTEGER PRIMARY KEY,
  id        TEXT NOT NULL UNIQUE,
  ts        TEXT NOT NULL,
  stream    TEXT NOT NULL,
  type      TEXT NOT NULL,
  authority TEXT NOT NULL CHECK (authority IN ('authoritative', 'observation')),
  source    TEXT NOT NULL,
  v         INTEGER NOT NULL,
  data      TEXT NOT NULL CHECK (json_valid(data))
);
CREATE INDEX IF NOT EXISTS events_stream ON events(stream, seq);
CREATE TABLE IF NOT EXISTS meta(id INTEGER PRIMARY KEY CHECK (id = 1), epoch INTEGER NOT NULL);
INSERT OR IGNORE INTO meta(id, epoch) VALUES (1, 0);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events is append-only: UPDATE refused'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events is append-only: DELETE refused'); END;
`;

const COLS = "seq, id, ts, stream, type, authority, source, v, data";
const INSERT = "INSERT INTO events(id, ts, stream, type, authority, source, v, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";

/** The one sanctioned cast (see header): trusts the ledger, validates nothing, rejects unknown schema versions. */
function decodeEvent<E>(row: Record<string, unknown>): E {
  if (row.v !== 1) throw new Error(`ledger: event ${String(row.id)} has unknown schema version ${String(row.v)}`);
  return {
    id: row.id, v: row.v, seq: row.seq, ts: row.ts, stream: row.stream, type: row.type,
    authority: row.authority, source: row.source, data: JSON.parse(row.data as string),
  } as E;
}

/** Opens (creating/migrating schema), takes a new epoch. Called only by Engine.start, after `serve` holds the process lock. */
export function openLedger(path: AbsPath, opts?: { readonly crash?: CrashPoint }): Ledger {
  const db = new DatabaseSync(path);
  const crash = opts?.crash;
  let commits = 0;

  /** Run `fn` in one IMMEDIATE transaction (write lock taken up front, so the epoch read cannot go stale inside it). */
  function tx<T>(fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  const epochNow = () => db.prepare("SELECT epoch FROM meta WHERE id = 1").get()!.epoch as number;

  let epoch: number;
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
    db.exec(SCHEMA);
    epoch = tx(() => {
      db.prepare("UPDATE meta SET epoch = epoch + 1 WHERE id = 1").run();
      return epochNow();
    });
  } catch (e) {
    db.close();
    throw e;
  }

  const select = (where: string, ...params: (string | number)[]) =>
    db.prepare(`SELECT ${COLS} FROM events WHERE ${where} ORDER BY seq`).all(...params).map((r) => decodeEvent<AuthoritativeEvent>(r));

  return {
    epoch,

    commit(batch) {
      if (batch.stream.startsWith("obs:")) throw new Error(`ledger: commit to observation stream ${batch.stream}`);
      for (const e of batch.events) {
        if (e.stream !== batch.stream || e.authority !== "authoritative") {
          throw new Error(`ledger: event ${e.id} (${e.stream}, ${e.authority}) does not belong in batch for ${batch.stream}`);
        }
      }
      const n = ++commits;
      const stored = tx(() => {
        const now = epochNow();
        if (now !== epoch) throw new Error(`ledger: fenced out: epoch moved ${epoch} -> ${now}; another writer opened this ledger`);
        const last = db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE stream = ? AND authority = 'authoritative'")
          .get(batch.stream)!.s as number;
        if (last !== batch.expectLastSeq) {
          throw new Error(`ledger: ${batch.stream} last seq is ${last}, caller expected ${batch.expectLastSeq}`);
        }
        const insert = db.prepare(INSERT);
        let first = 0;
        for (const e of batch.events) {
          const seq = Number(insert.run(e.id, e.ts, e.stream, e.type, e.authority, e.source, e.v, JSON.stringify(e.data)).lastInsertRowid);
          first ||= seq;
        }
        if (crash?.commit === n && crash.when === "before") process.kill(process.pid, "SIGKILL");
        // Read back inside the transaction, so the caller gets exactly what `read` will later return.
        // The batch is contiguous: one writer holds the write lock.
        return first === 0 ? [] : select("seq >= ?", first);
      });
      if (crash?.commit === n && crash.when === "after") process.kill(process.pid, "SIGKILL");
      return stored;
    },

    observe(d) {
      if (!d.stream.startsWith("obs:") || d.authority !== "observation") {
        throw new Error(`ledger: ${d.id} (${d.stream}, ${d.authority}) is not an observation`);
      }
      // Not epoch-fenced (sketch): idempotent telemetry that no fold reads. ponytail: fence it if a stale writer's observations ever matter.
      db.prepare(INSERT.replace("INSERT", "INSERT OR IGNORE"))
        .run(d.id, d.ts, d.stream, d.type, d.authority, d.source, d.v, JSON.stringify(d.data));
    },

    read: (stream, afterSeq = 0) => select("stream = ? AND authority = 'authoritative' AND seq > ?", stream, afterSeq),
    readAll: (afterSeq = 0) => select("authority = 'authoritative' AND seq > ?", afterSeq),
    streams: () =>
      db.prepare("SELECT stream FROM events WHERE authority = 'authoritative' GROUP BY stream ORDER BY MIN(seq)").all()
        .map((r) => r.stream as StreamId),
    observations: (stream, afterSeq = 0) =>
      db.prepare(`SELECT ${COLS} FROM events WHERE stream = ? AND authority = 'observation' AND seq > ? ORDER BY seq`)
        .all(stream, afterSeq).map((r) => decodeEvent<ObservationEvent>(r)),

    close: () => db.close(),
  };
}

export const WORLD_STREAM: StreamId = "world" as StreamId;
