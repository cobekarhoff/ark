/** The catalog's pure projections and the cross-artifact rules. */
import test from "node:test";
import assert from "node:assert/strict";
import type { RepoId } from "./ids.ts";
import { ARTIFACT_KINDS, CATALOG, REPAIR_REASON, countsRepair } from "./contracts.ts";
import type { AdmitInputs, ArtifactKind } from "./contracts.ts";
import { A, head } from "./fixtures.ts";

const inputs = (over: Partial<AdmitInputs> = {}): AdmitInputs => ({
  head: head("h2"), artifacts: {}, fan: [], evidenceExists: (rel) => rel === "evidence/1/log.txt", ...over,
});

test("only review blockers, QE defects and CI blockers spend the repair cap", () => {
  const spending = ARTIFACT_KINDS.flatMap((k) => Object.keys(CATALOG[k].outcomes).filter((o) => countsRepair(k, o as never)).map((o) => `${k}/${o}`));
  assert.deepEqual(spending, ["review/blockers", "qe_report/defect", "ci/blockers"]);
  // every spending kind has a repair.counted reason
  for (const s of spending) assert.ok(s.split("/")[0]! in REPAIR_REASON);
  assert.equal(countsRepair("verification", "fail"), false);
});

test("only claims about the source are head-bound", () => {
  const bound = ARTIFACT_KINDS.filter((k) => CATALOG[k].headBound);
  assert.deepEqual(bound, ["build", "review_findings", "review", "verification", "qe_report", "mr", "ci", "landing"] satisfies ArtifactKind[]);
});

test("projections read bodies: outcome, facts, pinned roots", () => {
  assert.equal(CATALOG.review.outcomeOf({ blockers: [] }), "pass");
  assert.equal(CATALOG.review.outcomeOf({ blockers: [{ id: "b1" }] }), "blockers");
  assert.deepEqual(CATALOG.review.factsOf({ blockers: [{ id: "b1" }, { id: "b2" }] }), { blockerIds: ["b1", "b2"] });
  assert.equal(CATALOG.build.outcomeOf({ outcome: "material_change" }), "material_change");
  assert.equal(CATALOG.build.outcomeOf({}), "done");
  assert.deepEqual(CATALOG.plan.factsOf({ allowed_paths: ["src/**"] }), { allowedPaths: ["src/**"] });
  assert.deepEqual(CATALOG.acceptance.pinnedRoots({ locked_roots: [{ repo: "app", root: "tests/acceptance" }] }), [{ repo: "app" as RepoId, root: "tests/acceptance" }]);
  assert.equal(CATALOG.landing.factsOf({ merged_sha: null }).mergedSha, null);
});

test("acceptance: rejection-style checks need a positive control, limitations are declared, ids unique", () => {
  const ok = { id: "c1", rejection_style: true, positive_control: "self", limitations: [] };
  assert.deepEqual(CATALOG.acceptance.admissible({ checks: [ok] }, inputs()), []);
  const noControl = CATALOG.acceptance.admissible({ checks: [{ ...ok, positive_control: null }] }, inputs());
  assert.match(noControl[0]!, /needs a positive control/);
  assert.match(CATALOG.acceptance.admissible({ checks: [{ ...ok, positive_control: "c9" }] }, inputs())[0]!, /not in the artifact/);
  assert.match(CATALOG.acceptance.admissible({ checks: [{ id: "c1" }] }, inputs())[0]!, /declare limitations/);
  assert.match(CATALOG.acceptance.admissible({ checks: [ok, ok] }, inputs())[0]!, /not unique/);
});

test("qe_report: pass needs a passing verification for this head; defects need a failed check and existing evidence", () => {
  const pass = (v: ReturnType<typeof A.verification> | undefined) => CATALOG.qe_report.admissible({ verdict: "pass" }, inputs({ artifacts: v ? { verification: v } : {} }));
  assert.deepEqual(pass(A.verification("h2")), []);
  assert.match(pass(A.verification("h2", "fail", ["c1"]))[0]!, /needs verification pass/);
  assert.match(pass(A.verification("h1"))[0]!, /for this head/);
  assert.match(pass(undefined)[0]!, /for this head/);

  const failed = inputs({ artifacts: { verification: A.verification("h2", "fail", ["c1"]) } });
  const defect = (d: object) => CATALOG.qe_report.admissible({ verdict: "defect", defects: [d] }, failed);
  assert.deepEqual(defect({ id: "d1", check: "c1", evidence: ["evidence/1/log.txt"] }), []);
  assert.match(defect({ id: "d1", check: "c9", evidence: ["evidence/1/log.txt"] })[0]!, /not a failed check/);
  assert.match(defect({ id: "d1", check: "c1", evidence: [] })[0]!, /no evidence/);
  assert.match(defect({ id: "d1", check: "c1", evidence: ["evidence/1/missing.txt"] })[0]!, /does not exist/);
  assert.deepEqual(CATALOG.qe_report.admissible({ verdict: "check_invalid", invalid_check: "c1" }, failed), []);
  assert.match(CATALOG.qe_report.admissible({ verdict: "check_invalid", invalid_check: "c2" }, failed)[0]!, /not a failed check/);
});

test("review: every blocker must appear in some reviewer's findings", () => {
  const fan = [A.findings("h2", ["f1"]), A.findings("h2", ["f2"])];
  assert.deepEqual(CATALOG.review.admissible({ blockers: [{ id: "f1" }, { id: "f2" }] }, inputs({ fan })), []);
  assert.match(CATALOG.review.admissible({ blockers: [{ id: "f3" }] }, inputs({ fan }))[0]!, /f3 appears in no reviewer/);
});
