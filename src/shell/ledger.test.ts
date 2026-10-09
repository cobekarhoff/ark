/** ledger: real SQLite files, a real second connection, real child processes that kill themselves. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import type { AbsPath, EventId, IsoTime, StreamId } from "../core/ids.ts";
import type { AuthoritativeEvent, Draft, ObservationEvent } from "../core/events.ts";
import { emptyState, fold, replay } from "../core/state.ts";
import { emptyWorld, foldWorld } from "../core/world.ts";
import { ENV, T1, ev, finish, registerEnv, sha, sim } from "../core/fixtures.ts";
import { WORLD_STREAM, openLedger } from "./ledger.ts";
import type { Ledger } from "./ledger.ts";

const stream = `ticket:${T1}` as StreamId;

/** A fresh temp dir per test, removed afterwards. */
function withDir(fn: (dir: string, db: AbsPath) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "ark-ledger-"));
    try { await fn(dir, join(dir, "ledger.sqlite") as AbsPath); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}

const draft = (id: string, s: StreamId = stream): Draft<AuthoritativeEvent> =>
  ({ id, v: 1, ts: "2026-01-01T00:00:00Z", stream: s, type: "run.requested", authority: "authoritative", source: "human", data: { ticket: T1 } }) as unknown as Draft<AuthoritativeEvent>;

const obs = (id: string, line: number): Draft<ObservationEvent> => ({
  id: id as EventId, v: 1, ts: "2026-01-01T00:00:00Z" as IsoTime, stream: `obs:${T1}` as StreamId, type: "observation",
  authority: "observation", source: "harness", data: { key: "k" as never, signal: { kind: "progress", line } as never },
});

const lastSeq = (l: Ledger, s: StreamId = stream) => l.read(s).at(-1)?.seq ?? 0;

test("a batch commits atomically; the ledger assigns only seq", withDir((_, db) => {
  const l = openLedger(db);
  const a = l.commit({ stream, expectLastSeq: 0, events: [draft("a"), draft("b"), draft("c")] });
  assert.deepEqual(a.map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(a.map((e) => e.id), ["a", "b", "c"]);
  assert.deepEqual(l.read(stream), a, "commit returns exactly what read returns");
  assert.equal(l.commit({ stream, expectLastSeq: 3, events: [] }).length, 0);

  // a batch that fails midway (duplicate id) leaves none of its events behind
  assert.throws(() => l.commit({ stream, expectLastSeq: 3, events: [draft("d"), draft("e"), draft("a")] }), /UNIQUE/);
  assert.deepEqual(l.read(stream).map((e) => e.id), ["a", "b", "c"]);
  const next = l.commit({ stream, expectLastSeq: 3, events: [draft("f")] });
  assert.equal(next[0]!.seq, 4, "a rolled-back batch consumes no seq");
  l.close();
}));

test("expectLastSeq is a tripwire: mismatch throws and writes nothing", withDir((_, db) => {
  const l = openLedger(db);
  l.commit({ stream, expectLastSeq: 0, events: [draft("a")] });
  assert.throws(() => l.commit({ stream, expectLastSeq: 0, events: [draft("b")] }), /expected 0/);
  assert.deepEqual(l.read(stream).map((e) => e.id), ["a"]);
  l.close();
}));

test("a batch for one stream refuses events of another stream or an observation", withDir((_, db) => {
  const l = openLedger(db);
  assert.throws(() => l.commit({ stream, expectLastSeq: 0, events: [draft("a", WORLD_STREAM)] }), /does not belong/);
  assert.throws(() => l.commit({ stream: `obs:${T1}` as StreamId, expectLastSeq: 0, events: [] }), /observation stream/);
  assert.deepEqual(l.readAll(), []);
  l.close();
}));

test("epoch fence: a second opener bumps the epoch and the first opener's next commit is rejected", withDir((_, db) => {
  const first = openLedger(db);
  first.commit({ stream, expectLastSeq: 0, events: [draft("a")] });
  const second = openLedger(db);
  assert.equal(second.epoch, first.epoch + 1);

  assert.throws(() => first.commit({ stream, expectLastSeq: 1, events: [draft("zombie")] }), /fenced out/);
  assert.deepEqual(second.read(stream).map((e) => e.id), ["a"], "the fenced commit left nothing durable");
  second.commit({ stream, expectLastSeq: 1, events: [draft("b")] });
  assert.throws(() => first.commit({ stream, expectLastSeq: 2, events: [draft("zombie")] }), /fenced out/); // stays fenced
  first.close();
  second.close();

  const third = openLedger(db);
  assert.equal(third.epoch, second.epoch + 1, "the epoch is durable across opens");
  third.close();
}));

test("UPDATE and DELETE on events are refused by triggers, even from a raw connection", withDir((_, db) => {
  const l = openLedger(db);
  l.commit({ stream, expectLastSeq: 0, events: [draft("a")] });
  l.observe(obs("o1", 1));
  const raw = new DatabaseSync(db);
  for (const sql of ["UPDATE events SET type = 'x'", "UPDATE events SET data = '{}' WHERE seq = 1", "DELETE FROM events", "DELETE FROM events WHERE id = 'o1'"]) {
    assert.throws(() => raw.exec(sql), /append-only/);
  }
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM events").get()!.n, 2);
  raw.close();
  l.close();
}));

test("observations dedupe on id, live in obs: streams, and never touch authoritative versioning", withDir((_, db) => {
  const l = openLedger(db);
  const o = `obs:${T1}` as StreamId;
  l.commit({ stream, expectLastSeq: 0, events: [draft("a")] });
  l.observe(obs("k:1", 1));
  l.observe(obs("k:1", 99)); // re-ingest of the same transcript line: ignored, first write wins
  l.observe(obs("k:2", 2));
  l.commit({ stream, expectLastSeq: 1, events: [draft("b")] }); // an observation seq between a and b does not move the stream version
  l.observe(obs("k:1", 1));

  const seen = l.observations(o);
  assert.deepEqual(seen.map((e) => e.id), ["k:1", "k:2"]);
  assert.deepEqual(seen[0]!.data.signal, { kind: "progress", line: 1 }, "first write wins");
  assert.deepEqual(l.observations(o, seen[0]!.seq).map((e) => e.id), ["k:2"]);
  assert.deepEqual(l.read(stream).map((e) => e.id), ["a", "b"]);
  assert.deepEqual(l.readAll().map((e) => e.id), ["a", "b"], "observations are excluded from every authoritative read");
  assert.deepEqual(l.streams(), [stream]);
  assert.throws(() => l.observe({ ...obs("x", 0), stream } as Draft<ObservationEvent>), /not an observation/);
  // expectLastSeq is the stream's last authoritative seq (b = 4), not the global max: a fresh observation takes seq 5 first
  l.observe(obs("k:3", 3));
  assert.throws(() => l.commit({ stream, expectLastSeq: 2, events: [draft("c")] }), /last seq is 4/);
  assert.throws(() => l.commit({ stream, expectLastSeq: 5, events: [draft("c")] }), /last seq is 4/);
  assert.equal(l.commit({ stream, expectLastSeq: 4, events: [draft("c")] })[0]!.seq, 6);
  l.close();
}));

test("streams lists authoritative streams in order of first event; read pages by afterSeq", withDir((_, db) => {
  const l = openLedger(db);
  l.commit({ stream: WORLD_STREAM, expectLastSeq: 0, events: [draft("w1", WORLD_STREAM)] });
  l.commit({ stream, expectLastSeq: 0, events: [draft("a"), draft("b")] });
  assert.deepEqual(l.streams(), [WORLD_STREAM, stream]);
  assert.deepEqual(l.read(stream, 2).map((e) => e.id), ["b"]);
  assert.deepEqual(l.readAll(1).map((e) => e.id), ["a", "b"]);
  l.close();
}));

test("a row with an unknown schema version throws on read", withDir((_, db) => {
  const l = openLedger(db);
  const raw = new DatabaseSync(db);
  raw.exec(`INSERT INTO events(id, ts, stream, type, authority, source, v, data) VALUES ('x', 't', '${stream}', 'run.requested', 'authoritative', 'human', 2, '{}')`);
  raw.close();
  assert.throws(() => l.read(stream), /unknown schema version 2/);
  l.close();
}));

test("full refold of every stream via core replay equals the incremental fold", withDir((_, db) => {
  const s = sim();
  registerEnv(s);
  finish(s);
  const l = openLedger(db);
  l.commit({
    stream: WORLD_STREAM, expectLastSeq: 0,
    events: [{ id: "w1", v: 1, ts: "2026-01-01T00:00:00Z", stream: WORLD_STREAM, type: "env.registered", authority: "authoritative", source: "human", data: { env: ENV, path: "/envs/app", configHash: sha("env") } } as unknown as Draft<AuthoritativeEvent>],
  });

  // Commit the run in uneven batches, folding what each commit returns (what the engine's cache does).
  let cache = emptyState(T1);
  let last = 0;
  for (let i = 0; i < s.log.length;) {
    const size = 1 + (i % 4);
    const stored = l.commit({ stream, expectLastSeq: last, events: s.log.slice(i, i + size) });
    for (const e of stored) cache = fold(cache, e as Draft<(typeof s.log)[number]>);
    last = stored.at(-1)!.seq;
    i += size;
  }

  const refold = replay(T1, l.read(stream) as unknown as Iterable<(typeof s.log)[number]>);
  assert.equal(cache.status, "landed");
  assert.deepEqual(refold, cache);
  assert.deepEqual(refold, s.state, "and equals the fold of the never-persisted drafts");
  assert.equal(l.read(stream).length, s.log.length);

  // the same through a fresh opener: durable, not cached in the connection
  l.close();
  const reopened = openLedger(db);
  assert.deepEqual(replay(T1, reopened.read(stream) as unknown as Iterable<(typeof s.log)[number]>), cache);
  const world = reopened.readAll().reduce(foldWorld, emptyWorld());
  assert.deepEqual(world, s.world);
  reopened.close();
}));

// ----------------------------------------------------------------------- crash injection: a real child process kills itself

const child = join(import.meta.dirname, "ledger.crash-child.ts");

/** Child commits `commits` two-event batches, dying at the crash point. `returned` = commits that came back to the caller. */
function runChild(dir: string, db: string, crashCommit: number, when: "before" | "after", commits: number) {
  const markers = join(dir, "markers");
  mkdirSync(markers, { recursive: true });
  const r = spawnSync(process.execPath, [child, db, markers, String(crashCommit), when, String(commits)], { encoding: "utf8" });
  return { status: r.status, signal: r.signal, stderr: r.stderr, returned: readdirSync(markers).sort() };
}

test("control: with no crash point reached the child commits everything and exits 0", withDir((dir, db) => {
  const r = runChild(dir, db, 99, "before", 3);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.returned, ["1", "2", "3"]);
  const l = openLedger(db);
  assert.equal(l.read(stream).length, 6);
  l.close();
}));

for (const [n, when, durable] of [[1, "before", 0], [1, "after", 1], [2, "before", 1], [2, "after", 2], [3, "before", 2], [3, "after", 3]] as const) {
  test(`crash ${when} commit ${n}: SIGKILL leaves exactly the durable prefix`, withDir((dir, db) => {
    const r = runChild(dir, db, n, when, 3);
    assert.equal(r.signal, "SIGKILL", `child must die by its own SIGKILL (status ${r.status}): ${r.stderr}`);
    // Nothing after the crashed commit ran, in either mode: the crashed commit never returned to its caller.
    assert.deepEqual(r.returned, ["1", "2", "3"].slice(0, n - 1));

    const l = openLedger(db);
    assert.equal(l.epoch, 2, "the killed opener held epoch 1");
    const ids = l.read(stream).map((e) => e.id);
    assert.deepEqual(ids, ["c1.a", "c1.b", "c2.a", "c2.b", "c3.a", "c3.b"].slice(0, durable * 2), "whole batches only, never half of one");
    assert.deepEqual(l.read(stream).map((e) => e.seq), ids.map((_, i) => i + 1), "no seq gap");
    // the survivor's ledger is fully usable: the next commit continues the prefix
    const next = l.commit({ stream, expectLastSeq: ids.length, events: [draft("after-restart")] });
    assert.equal(next[0]!.seq, ids.length + 1);
    l.close();
  }));
}
