/**
 * Replay tests for decide(): literal inputs and event lists, observable outputs only (event types and key
 * fields, effect kinds, refusal reasons). No database, clock, or process.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { EffectKey, RunId } from "./ids.ts";
import type { AttemptSpec, EffectRequest } from "./effects.ts";
import { decide, effectsOf } from "./decide.ts";
import { replay, view } from "./state.ts";
import { acquire } from "./world.ts";
import { emptyWorld } from "./world.ts";
import {
  A, ENV, RESOURCE, T1, T2, blockedRound, ev, finish, head, keyOf, lockSet, manifestWith, pipeline, registerEnv, sha, sharedWorld,
  sim, toBuild, toGate, toReview, toVerify, types,
} from "./fixtures.ts";

const attempt = (r: EffectRequest): AttemptSpec => {
  assert.equal(r.spec.kind, "attempt");
  return r.spec as AttemptSpec;
};

test("happy path: default pipeline, ticket.created to landed", () => {
  const s = sim();
  registerEnv(s);
  const input = { title: "t", intent: "i", acceptanceHints: [], base: null };

  let d = s.send("ticket.created", { ticket: T1, env: ENV, input });
  assert.deepEqual(types(d), []);

  d = s.send("run.requested", { ticket: T1 });
  assert.deepEqual(types(d), ["effect.requested"]);
  assert.equal(effectsOf(d)[0]!.spec.kind, "run.prepare");
  assert.equal(s.state.status, "preparing");

  d = s.settle(s.pending()[0]!.key, { tag: "prepared", manifest: s.manifest, pipeline, head: head("h0") });
  assert.deepEqual(types(d), ["run.started", "stage.entered", "effect.requested"]);
  assert.equal(attempt(effectsOf(d)[0]!).role, "intake");
  assert.equal(s.state.status, "running");

  d = s.produce(A.ticket("h0"));
  assert.deepEqual(types(d), ["artifact.recorded", "stage.entered", "effect.requested"]);
  assert.equal(attempt(effectsOf(d)[0]!).role, "analyst");
  d = s.produce(A.analysis("h0"));
  assert.equal(attempt(effectsOf(d)[0]!).role, "planner");
  d = s.produce(A.plan("h0"));
  const author = attempt(effectsOf(d)[0]!);
  assert.equal(author.role, "acceptance-author");
  assert.deepEqual(author.guard.allowedPaths, ["tests/acceptance/**"]);
  assert.deepEqual(author.guard.locked, []);

  // the acceptance author commits: head moves, the plan gate opens, nobody executes it
  d = s.produce(A.acceptance("h1"));
  assert.deepEqual(types(d), ["artifact.recorded", "head.advanced", "stage.entered", "gate.opened"]);
  assert.deepEqual(effectsOf(d), []);
  assert.equal(view(s.state).attention, "gate");
  assert.deepEqual(Object.keys(s.state.run!.gate!.pins).sort(), ["acceptance", "plan"]);

  d = s.approve();
  assert.deepEqual(types(d), ["locks.pinned", "stage.entered", "effect.requested"]);
  const builder = attempt(effectsOf(d)[0]!);
  assert.equal(builder.role, "builder");
  assert.deepEqual(builder.guard.allowedPaths, ["src/**"]);
  assert.deepEqual(builder.guard.locked, [lockSet("tests/acceptance/a.py")]);
  assert.equal(builder.baseHead, "h1");

  d = s.produce(A.build("h2"));
  assert.deepEqual(types(d), ["artifact.recorded", "head.advanced", "stage.entered", "effect.requested", "effect.requested"]);
  d = s.produce(A.findings("h2", ["f1"]), { slot: "fan:0" });
  assert.deepEqual(types(d), ["artifact.recorded"]);
  d = s.produce(A.findings("h2"), { slot: "fan:1" });
  assert.deepEqual(types(d), ["artifact.recorded", "effect.requested"]);
  assert.equal(attempt(effectsOf(d)[0]!).role, "review-lead");

  d = s.produce(A.review("h2"));
  assert.deepEqual(types(d), ["artifact.recorded", "stage.entered", "effect.requested"]);
  const verify = effectsOf(d)[0]!;
  assert.equal(verify.spec.kind, "verify");
  assert.deepEqual(verify.lease, { resource: RESOURCE, slot: 0 });
  if (verify.spec.kind !== "verify") throw new Error("unreachable");
  assert.equal(verify.spec.project, "ark-app-env-s0");
  assert.deepEqual(verify.spec.vector, { env: "env0", repos: { app: "h2", lib: "lib0" } });
  assert.deepEqual(verify.spec.checks.map((c) => c.id), ["acc-1"]);
  assert.deepEqual(verify.spec.locks, [lockSet("tests/acceptance/a.py")]);
  assert.equal(verify.spec.repro, null);
  assert.deepEqual(view(s.state).leases.map((l) => l.slot), [0]);

  d = s.produce(A.verification("h2"));
  assert.deepEqual(types(d), ["artifact.recorded", "stage.entered", "effect.requested"]);
  const qe = attempt(effectsOf(d)[0]!);
  assert.equal(qe.role, "qe");
  assert.deepEqual(qe.guard.evidence, { dir: "evidence/1", sumsDigest: sha("sums") });
  assert.deepEqual(qe.guard.allowedPaths, []);
  assert.deepEqual(s.world.leases[RESOURCE], {});

  d = s.produce(A.qe("h2"));
  assert.deepEqual(types(d), ["artifact.recorded", "stage.entered", "effect.requested"]);
  const publish = effectsOf(d)[0]!.spec;
  assert.equal(publish.kind, "publish");
  if (publish.kind === "publish") assert.equal(publish.head, "h2");

  d = s.produce(A.mr("h2"));
  assert.deepEqual(types(d), ["artifact.recorded", "stage.entered", "effect.requested"]);
  const ci = effectsOf(d)[0]!;
  assert.equal(ci.spec.kind, "forge.wait");
  assert.equal(ci.timeoutMs, null);

  d = s.produce(A.ci("h2"));
  assert.deepEqual(types(d), ["artifact.recorded", "stage.entered", "effect.requested"]);
  d = s.produce(A.landing("h2"));
  assert.deepEqual(types(d), ["artifact.recorded", "ticket.landed"]);
  assert.equal(s.state.status, "landed");
  assert.deepEqual(s.pending(), []);
  assert.deepEqual(s.state, replay(T1, s.log));
});

test("repair cap over a literal event list: the third failed round escalates and requests nothing", () => {
  const runId = "r_run-req" as RunId;
  const lead = keyOf(T1, runId, "review", 3, "join");
  const leadRequest: EffectRequest = {
    key: lead, ticket: T1, lease: null, timeoutMs: 600_000,
    spec: {
      kind: "attempt", role: "review-lead" as never, slot: "join" as never, n: 1, harness: "claude-code" as never, model: "model-1" as never,
      repo: "app" as never, workdir: "/work/app" as never, baseHead: head("h7"), skills: [], inputs: [], fanInputs: [],
      feedback: null, out: "review", guard: { allowedPaths: [], locked: [], evidence: null },
    },
  };
  const atTwoRepairs = replay(T1, [
    ev(T1, "ticket.created", { ticket: T1, env: ENV, input: { title: "t", intent: "i", acceptanceHints: [], base: null } }),
    ev(T1, "run.requested", { ticket: T1 }, "run-req"),
    ev(T1, "run.started", { runId, manifest: manifestWith(), pipeline, head: head("h7") }),
    ev(T1, "repair.counted", { n: 1, cap: 3, reason: "review_blockers", trigger: A.review("h5", ["f1"]) }),
    ev(T1, "repair.counted", { n: 2, cap: 3, reason: "qe_defect", trigger: A.qe("h6", "defect") }),
    ev(T1, "stage.entered", { stage: "review" as never, visit: 3, via: { from: "build" as never, outcome: "done" } }),
    ev(T1, "effect.requested", { request: leadRequest }),
  ]);
  assert.equal(atTwoRepairs.run!.repairs.count, 2);

  const blockers = A.review("h7", ["f1"]);
  const d = decide(atTwoRepairs, ev(T1, "effect.settled", { ticket: T1, key: lead, outcome: { tag: "produced", artifact: blockers, usage: null } }), emptyWorld());
  assert.deepEqual(d.events.map((e) => e.type), ["artifact.recorded", "repair.counted", "needs_human.raised"]);
  assert.deepEqual(effectsOf(d), []);
  const raised = d.events[2]!;
  assert.deepEqual(raised.type === "needs_human.raised" && raised.data.reason, { kind: "repair_cap", count: 3, cap: 3 });
  const counted = d.events[1]!;
  assert.equal(counted.type === "repair.counted" && counted.data.reason, "review_blockers");
  assert.deepEqual(d.cancel, []);
});

test("repair loop through the pipeline: each failure re-requests build with the trigger; the cap stops the third", () => {
  const s = sim();
  toBuild(s);

  let d = blockedRound(s, "h3");
  assert.deepEqual(types(d), ["artifact.recorded", "repair.counted", "stage.entered", "effect.requested"]);
  let b = attempt(effectsOf(d)[0]!);
  assert.equal(b.role, "builder");
  assert.equal(b.baseHead, "h3"); // the next build starts from the head the failed build advanced
  assert.deepEqual(b.inputs.map((i) => i.kind).sort(), ["acceptance", "plan", "review"]);
  assert.equal(s.state.run!.repairs.count, 1);

  s.produce(A.build("h4")); // recording a build clears the trigger
  assert.equal(s.state.run!.repairs.trigger, null);
  s.produce(A.findings("h4"), { slot: "fan:0" });
  s.produce(A.findings("h4"), { slot: "fan:1" });
  d = s.produce(A.review("h4", ["f9"]));
  assert.equal(s.state.run!.repairs.count, 2);
  b = attempt(effectsOf(d)[0]!);
  assert.equal(b.baseHead, "h4");

  d = blockedRound(s, "h5");
  assert.deepEqual(types(d), ["artifact.recorded", "repair.counted", "needs_human.raised"]);
  assert.deepEqual(effectsOf(d), []);
  assert.equal(s.state.status, "needs_human");
  assert.deepEqual(s.state.run!.repairs.history.map((h) => h.reason), ["review_blockers", "review_blockers", "review_blockers"]);

  // resume must raise the cap, otherwise the very next failure re-escalates
  d = s.send("human.resolved", { ticket: T1, choice: { kind: "resume", to: "build" as never, raiseCapBy: 0 } });
  assert.equal(d.refusal?.code, "bad_choice");
  d = s.send("human.resolved", { ticket: T1, choice: { kind: "resume", to: "nowhere" as never, raiseCapBy: 1 } });
  assert.equal(d.refusal?.code, "unknown_stage");
  d = s.send("human.resolved", { ticket: T1, choice: { kind: "resume", to: "build" as never, raiseCapBy: 1 } });
  assert.deepEqual(types(d), ["needs_human.cleared", "stage.entered", "effect.requested"]);
  assert.equal(s.state.status, "running");
  assert.equal(s.state.run!.repairs.cap, 4);
  assert.equal(s.state.run!.repairs.count, 3);

  d = blockedRound(s, "h6");
  assert.deepEqual(types(d), ["artifact.recorded", "repair.counted", "needs_human.raised"]);
  assert.equal(s.state.run!.repairs.count, 4);
});

test("QE defect counts against the cap; verify fail reaches QE; check_invalid escalates uncounted", () => {
  const s = sim();
  toVerify(s);
  let d = s.produce(A.verification("h2", "fail", ["acc-1"]));
  assert.deepEqual(types(d), ["artifact.recorded", "stage.entered", "effect.requested"]);
  assert.equal(attempt(effectsOf(d)[0]!).role, "qe");
  assert.equal(s.state.run!.repairs.count, 0);

  d = s.produce(A.qe("h2", "defect"));
  assert.deepEqual(types(d), ["artifact.recorded", "repair.counted", "stage.entered", "effect.requested"]);
  const trigger = attempt(effectsOf(d)[0]!).inputs.map((i) => i.kind);
  assert.ok(trigger.includes("qe_report"));
  const counted = d.events[1]!;
  assert.equal(counted.type === "repair.counted" && counted.data.reason, "qe_defect");

  const t = sim({ ticket: T2, world: sharedWorld() });
  toVerify(t);
  t.produce(A.verification("h2", "fail", ["acc-1"]));
  d = t.produce(A.qe("h2", "check_invalid"));
  assert.deepEqual(types(d), ["artifact.recorded", "needs_human.raised"]);
  assert.equal(t.state.run!.repairs.count, 0);
  assert.deepEqual(t.state.needsHuman, { kind: "pipeline_escalation", stage: "qe", outcome: "check_invalid" });
});

test("verify flaky and env_failure never reach QE", () => {
  const s = sim();
  toVerify(s);
  const d = s.produce(A.verification("h2", "flaky"));
  assert.deepEqual(types(d), ["artifact.recorded", "needs_human.raised"]);
  assert.deepEqual(effectsOf(d), []);
  assert.deepEqual(s.state.needsHuman, { kind: "pipeline_escalation", stage: "verify", outcome: "flaky" });
});

test("a rejected attempt retries with feedback from the same base head, outside the repair cap", () => {
  const s = sim();
  toBuild(s);
  const first = s.pending()[0]!;
  assert.equal(attempt(first).n, 1);

  let d = s.settle(first.key, { tag: "rejected", reason: { class: "locked_check_modified", details: ["tests/acceptance/a.py"] }, usage: null });
  assert.deepEqual(types(d), ["attempt.retried", "effect.requested"]);
  let retry = attempt(effectsOf(d)[0]!);
  assert.equal(retry.n, 2);
  assert.equal(retry.baseHead, "h1");
  assert.match(retry.feedback!, /locked_check_modified.*tests\/acceptance\/a\.py/);
  assert.notEqual(effectsOf(d)[0]!.key, first.key); // a retry is a NEW effect with a new footprint

  d = s.settle(effectsOf(d)[0]!.key, { tag: "crashed", detail: "exit 137", usage: null });
  retry = attempt(effectsOf(d)[0]!);
  assert.equal(retry.n, 3);
  assert.match(retry.feedback!, /exit 137/);

  d = s.settle(effectsOf(d)[0]!.key, { tag: "interrupted" });
  assert.deepEqual(types(d), ["needs_human.raised"]);
  assert.deepEqual(effectsOf(d), []);
  assert.deepEqual(s.state.needsHuman, { kind: "attempt_failed", stage: "build", slot: "main", detail: "interrupted" });
  assert.equal(s.state.run!.repairs.count, 0);
});

test("chained transitions: build produced => head advanced => both reviewers requested on the new head", () => {
  const s = sim();
  toBuild(s);
  const d = s.produce(A.build("h2"));
  assert.deepEqual(types(d), ["artifact.recorded", "head.advanced", "stage.entered", "effect.requested", "effect.requested"]);
  const reviewers = effectsOf(d).map(attempt);
  assert.deepEqual(reviewers.map((r) => r.slot), ["fan:0", "fan:1"]);
  assert.deepEqual(reviewers.map((r) => r.baseHead), ["h2", "h2"]);
  assert.deepEqual(reviewers.map((r) => r.role), ["reviewer", "reviewer"]);
  assert.deepEqual(reviewers.map((r) => r.out), ["review_findings", "review_findings"]);
  assert.deepEqual(reviewers.map((r) => r.guard.allowedPaths), [[], []]); // read-only fan-out
  assert.equal(s.state.run!.head, "h2");
  assert.equal(s.state.run!.stage!.phase, "fan");
});

test("fan-out join sees every reviewer's findings, in slot order, whatever order they finish", () => {
  const s = sim();
  toReview(s);
  const f0 = A.findings("h2", ["f0"]);
  const f1 = A.findings("h2", ["f1"]);
  const fan0Key = s.pending()[0]!.key;

  let d = s.produce(f1, { slot: "fan:1" });
  assert.deepEqual(types(d), ["artifact.recorded"]);
  assert.deepEqual(effectsOf(d), []);
  d = s.produce(f0, { slot: "fan:0" });
  assert.deepEqual(types(d), ["artifact.recorded", "effect.requested"]);
  const join = attempt(effectsOf(d)[0]!);
  assert.equal(join.role, "review-lead");
  assert.equal(join.slot, "join");
  assert.deepEqual(join.fanInputs.map((a) => a.hash), [f0.hash, f1.hash]);
  assert.deepEqual(join.inputs.map((a) => a.kind), ["build"]);
  assert.equal(s.state.run!.stage!.phase, "join");

  // a duplicate report for an already-settled key is a no-op
  const dup = s.settle(fan0Key, { tag: "produced", artifact: f0, usage: null });
  assert.deepEqual(dup.events, []);
});

test("gate.decided echoing different pins is refused and records nothing", () => {
  const s = sim();
  toGate(s);
  const logged = s.log.length;
  const g = s.state.run!.gate!;

  let d = s.send("gate.decided", { ticket: T1, gate: g.gate, decision: "approve", pins: { plan: sha("other"), acceptance: g.pins.acceptance! }, decider: "e", comment: "" });
  assert.equal(d.refusal?.code, "pins_mismatch");
  assert.deepEqual(d.events, []);
  d = s.send("gate.decided", { ticket: T1, gate: g.gate, decision: "approve", pins: { plan: g.pins.plan! }, decider: "e", comment: "" });
  assert.equal(d.refusal?.code, "pins_mismatch");
  d = s.send("gate.decided", { ticket: T1, gate: "plan_gate#9" as never, decision: "approve", pins: g.pins, decider: "e", comment: "" });
  assert.equal(d.refusal?.code, "no_open_gate");
  assert.equal(s.log.length, logged);
  assert.deepEqual(s.state.run!.gate, g);

  d = s.approve();
  assert.equal(d.refusal, undefined);
  d = s.send("gate.decided", { ticket: T1, gate: g.gate, decision: "approve", pins: g.pins, decider: "e", comment: "" });
  assert.equal(d.refusal?.code, "no_open_gate"); // the gate is closed now
});

test("gate: request_changes re-enters plan, reject escalates", () => {
  const s = sim();
  toGate(s);
  const g = s.state.run!.gate!;
  let d = s.send("gate.decided", { ticket: T1, gate: g.gate, decision: "request_changes", pins: g.pins, decider: "e", comment: "narrower" });
  assert.deepEqual(types(d), ["stage.entered", "effect.requested"]);
  assert.equal(attempt(effectsOf(d)[0]!).role, "planner");
  assert.deepEqual(s.state.run!.locks, []); // nothing was approved, nothing locked

  const r = sim({ ticket: T2, world: sharedWorld() });
  toGate(r);
  const rg = r.state.run!.gate!;
  d = r.send("gate.decided", { ticket: T2, gate: rg.gate, decision: "reject", pins: rg.pins, decider: "e", comment: "" });
  assert.deepEqual(types(d), ["needs_human.raised"]);
  assert.deepEqual(r.state.needsHuman, { kind: "pipeline_escalation", stage: "plan_gate", outcome: "rejected" });
});

test("taint is emitted first, before the status gate, and blocks the resource for every ticket", () => {
  const taint = { resource: RESOURCE, reason: "docker compose down failed for ark-app-env-s0" };

  // ticket already escalated while its verify was still in flight: the late result is audit-only, but the taint is durable
  const s = sim();
  toVerify(s);
  s.append(ev(T1, "needs_human.raised", { reason: { kind: "inconsistent", why: "operator note" } }));
  const verifyKey = s.pending()[0]!.key;
  const d = s.settle(verifyKey, { tag: "produced", artifact: A.verification("h2"), usage: null, taint });
  assert.deepEqual(types(d), ["resource.tainted"]);
  assert.equal(s.state.run!.artifacts.verification, undefined);
  assert.equal(s.state.status, "needs_human");
  assert.deepEqual(s.world.tainted[RESOURCE], { reason: taint.reason, key: verifyKey });
  assert.deepEqual(acquire(s.world, RESOURCE, 1), { ok: false, why: "tainted" });

  // a running ticket: taint first, then the normal transition
  const r = sim({ ticket: T2, world: sharedWorld() });
  toVerify(r);
  const d2 = r.produce(A.verification("h2"), { taint });
  assert.deepEqual(types(d2), ["resource.tainted", "artifact.recorded", "stage.entered", "effect.requested"]);
});

test("repro is recorded while the ticket is needs_human, never as a transition", () => {
  const s = sim();
  toBuild(s);
  blockedRound(s, "h3");
  blockedRound(s, "h4");
  blockedRound(s, "h5");
  assert.equal(s.state.status, "needs_human");

  let d = s.send("verify.requested", { ticket: T1, check: "no-such-check" });
  assert.equal(d.refusal?.code, "unknown_check");
  d = s.send("verify.requested", { ticket: T1, check: "acc-1" });
  assert.deepEqual(types(d), ["effect.requested"]);
  const req = effectsOf(d)[0]!;
  assert.deepEqual(req.lease, { resource: RESOURCE, slot: 0 });
  if (req.spec.kind !== "verify") throw new Error("unreachable");
  assert.deepEqual(req.spec.repro, { check: "acc-1" });
  assert.equal(req.spec.vector.repos["app" as never], "h5");
  assert.match(req.key, /\/repro\/1\//);

  d = s.send("verify.requested", { ticket: T1, check: "acc-1" }); // the one slot is leased
  assert.equal(d.refusal?.code, "resource_unavailable");

  d = s.settle(req.key, { tag: "produced", artifact: A.verification("h5", "fail", ["acc-1"]), usage: null });
  assert.deepEqual(types(d), ["repro.recorded"]);
  assert.deepEqual(d.cancel, []);
  assert.equal(s.state.status, "needs_human");
  assert.equal(s.state.run!.artifacts.verification, undefined);
  assert.deepEqual(view(s.state).repros, [{ key: req.key, outcome: "fail", evidenceDir: "evidence/1" }]);
  assert.deepEqual(s.world.leases[RESOURCE], {});

  d = s.send("verify.requested", { ticket: T1, check: "acc-1" });
  assert.match(effectsOf(d)[0]!.key, /\/repro\/2\//);
});

test("repro is refused on a tainted resource, and its own taint is recorded", () => {
  const s = sim();
  toBuild(s);
  s.send("verify.requested", { ticket: T1, check: "acc-1" });
  const key = s.pending().find((r) => r.spec.kind === "verify")!.key;
  const d = s.settle(key, { tag: "produced", artifact: A.verification("h1"), usage: null, taint: { resource: RESOURCE, reason: "teardown failed" } });
  assert.deepEqual(types(d), ["resource.tainted", "repro.recorded"]);
  assert.equal(s.send("verify.requested", { ticket: T1, check: "acc-1" }).refusal?.code, "resource_unavailable");
});

test("material_change routes to plan and re-locks through the plan gate", () => {
  const s = sim();
  toBuild(s);
  const oldLock = lockSet("tests/acceptance/a.py");
  assert.deepEqual(s.state.run!.locks, [oldLock]);

  let d = s.produce(A.build("h1", "material_change"));
  assert.deepEqual(types(d), ["artifact.recorded", "stage.entered", "effect.requested"]);
  assert.equal(attempt(effectsOf(d)[0]!).role, "planner");
  assert.equal(s.state.run!.repairs.count, 0);

  d = s.produce(A.plan("h1", ["src/**", "lib/**"]));
  const author = attempt(effectsOf(d)[0]!);
  assert.equal(author.role, "acceptance-author");
  assert.deepEqual(author.guard.locked, []); // the author of the locked material may change it; the gate re-locks

  const newLock = lockSet("tests/acceptance/b.py");
  const acceptance = A.acceptance("h3", "tests/acceptance/b.py");
  d = s.produce(acceptance);
  assert.deepEqual(types(d), ["artifact.recorded", "head.advanced", "stage.entered", "gate.opened"]);
  assert.equal(s.state.run!.gate!.gate, "plan_gate#2");
  assert.equal(s.state.run!.gate!.pins.acceptance, acceptance.hash);
  assert.deepEqual(s.state.run!.locks, [oldLock]); // still the old lock until the human approves

  d = s.approve();
  assert.deepEqual(types(d), ["locks.pinned", "stage.entered", "effect.requested"]);
  assert.deepEqual(s.state.run!.locks, [lockSet("tests/acceptance/b.py")]); // replaced, not merged
  assert.notDeepEqual(s.state.run!.locks, [oldLock]);
  const builder = attempt(effectsOf(d)[0]!);
  assert.deepEqual(builder.guard.locked, [newLock]);
  assert.deepEqual(builder.guard.allowedPaths, ["src/**", "lib/**"]);
  assert.equal(builder.baseHead, "h3");
  assert.equal(s.state.run!.visits["build" as never], 2);
});

test("prepare failure: needs_human with no run; resume re-requests prepare under the same run id", () => {
  const s = sim();
  registerEnv(s);
  s.send("ticket.created", { ticket: T1, env: ENV, input: { title: "t", intent: "i", acceptanceHints: [], base: null } });
  s.send("run.requested", { ticket: T1 });
  const first = s.pending()[0]!;
  if (first.spec.kind !== "run.prepare") throw new Error("unreachable");

  let d = s.settle(first.key, { tag: "crashed", detail: "worktree add failed", usage: null });
  assert.deepEqual(types(d), ["needs_human.raised"]);
  assert.deepEqual(s.state.needsHuman, { kind: "prepare_failed", why: "crashed: worktree add failed" });
  assert.equal(s.state.status, "needs_human");
  assert.equal(s.state.run, null);
  assert.deepEqual(s.pending(), []);

  d = s.send("human.resolved", { ticket: T1, choice: { kind: "resume", to: "build" as never, raiseCapBy: 0 } });
  assert.equal(d.refusal?.code, "bad_choice");
  d = s.send("human.resolved", { ticket: T1, choice: { kind: "resume", to: null, raiseCapBy: 0 } });
  assert.deepEqual(types(d), ["needs_human.cleared", "effect.requested"]);
  const again = effectsOf(d)[0]!;
  assert.equal(again.spec.kind, "run.prepare");
  if (again.spec.kind !== "run.prepare") throw new Error("unreachable");
  assert.equal(again.spec.runId, first.spec.runId);
  assert.notEqual(again.key, first.key);
  assert.equal(s.state.prepares, 2);
  assert.equal(s.state.status, "preparing");

  d = s.settle(again.key, { tag: "prepared", manifest: s.manifest, pipeline, head: head("h0") });
  assert.deepEqual(types(d), ["run.started", "stage.entered", "effect.requested"]);
  assert.equal(s.state.run!.runId, first.spec.runId);

  // abort from needs_human
  const a = sim({ ticket: T2, world: sharedWorld() });
  registerEnv(a);
  a.send("ticket.created", { ticket: T2, env: ENV, input: { title: "t", intent: "i", acceptanceHints: [], base: null } });
  a.send("run.requested", { ticket: T2 });
  a.settle(a.pending()[0]!.key, { tag: "ambiguous", why: "worktree at another sha" });
  assert.equal(a.state.needsHuman?.kind, "prepare_failed");
  d = a.send("human.resolved", { ticket: T2, choice: { kind: "abort" } });
  assert.deepEqual(types(d), ["needs_human.cleared", "ticket.aborted"]);
  assert.equal(a.state.status, "aborted");
});

test("verification waits for a busy or tainted resource and is woken by resource.released", () => {
  const ref = sharedWorld();
  const a = sim({ ticket: T1, world: ref });
  const b = sim({ ticket: T2, world: ref });
  toVerify(a);
  assert.deepEqual(view(a.state).leases.map((l) => l.slot), [0]);

  toReview(b);
  b.produce(A.findings("h2"), { slot: "fan:0" });
  b.produce(A.findings("h2"), { slot: "fan:1" });
  let d = b.produce(A.review("h2"));
  assert.deepEqual(types(d), ["artifact.recorded", "stage.entered", "stage.waiting"]);
  assert.deepEqual(effectsOf(d), []);
  assert.equal(b.state.run!.stage!.waitingOn, RESOURCE);
  assert.equal(view(b.state).waitingOn, RESOURCE);

  // woken while still busy: nothing, and the stage keeps waiting
  d = b.send("resource.released", { ticket: T2, resource: RESOURCE });
  assert.deepEqual(d.events, []);
  assert.equal(b.state.run!.stage!.waitingOn, RESOURCE);

  // A's verify settles, freeing the slot; the engine wakes B
  a.produce(A.verification("h2"));
  d = b.send("resource.released", { ticket: T2, resource: RESOURCE });
  assert.deepEqual(types(d), ["effect.requested"]); // no second stage.entered
  assert.deepEqual(effectsOf(d)[0]!.lease, { resource: RESOURCE, slot: 0 });
  assert.equal(b.state.run!.stage!.waitingOn, null);

  // not waiting any more: another wake-up is a no-op
  assert.deepEqual(b.send("resource.released", { ticket: T2, resource: RESOURCE }).events, []);
});

test("a tainted resource keeps waiters waiting until resource.cleared", () => {
  const ref = sharedWorld();
  const a = sim({ ticket: T1, world: ref });
  const b = sim({ ticket: T2, world: ref });
  toVerify(a);
  toReview(b);
  b.produce(A.findings("h2"), { slot: "fan:0" });
  b.produce(A.findings("h2"), { slot: "fan:1" });
  b.produce(A.review("h2"));
  assert.equal(b.state.run!.stage!.waitingOn, RESOURCE);

  a.produce(A.verification("h2"), { taint: { resource: RESOURCE, reason: "teardown failed" } });
  assert.deepEqual(ref.world.leases[RESOURCE], {}); // the lease is free, the resource is not
  assert.deepEqual(b.send("resource.released", { ticket: T2, resource: RESOURCE }).events, []);

  b.worldEvent({ id: "w9" as never, v: 1, ts: "2026-01-01T00:00:00Z" as never, stream: "world" as never, type: "resource.cleared", authority: "authoritative", source: "human", data: { resource: RESOURCE, by: "engineer" } });
  const d = b.send("resource.released", { ticket: T2, resource: RESOURCE });
  assert.deepEqual(types(d), ["effect.requested"]);
});

test("slot allocation: the second concurrent verify takes slot 1 with its own compose project", () => {
  const ref = sharedWorld();
  const a = sim({ ticket: T1, world: ref, slots: 2 });
  const b = sim({ ticket: T2, world: ref, slots: 2 });
  toVerify(a);
  toReview(b);
  b.produce(A.findings("h2"), { slot: "fan:0" });
  b.produce(A.findings("h2"), { slot: "fan:1" });
  const d = b.produce(A.review("h2"));
  const req = effectsOf(d)[0]!;
  assert.deepEqual(req.lease, { resource: RESOURCE, slot: 1 });
  assert.equal(req.spec.kind === "verify" && req.spec.project, "ark-app-env-s1");
});

test("timeout escalates, cancels the siblings, and late or stale reports are audit-only", () => {
  const s = sim();
  toReview(s);
  const [f0, f1] = s.pending();
  let d = s.settle(f0!.key, { tag: "timed_out" });
  assert.deepEqual(types(d), ["needs_human.raised"]);
  assert.deepEqual(s.state.needsHuman, { kind: "timed_out", key: f0!.key });
  assert.deepEqual(d.cancel, [f1!.key]);

  // the cancelled sibling's late result arrives while needs_human: nothing recorded, inflight cleared
  d = s.settle(f1!.key, { tag: "produced", artifact: A.findings("h2"), usage: null });
  assert.deepEqual(d.events, []);
  assert.deepEqual(s.pending(), []);

  // a report from an EARLIER stage visit after a resume is ignored too
  const t = sim({ ticket: T2, world: sharedWorld() });
  toReview(t);
  const [g0, g1] = t.pending();
  t.settle(g0!.key, { tag: "ambiguous", why: "unclear" });
  t.send("human.resolved", { ticket: T2, choice: { kind: "resume", to: "build" as never, raiseCapBy: 0 } });
  const late = t.settle(g1!.key, { tag: "produced", artifact: A.findings("h2"), usage: null });
  assert.deepEqual(late.events, []);
  assert.equal(t.state.run!.stage!.stage, "build");
});

test("publish is not requested on a stale head", () => {
  const s = sim();
  toVerify(s);
  s.produce(A.verification("h2"));
  const d = s.produce(A.qe("h3")); // QE's artifact carries a newer head: verification is now stale
  assert.deepEqual(types(d), ["artifact.recorded", "head.advanced", "stage.entered", "needs_human.raised"]);
  assert.deepEqual(effectsOf(d), []);
  assert.equal(s.state.needsHuman?.kind, "inconsistent");
});

test("refusals: unknown environment, wrong state; executor reports are never refused", () => {
  const s = sim();
  let d = s.send("ticket.created", { ticket: T1, env: ENV, input: { title: "t", intent: "i", acceptanceHints: [], base: null } });
  assert.equal(d.refusal?.code, "env_unknown");
  registerEnv(s);
  assert.equal(s.send("run.requested", { ticket: T1 }).refusal?.code, "wrong_state");
  s.send("ticket.created", { ticket: T1, env: ENV, input: { title: "t", intent: "i", acceptanceHints: [], base: null } });
  assert.equal(s.send("ticket.created", { ticket: T1, env: ENV, input: { title: "t", intent: "i", acceptanceHints: [], base: null } }).refusal?.code, "wrong_state");
  assert.equal(s.send("human.resolved", { ticket: T1, choice: { kind: "abort" } }).refusal?.code, "wrong_state");
  assert.equal(s.send("verify.requested", { ticket: T1, check: "acc-1" }).refusal?.code, "wrong_state");
  d = s.settle("PROJ-1/r_x/prepare/1/main/1" as EffectKey, { tag: "cancelled" });
  assert.equal(d.refusal, undefined);
  assert.deepEqual(d.events, []);
});

test("a landed run is absorbing and a full log replays to the same state", () => {
  const s = sim();
  finish(s);
  assert.equal(s.state.status, "landed");
  assert.deepEqual(replay(T1, s.log), s.state);
});
