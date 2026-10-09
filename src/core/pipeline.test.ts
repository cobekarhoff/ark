/** parsePipeline(doc, roles): the default pipeline is accepted; each engine rule has a document that violates it. */
import test from "node:test";
import assert from "node:assert/strict";
import type { RoleId } from "./ids.ts";
import { outcomesOf, parsePipeline, producesOf } from "./pipeline.ts";
import type { Pipeline, PipelineProblem, RoleBinding } from "./pipeline.ts";
import { cloneDoc, defaultPipelineDoc, roles } from "./fixtures.ts";

type Doc = ReturnType<typeof cloneDoc>;
type Mutable = { stages: Record<string, Record<string, unknown>>; transitions: Record<string, Record<string, unknown>>; [k: string]: unknown };

/** Parse a mutated copy of the default document; return the problems (fails the test if it was accepted). */
function rejected(mutate: (d: Mutable) => void, r: Readonly<Record<RoleId, RoleBinding>> = roles): readonly PipelineProblem[] {
  const doc = cloneDoc();
  mutate(doc as unknown as Mutable);
  const out = parsePipeline(doc, r);
  assert.ok(Array.isArray(out), `expected rejection, got a pipeline`);
  return out as readonly PipelineProblem[];
}
const mentions = (problems: readonly PipelineProblem[], where: string, text: RegExp): boolean =>
  problems.some((p) => p.where === where && text.test(p.message));
const withRole = (name: string, writes: RoleBinding["writes"]): Readonly<Record<RoleId, RoleBinding>> =>
  ({ ...roles, [name as RoleId]: { ...roles[name as RoleId]!, writes } });

test("accepts the default pipeline and hashes its canonical form", () => {
  const p = parsePipeline(defaultPipelineDoc, roles) as Pipeline;
  assert.ok(!Array.isArray(p));
  assert.equal(p.repairCap, 3);
  assert.equal(p.entry, "intake");
  assert.equal(p.stages["build" as never]!.kind, "agent");
  assert.deepEqual(p.transitions["review" as never], { pass: "verify", blockers: "build" });
  assert.match(p.hash, /^sha256:[0-9a-f]{64}$/);
  // key order in the document does not change the hash; content does
  const reordered = { ...cloneDoc(), stages: Object.fromEntries(Object.entries(cloneDoc().stages).reverse()) };
  assert.equal((parsePipeline(reordered, roles) as Pipeline).hash, p.hash);
  const edited = cloneDoc();
  edited.repair_cap = 4;
  assert.notEqual((parsePipeline(edited, roles) as Pipeline).hash, p.hash);
});

test("stage vocabulary is derived from the catalog", () => {
  const p = parsePipeline(defaultPipelineDoc, roles) as Pipeline;
  const stage = (id: string) => p.stages[id as never]!;
  assert.equal(producesOf(stage("verify")), "verification");
  assert.equal(producesOf(stage("ci")), "ci");
  assert.equal(producesOf(stage("plan_gate")), null);
  assert.deepEqual(outcomesOf(stage("qe")), ["pass", "defect", "check_invalid"]);
  assert.deepEqual(outcomesOf(stage("plan_gate")), ["approved", "changes_requested", "rejected"]);
});

test("accepts a second, non-locking human gate after planning (yaml-only change)", () => {
  const doc = cloneDoc();
  const m = doc as unknown as Mutable;
  m.stages["design_gate"] = { kind: "gate", approves: ["plan"], locks: false };
  m.transitions["plan"] = { done: "design_gate" };
  m.transitions["design_gate"] = { approved: "acceptance", changes_requested: "plan", rejected: "needs_human" };
  const out = parsePipeline(doc, roles);
  assert.ok(!Array.isArray(out), JSON.stringify(out));
});

test("rejects a missing outcome edge, an extra edge, and an unknown target", () => {
  assert.ok(mentions(rejected((d) => { delete d.transitions["review"]!["blockers"]; }), "transitions.review.blockers", /missing outcome edge/));
  assert.ok(mentions(rejected((d) => { d.transitions["review"]!["maybe"] = "build"; }), "transitions.review.maybe", /not an outcome/));
  assert.ok(mentions(rejected((d) => { d.transitions["intake"]!["done"] = "nowhere"; }), "transitions.intake.done", /not a stage/));
  assert.ok(mentions(rejected((d) => { delete d.transitions["qe"]; }), "transitions.qe", /missing transition row/));
});

test("rejects ark.verify that does not dominate ark.publish", () => {
  // build -> qe skips review and verify; publish is then reachable without verification
  const problems = rejected((d) => { d.transitions["build"]!["done"] = "qe"; });
  assert.ok(mentions(problems, "stages.publish", /reachable without passing ark\.verify/));
});

test("rejects publish entered other than through the qe pass edge", () => {
  assert.ok(mentions(rejected((d) => { d.transitions["verify"]!["pass"] = "publish"; }), "transitions.verify.pass", /publish may only be entered through the pass edge/));
  assert.ok(mentions(rejected((d) => { d.transitions["qe"]!["defect"] = "publish"; }), "transitions.qe.defect", /publish may only be entered/));
});

test("rejects verify edges that bypass QE or let flaky/env_failure through", () => {
  assert.ok(mentions(rejected((d) => { d.transitions["verify"]!["fail"] = "build"; }), "transitions.verify.fail", /must route to a stage producing qe_report/));
  assert.ok(mentions(rejected((d) => { d.transitions["verify"]!["flaky"] = "qe"; }), "transitions.verify.flaky", /must route to needs_human/));
});

test("rejects a plan gate that does not dominate a writing stage", () => {
  // analyze -> build: the builder is reachable without passing the locking gate
  const problems = rejected((d) => { d.transitions["analyze"]!["done"] = "build"; });
  assert.ok(mentions(problems, "stages.build", /without passing a gate with locks: true/));
  // a gate that does not lock does not count
  assert.ok(mentions(rejected((d) => { d.stages["plan_gate"]!["locks"] = false; }), "stages.build", /without passing a gate with locks: true/));
  // the exemption is only for producers of the gate's approved kinds (plan, acceptance): a writing analyst is not exempt
  const analyst = withRole("analyst", { kind: "globs", globs: ["docs/**"] as never });
  assert.ok(mentions(rejected(() => {}, analyst), "stages.analyze", /without passing a gate with locks: true/));
  // ...and the acceptance author, who writes before the gate, is accepted (default pipeline)
});

test("rejects ark.verify reachable before the locking gate", () => {
  const problems = rejected((d) => { d.transitions["analyze"]!["done"] = "verify"; });
  assert.ok(mentions(problems, "stages.verify", /without passing a gate with locks: true/));
});

test("rejects a fan-out role that writes", () => {
  const problems = rejected(() => {}, withRole("reviewer", { kind: "plan.allowedPaths" }));
  assert.ok(mentions(problems, "stages.review.fanout.role", /must have writes: none/));
});

test("rejects a cycle with no repair edge and no gate", () => {
  const problems = rejected((d) => { d.transitions["analyze"]!["done"] = "intake"; });
  assert.ok(problems.some((p) => /no repair edge/.test(p.message)));
  // the default cycles are fine: each passes a counted outcome or a gate
  assert.ok(!Array.isArray(parsePipeline(defaultPipelineDoc, roles)));
});

test("rejects material_change that cannot reach the locking gate again", () => {
  const problems = rejected((d) => { d.transitions["build"]!["material_change"] = "review"; });
  assert.ok(mentions(problems, "transitions.build.material_change", /reaches a gate with locks: true/));
});

test("rejects bad documents: roles, kinds, cap, inputs not produced upstream", () => {
  assert.ok(mentions(rejected((d) => { d.stages["build"]!["role"] = "ghost"; }), "stages.build.role", /not bound/));
  assert.ok(mentions(rejected((d) => { d.stages["verify"]!["run"] = "ark.deploy"; }), "stages.verify.run", /unknown command/));
  assert.ok(mentions(rejected((d) => { d.stages["ci"]!["for"] = "gitlab.nothing"; }), "stages.ci.for", /unknown wait/));
  assert.ok(mentions(rejected((d) => { d.stages["plan"]!["in"] = ["ticket", "poem"]; }), "stages.plan.in", /unknown artifact kind/));
  assert.ok(mentions(rejected((d) => { d.stages["plan"]!["kind"] = "robot"; }), "stages.plan.kind", /unknown stage kind/));
  assert.ok(mentions(rejected((d) => { d["repair_cap"] = 0; }), "repair_cap", /integer >= 1/));
  assert.ok(mentions(rejected((d) => { d["version"] = 2; }), "version", /must be 1/));
  assert.ok(mentions(rejected((d) => { d["entry"] = "start"; }), "entry", /not a stage/));
  assert.ok(mentions(rejected((d) => { d.stages["acceptance"]!["in"] = ["plan", "build"]; }), "stages.acceptance.in", /build is not produced on every path/));
  assert.ok(mentions(rejected((d) => { d.stages["prepare"] = { kind: "wait", for: "gitlab.merged" }; d.transitions["prepare"] = { merged: "landed", closed: "needs_human" }; }), "stages.prepare", /stage id/));
  assert.deepEqual(parsePipeline("nope", roles), [{ where: "", message: "pipeline document must be a mapping" }]);
});
