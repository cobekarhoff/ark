/**
 * The unit-1 checklist over LITERAL event lists: every prefix below is spelled out event by event (no decide call
 * builds it), replayed with `replay`, and the step under test is a single `decide` on top of it. decide.test.ts
 * drives whole runs; these pin each rule to explicit, hand-written input.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { RunId, StageId } from "./ids.ts";
import type { EffectRequest, Outcome } from "./effects.ts";
import type { AnyRecorded } from "./contracts.ts";
import type { Guard } from "./effects.ts";
import { decide, effectsOf } from "./decide.ts";
import type { Draft, TicketEvent } from "./events.ts";
import { replay } from "./state.ts";
import { emptyWorld, foldWorld } from "./world.ts";
import { A, ENV, RESOURCE, T1, T2, ev, head, keyOf, lockSet, manifestWith, pipeline, sha, sim, finish, types } from "./fixtures.ts";

const RUN = "r_run-req" as RunId;
const input = { title: "t", intent: "i", acceptanceHints: [], base: null };
const noGuard: Guard = { allowedPaths: [], locked: [], evidence: null };

const base = (h: string, ticket = T1): Draft<TicketEvent>[] => [
  ev(ticket, "ticket.created", { ticket, env: ENV, input }),
  ev(ticket, "run.requested", { ticket }, "run-req"),
  ev(ticket, "run.started", { runId: RUN, manifest: manifestWith(), pipeline, head: head(h) }),
];
const entered = (stage: string, visit: number, ticket = T1) => ev(ticket, "stage.entered", { stage: stage as StageId, visit, via: null });
const recorded = (stage: string, artifact: AnyRecorded, slot = "main", ticket = T1) => ev(ticket, "artifact.recorded", { stage: stage as StageId, slot: slot as never, artifact });
const requested = (request: EffectRequest, ticket = T1) => ev(ticket, "effect.requested", { request });
const settled = (key: EffectRequest["key"], outcome: Outcome, ticket = T1) => ev(ticket, "effect.settled", { ticket, key, outcome });
const produced = (key: EffectRequest["key"], artifact: AnyRecorded): Outcome => ({ tag: "produced", artifact, usage: null });

const attemptReq = (stage: string, visit: number, slot: string, role: string, out: AnyRecorded["kind"], o: { n?: number; baseHead?: string; feedback?: string | null; guard?: Guard; ticket?: typeof T1 } = {}): EffectRequest => ({
  key: keyOf(o.ticket ?? T1, RUN, stage, visit, slot, o.n ?? 1), ticket: o.ticket ?? T1, lease: null, timeoutMs: 600_000,
  spec: {
    kind: "attempt", role: role as never, slot: slot as never, n: o.n ?? 1, harness: "claude-code" as never, model: "model-1" as never,
    repo: "app" as never, workdir: "/work/app" as never, baseHead: head(o.baseHead ?? "h1"), skills: [], inputs: [], fanInputs: [],
    feedback: o.feedback ?? null, out, guard: o.guard ?? noGuard,
  },
});
const verifyReq = (stage: string, visit: number, repro: string | null, ticket = T1, slot = 0): EffectRequest => ({
  key: keyOf(ticket, RUN, repro ? "repro" : stage, visit), ticket, lease: { resource: RESOURCE, slot }, timeoutMs: 900_000,
  spec: {
    kind: "verify", primary: "app" as never, vector: { env: head("env0"), repos: { ["app" as never]: head("h2") } }, checks: [], locks: [],
    recipe: manifestWith().verify, n: visit, slot, project: `ark-${ENV}-s${slot}`, repro: repro ? { check: repro } : null,
  },
});

const plan = A.plan("h1");
const acceptance = A.acceptance("h1");
/** Run at stage `build` (visit 1), builder attempt in flight, plan + acceptance recorded, acceptance locked. */
const atBuild = (): { prefix: Draft<TicketEvent>[]; builder: EffectRequest } => {
  const builder = attemptReq("build", 1, "main", "builder", "build");
  return {
    builder,
    prefix: [
      ...base("h1"), recorded("intake", A.ticket("h1")), recorded("analyze", A.analysis("h1")), recorded("plan", plan), recorded("acceptance", acceptance), ev(T1, "locks.pinned", { locks: [lockSet("tests/acceptance/a.py")] }),
      entered("build", 1), requested(builder),
    ],
  };
};

test("happy path emits exactly this event sequence, one row per inbound", () => {
  const s = sim();
  finish(s);
  const rows = [
    ["ticket.created"],
    ["run.requested", "effect.requested"], // prepare
    ["effect.settled", "run.started", "stage.entered", "effect.requested"], // intake
    ["effect.settled", "artifact.recorded", "stage.entered", "effect.requested"], // analyze
    ["effect.settled", "artifact.recorded", "stage.entered", "effect.requested"], // plan
    ["effect.settled", "artifact.recorded", "stage.entered", "effect.requested"], // acceptance
    ["effect.settled", "artifact.recorded", "head.advanced", "stage.entered", "gate.opened"], // plan gate
    ["gate.decided", "locks.pinned", "stage.entered", "effect.requested"], // build
    ["effect.settled", "artifact.recorded", "head.advanced", "stage.entered", "effect.requested", "effect.requested"], // 2 reviewers
    ["effect.settled", "artifact.recorded"], // findings 0
    ["effect.settled", "artifact.recorded", "effect.requested"], // findings 1 -> lead
    ["effect.settled", "artifact.recorded", "stage.entered", "effect.requested"], // verify
    ["effect.settled", "artifact.recorded", "stage.entered", "effect.requested"], // qe
    ["effect.settled", "artifact.recorded", "stage.entered", "effect.requested"], // publish
    ["effect.settled", "artifact.recorded", "stage.entered", "effect.requested"], // ci
    ["effect.settled", "artifact.recorded", "stage.entered", "effect.requested"], // landing
    ["effect.settled", "artifact.recorded", "ticket.landed"],
  ];
  assert.deepEqual(s.log.map((e) => e.type), rows.flat());
});

test("literal: repair cap (two repairs counted, third failed round)", () => {
  const lead = attemptReq("review", 3, "join", "review-lead", "review", { baseHead: "h7" });
  const state = replay(T1, [
    ...base("h7"),
    ev(T1, "repair.counted", { n: 1, cap: 3, reason: "review_blockers", trigger: A.review("h5", ["f1"]) }),
    ev(T1, "repair.counted", { n: 2, cap: 3, reason: "qe_defect", trigger: A.qe("h6", "defect") }),
    entered("review", 3), requested(lead),
  ]);
  const d = decide(state, settled(lead.key, produced(lead.key, A.review("h7", ["f1"]))), emptyWorld());
  assert.deepEqual(types(d), ["artifact.recorded", "repair.counted", "needs_human.raised"]);
  assert.deepEqual(effectsOf(d), []);
});

test("literal: rejected attempt retries with feedback, no repair counted", () => {
  const { prefix, builder } = atBuild();
  const d = decide(replay(T1, prefix), settled(builder.key, { tag: "rejected", reason: { class: "locked_root_added", details: ["tests/acceptance/new.py"] }, usage: null }), emptyWorld());
  assert.deepEqual(types(d), ["attempt.retried", "effect.requested"]);
  const retry = effectsOf(d)[0]!.spec;
  assert.equal(retry.kind === "attempt" && retry.n, 2);
  assert.equal(retry.kind === "attempt" && retry.baseHead, "h1");
  assert.match(retry.kind === "attempt" ? retry.feedback ?? "" : "", /locked_root_added: tests\/acceptance\/new\.py/);
  const exhausted = replay(T1, [...prefix, ev(T1, "attempt.retried", { stage: "build" as never, slot: "main" as never, n: 2, why: "x" }), ev(T1, "attempt.retried", { stage: "build" as never, slot: "main" as never, n: 3, why: "y" })]);
  const last = decide(exhausted, settled(builder.key, { tag: "crashed", detail: "boom", usage: null }), emptyWorld());
  assert.deepEqual(types(last), ["needs_human.raised"]);
});

test("literal: build produced chains head advance, review entry, reviewers on the advanced head", () => {
  const { prefix, builder } = atBuild();
  const d = decide(replay(T1, prefix), settled(builder.key, produced(builder.key, A.build("h2"))), emptyWorld());
  assert.deepEqual(types(d), ["artifact.recorded", "head.advanced", "stage.entered", "effect.requested", "effect.requested"]);
  assert.deepEqual(effectsOf(d).map((r) => r.spec.kind === "attempt" && [r.spec.slot, r.spec.baseHead]), [["fan:0", "h2"], ["fan:1", "h2"]]);
});

test("literal: the join sees every reviewer's findings, in slot order", () => {
  const f0 = A.findings("h2", ["f0"]);
  const f1 = A.findings("h2", ["f1"]);
  const r0 = attemptReq("review", 1, "fan:0", "reviewer", "review_findings", { baseHead: "h2" });
  const r1 = attemptReq("review", 1, "fan:1", "reviewer", "review_findings", { baseHead: "h2" });
  const state = replay(T1, [
    ...base("h2"), recorded("build", A.build("h2")), recorded("plan", plan), recorded("acceptance", acceptance),
    entered("review", 1), requested(r0), requested(r1), recorded("review", f1, "fan:1"), // fan:1 already done
    ev(T1, "effect.settled", { ticket: T1, key: r1.key, outcome: produced(r1.key, f1) }),
  ]);
  const d = decide(state, settled(r0.key, produced(r0.key, f0)), emptyWorld());
  assert.deepEqual(types(d), ["artifact.recorded", "effect.requested"]);
  const join = effectsOf(d)[0]!.spec;
  assert.deepEqual(join.kind === "attempt" && join.fanInputs.map((a) => a.hash), [f0.hash, f1.hash]);
});

test("literal: pin echo mismatch is refused, the exact echo approves", () => {
  const pins = { plan: plan.hash, acceptance: acceptance.hash };
  const state = replay(T1, [
    ...base("h1"), recorded("plan", plan), recorded("acceptance", acceptance),
    entered("plan_gate", 1), ev(T1, "gate.opened", { gate: "plan_gate#1" as never, stage: "plan_gate" as never, pins }),
  ]);
  const decided = (p: object, gate = "plan_gate#1") =>
    ev(T1, "gate.decided", { ticket: T1, gate: gate as never, decision: "approve", pins: p as never, decider: "e", comment: "" });
  assert.equal(decide(state, decided({ plan: plan.hash, acceptance: sha("stale") }), emptyWorld()).refusal?.code, "pins_mismatch");
  assert.equal(decide(state, decided(pins, "plan_gate#2"), emptyWorld()).refusal?.code, "no_open_gate");
  const ok = decide(state, decided(pins), emptyWorld());
  assert.deepEqual(types(ok), ["locks.pinned", "stage.entered", "effect.requested"]);
});

test("literal: taint is emitted before the status gate (ticket already needs_human)", () => {
  const v = verifyReq("verify", 1, null);
  const prefix = [
    ...base("h2"), recorded("acceptance", acceptance), entered("verify", 1), requested(v),
    ev(T1, "needs_human.raised", { reason: { kind: "inconsistent", why: "x" } }),
  ];
  const world = prefix.reduce(foldWorld, emptyWorld());
  const d = decide(replay(T1, prefix), settled(v.key, { ...produced(v.key, A.verification("h2")), taint: { resource: RESOURCE, reason: "down failed" } }), world);
  assert.deepEqual(types(d), ["resource.tainted"]);
});

test("literal: repro recorded while needs_human", () => {
  const prefix = [
    ...base("h5"), recorded("acceptance", acceptance),
    ev(T1, "needs_human.raised", { reason: { kind: "repair_cap", count: 3, cap: 3 } }),
  ];
  const state = replay(T1, prefix);
  const world = prefix.reduce(foldWorld, emptyWorld());
  const ask = decide(state, ev(T1, "verify.requested", { ticket: T1, check: "acc-1" }), world);
  assert.deepEqual(types(ask), ["effect.requested"]);

  const repro = verifyReq("verify", 1, "acc-1");
  const running = [...prefix, ev(T1, "effect.requested", { request: repro })];
  const d = decide(replay(T1, running), settled(repro.key, produced(repro.key, A.verification("h5", "fail", ["acc-1"]))), running.reduce(foldWorld, emptyWorld()));
  assert.deepEqual(types(d), ["repro.recorded"]);
});

test("literal: material_change goes to plan and the new approval replaces the locks", () => {
  const { prefix, builder } = atBuild();
  const d = decide(replay(T1, prefix), settled(builder.key, produced(builder.key, A.build("h1", "material_change"))), emptyWorld());
  assert.deepEqual(types(d), ["artifact.recorded", "stage.entered", "effect.requested"]);
  const next = effectsOf(d)[0]!.spec;
  assert.equal(next.kind === "attempt" && next.role, "planner");

  // second approval at plan_gate#2 replaces the old lock
  const newAcc = A.acceptance("h3", "tests/acceptance/b.py");
  const gate = [
    ...prefix, recorded("build", A.build("h1", "material_change")), recorded("plan", A.plan("h1", ["lib/**"])), recorded("acceptance", newAcc),
    entered("plan_gate", 2), ev(T1, "gate.opened", { gate: "plan_gate#2" as never, stage: "plan_gate" as never, pins: { plan: A.plan("h1").hash, acceptance: newAcc.hash } }),
  ];
  const state = replay(T1, gate);
  assert.deepEqual(state.run!.locks, [lockSet("tests/acceptance/a.py")]);
  const g = state.run!.gate!;
  const ok = decide(state, ev(T1, "gate.decided", { ticket: T1, gate: g.gate, decision: "approve", pins: g.pins, decider: "e", comment: "" }), emptyWorld());
  const pinned = ok.events[0]!;
  assert.deepEqual(pinned.type === "locks.pinned" && pinned.data.locks, [lockSet("tests/acceptance/b.py")]);
});

test("literal: prepare failed, resume re-requests prepare", () => {
  const prep = {
    key: keyOf(T1, RUN, "prepare", 1), ticket: T1, lease: null, timeoutMs: 1,
    spec: { kind: "run.prepare" as const, env: ENV, runId: RUN, ticketInput: input },
  };
  const prefix = [
    ev(T1, "ticket.created", { ticket: T1, env: ENV, input }), ev(T1, "run.requested", { ticket: T1 }, "run-req"), requested(prep),
    ev(T1, "effect.settled", { ticket: T1, key: prep.key, outcome: { tag: "crashed", detail: "no worktree", usage: null } }),
    ev(T1, "needs_human.raised", { reason: { kind: "prepare_failed", why: "crashed: no worktree" } }),
  ];
  const d = decide(replay(T1, prefix), ev(T1, "human.resolved", { ticket: T1, choice: { kind: "resume", to: null, raiseCapBy: 0 } }), emptyWorld());
  assert.deepEqual(types(d), ["needs_human.cleared", "effect.requested"]);
  const again = effectsOf(d)[0]!;
  assert.equal(again.key, keyOf(T1, RUN, "prepare", 1, "main", 2));
});

test("literal: second ticket waits while the first holds the only slot, then is woken", () => {
  const holder = verifyReq("verify", 1, null, T1);
  const w1 = [...base("h2"), recorded("acceptance", acceptance), entered("verify", 1), requested(holder)];
  const world = w1.reduce(foldWorld, emptyWorld());

  const lead = attemptReq("review", 1, "join", "review-lead", "review", { baseHead: "h2", ticket: T2 });
  const t2 = [...base("h2", T2), recorded("acceptance", acceptance, "main", T2), recorded("build", A.build("h2"), "main", T2), entered("review", 1, T2), requested(lead, T2)];
  const d = decide(replay(T2, t2), settled(lead.key, produced(lead.key, A.review("h2")), T2), world);
  assert.deepEqual(types(d), ["artifact.recorded", "stage.entered", "stage.waiting"]);
  assert.deepEqual(effectsOf(d), []);

  const waiting = replay(T2, [...t2, ...d.events]);
  const wake = ev(T2, "resource.released", { ticket: T2, resource: RESOURCE });
  assert.deepEqual(decide(waiting, wake, world).events, []); // still held
  const freed = foldWorld(world, ev(T1, "effect.settled", { ticket: T1, key: holder.key, outcome: { tag: "cancelled" } }));
  assert.deepEqual(types(decide(waiting, wake, freed)), ["effect.requested"]);
});
