/** fold: invariants asserted after every event of real logs, staleness, absorbing states. */
import test from "node:test";
import assert from "node:assert/strict";
import type { EffectKey } from "./ids.ts";
import { current, emptyState, fold, replay, revisionVector, view } from "./state.ts";
import type { TicketState } from "./state.ts";
import { A, T1, blockedRound, ev, finish, head, sim, toBuild, toReview } from "./fixtures.ts";

/** The fold invariants of state.ts, checked for one transition. */
function assertInvariants(prev: TicketState, next: TicketState, type: string): void {
  const run = next.run;
  if (!run) return;
  assert.equal(run.repairs.count, run.repairs.history.length);
  for (const [key, req] of Object.entries(run.inflight)) assert.equal(req.key, key as EffectKey);
  const hashes = Object.values(run.artifacts).map((a) => a?.hash);
  for (const r of Object.values(run.repros)) assert.ok(!hashes.includes(r.hash), "a repro never lands in run.artifacts");
  if (!prev.run) return;
  const before = Object.keys(prev.run.inflight);
  const after = Object.keys(run.inflight);
  if (type !== "effect.requested") assert.ok(after.every((k) => before.includes(k)), `${type} added an inflight key`);
  if (type !== "effect.settled") assert.ok(before.every((k) => after.includes(k)), `${type} removed an inflight key`);
  if (type !== "head.advanced") assert.equal(run.head, prev.run.head);
  if (type !== "locks.pinned") assert.deepEqual(run.locks, prev.run.locks);
  if (type !== "repair.counted") assert.equal(run.repairs.count, prev.run.repairs.count);
}

function replayChecked(log: Parameters<typeof replay>[1]): TicketState {
  let s = emptyState(T1);
  for (const e of log) { const n = fold(s, e); assertInvariants(s, n, e.type); s = n; }
  return s;
}

test("invariants hold after every event of a clean run and of a repair run", () => {
  const clean = sim();
  finish(clean);
  assert.deepEqual(replayChecked(clean.log), clean.state);

  const repaired = sim();
  toBuild(repaired);
  blockedRound(repaired, "h3");
  blockedRound(repaired, "h4");
  assert.deepEqual(replayChecked(repaired.log), repaired.state);
  assert.equal(repaired.state.run!.repairs.history.length, 2);
});

test("inflight gains a key on effect.requested and loses it on effect.settled, nothing else", () => {
  const s = sim();
  toReview(s);
  const keys = s.pending().map((r) => r.key);
  assert.equal(keys.length, 2);
  s.produce(A.findings("h2"), { slot: "fan:0" });
  assert.deepEqual(s.pending().map((r) => r.key).filter((k) => keys.includes(k)), [keys[1]]);
  const settled = s.state.run!.attempts[keys[0]!]!;
  assert.equal(settled.result, "produced");
  assert.notEqual(settled.settledAt, null);
  assert.equal(s.state.run!.attempts[keys[1]!]!.result, null);
});

test("a new head makes headBound artifacts stale, not the plan; the vector tracks the head", () => {
  const s = sim();
  toReview(s);
  const run = s.state.run!;
  assert.equal(current(run, "build")?.head, "h2");
  assert.notEqual(current(run, "plan"), null);
  const moved = fold(s.state, ev(T1, "head.advanced", { from: head("h2"), to: head("h9") }));
  assert.equal(current(moved.run!, "build"), null);
  assert.notEqual(current(moved.run!, "plan"), null);
  assert.notEqual(current(moved.run!, "acceptance"), null);
  assert.deepEqual(revisionVector(moved.run!), { env: "env0", repos: { app: "h9", lib: "lib0" } });
  assert.equal(view(moved).artifacts.build?.current, false);
  assert.equal(view(moved).artifacts.plan?.current, true);
});

test("landed and aborted are absorbing; fold rejects unknown event versions", () => {
  const s = sim();
  finish(s);
  const after = fold(s.state, ev(T1, "needs_human.raised", { reason: { kind: "inconsistent", why: "late" } }));
  assert.equal(after, s.state);
  assert.throws(() => fold(emptyState(T1), { ...ev(T1, "run.requested", { ticket: T1 }), v: 2 } as never), /unknown event version/);
});

test("view: board row for a ticket in flight", () => {
  const s = sim();
  toReview(s);
  const v = view(s.state);
  assert.equal(v.status, "running");
  assert.deepEqual(v.stage, { id: "review", visit: 1, kind: "agent" });
  assert.equal(v.attention, "none");
  assert.deepEqual(v.attempts.filter((a) => a.stage === "review").map((a) => [a.role, a.slot, a.usage]), [["reviewer", "fan:0", null], ["reviewer", "fan:1", null]]);
  assert.deepEqual(v.disclosures, ["unsandboxed"]);
  assert.deepEqual(v.repairs, { count: 0, cap: 3 });
});
