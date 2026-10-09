import test from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AbsPath, GitSha, RepoId } from "../core/ids.ts";
import type { AnyRecorded, ArtifactKind, PinnedRoot, RecordedArtifact } from "../core/contracts.ts";
import { admit, readArtifact, renderMarkdown } from "./admit.ts";
import type { AdmitContext } from "./admit.ts";
import { hashLocked } from "./guard.ts";
import { commit, newRepo, put, rejects, withTmp } from "./repo-fixture.ts";

const H1 = "h1" as GitSha;
const SUMS = `sha256:${"a".repeat(64)}`;

const envelope = (kind: ArtifactKind, body: unknown) => JSON.stringify({
  schema: `${kind}.v1`, ticket: "T-1", run: "r_1", attempt: 1, produced_by: { role: "x", manifest_hash: "sha256:m" }, inputs: [], body,
});

/** Context for a run dir: evidence exists iff a non-empty file is there; no worktree unless a test passes `pin`. */
const ctxFor = (runDir: AbsPath, over: Partial<AdmitContext> = {}): AdmitContext => ({
  head: H1, artifacts: {}, fan: [], pin: async () => [],
  evidenceExists: (rel) => { try { const s = statSync(join(runDir, rel)); return s.isFile() && s.size > 0; } catch { return false; } },
  ...over,
});

/** admit() that must succeed; fixtures obtain every artifact through the real boundary. */
async function mustAdmit<K extends ArtifactKind>(runDir: AbsPath, kind: K, body: unknown, over: Partial<AdmitContext> = {}): Promise<RecordedArtifact<K>> {
  const r = await admit(runDir, kind, envelope(kind, body), ctxFor(runDir, over));
  if (!r.ok) throw new Error(`admit ${kind} refused: ${r.problems.join("; ")}`);
  return r.artifact as unknown as RecordedArtifact<K>;
}

async function problemsOf(runDir: AbsPath, kind: ArtifactKind, raw: string, over: Partial<AdmitContext> = {}): Promise<readonly string[]> {
  const r = await admit(runDir, kind, raw, ctxFor(runDir, over));
  assert.equal(r.ok, false, "expected a refusal");
  return r.ok ? [] : r.problems;
}

const check = (over: Record<string, unknown> = {}) => ({
  id: "c1", repo: "app", command: ["sh", "locked/check.sh"], timeout_s: 30, environment_class: "local-emulator",
  rejection_style: false, positive_control: null, limitations: [], ...over,
});
const verification = (outcome: string, failed: string[] = []) => ({ outcome, evidence_dir: "evidence/1", sums_digest: SUMS, failed_checks: failed, limitations: [] });

test("schema: malformed documents are refused with located problems and nothing is stored", async () => {
  await withTmp(async (runDir) => {
    assert.match((await problemsOf(runDir, "plan", "{nope"))[0]!, /not valid JSON/);
    assert.deepEqual(await problemsOf(runDir, "plan", envelope("plan", { steps: [], approach: "a" })), ["$.body.allowed_paths: is required"]);
    assert.deepEqual(await problemsOf(runDir, "plan", envelope("plan", { steps: [], approach: "a", allowed_paths: "src/**" })), ["$.body.allowed_paths: expected array, got string"]);
    assert.deepEqual(await problemsOf(runDir, "ci", envelope("ci", { outcome: "great", pipeline_id: 1, failed_jobs: [] })), ['$.body.outcome: must be one of "pass", "blockers", "infra_failure"']);
    assert.deepEqual(await problemsOf(runDir, "mr", envelope("mr", { iid: 1.5, url: "u", branch: "b" })), ["$.body.iid: expected integer, got number"]);
    assert.deepEqual(await problemsOf(runDir, "verification", envelope("verification", { ...verification("pass"), sums_digest: "md5:x" })), ["$.body.sums_digest: must match ^sha256:[0-9a-f]{64}$"]);

    const wrongSchema = JSON.parse(envelope("plan", { steps: [], approach: "a", allowed_paths: [] })) as Record<string, unknown>;
    assert.deepEqual(await problemsOf(runDir, "plan", JSON.stringify({ ...wrongSchema, schema: "build.v1", stray: 1 })), ['$.schema: must be "plan.v1"', "$.stray: is not allowed"]);
    const noEnvelope = JSON.stringify({ steps: [], approach: "a", allowed_paths: [] });
    assert.ok((await problemsOf(runDir, "plan", noEnvelope)).includes("$.body: is required"));

    assert.deepEqual(await readdir(runDir, { withFileTypes: true }), [], "a refused artifact leaves no file");
  });
});

test("schema and admissible problems come back together", async () => {
  await withTmp(async (runDir) => {
    const bad = check({ id: "rej", rejection_style: true });
    delete (bad as Record<string, unknown>).limitations;
    const problems = await problemsOf(runDir, "acceptance", envelope("acceptance", { checks: [bad], locked_roots: [] }));
    assert.deepEqual(problems, [
      "$.body.checks[0].limitations: is required",
      "check rej must declare limitations (possibly empty)",
      "rejection-style check rej needs a positive control",
    ]);
  });
});

test("admissible: a rejection-style acceptance check needs a positive control that exists", async () => {
  await withTmp(async (runDir) => {
    const noControl = await problemsOf(runDir, "acceptance", envelope("acceptance", { checks: [check({ rejection_style: true })], locked_roots: [] }));
    assert.deepEqual(noControl, ["rejection-style check c1 needs a positive control"]);
    const dangling = await problemsOf(runDir, "acceptance", envelope("acceptance", { checks: [check({ rejection_style: true, positive_control: "ghost" })], locked_roots: [] }));
    assert.deepEqual(dangling, ["check c1 names positive control ghost, which is not in the artifact"]);

    await mustAdmit(runDir, "acceptance", { checks: [check({ rejection_style: true, positive_control: "self" })], locked_roots: [] });
    await mustAdmit(runDir, "acceptance", { checks: [check({ id: "ok" }), check({ rejection_style: true, positive_control: "ok" })], locked_roots: [] });
  });
});

test("admissible: QE pass needs a verification pass for the SAME head; failed verification or none refuses", async () => {
  await withTmp(async (runDir) => {
    const qePass = envelope("qe_report", { verdict: "pass", defects: [], same_model_as_builder: false });
    assert.deepEqual(await problemsOf(runDir, "qe_report", qePass), ["qe_report needs a verification recorded for this head"]);

    const failed = await mustAdmit(runDir, "verification", verification("fail", ["c1"]));
    assert.deepEqual(await problemsOf(runDir, "qe_report", qePass, { artifacts: { verification: failed } }), ["verdict pass needs verification pass, got fail"]);

    const passed = await mustAdmit(runDir, "verification", verification("pass"));
    const qe = await mustAdmit(runDir, "qe_report", { verdict: "pass", defects: [], same_model_as_builder: false }, { artifacts: { verification: passed } });
    assert.equal(qe.outcome, "pass");

    const otherHead = { ...passed, head: "h0" as GitSha } as RecordedArtifact<"verification">;
    assert.deepEqual(await problemsOf(runDir, "qe_report", qePass, { artifacts: { verification: otherHead } }), ["qe_report needs a verification recorded for this head"]);
  });
});

test("admissible: a QE defect must cite a failed check and evidence that exists", async () => {
  await withTmp(async (runDir) => {
    const failed = await mustAdmit(runDir, "verification", verification("fail", ["c1"]));
    const over = { artifacts: { verification: failed } };
    const defect = (d: object) => envelope("qe_report", { verdict: "defect", defects: [{ id: "d1", check: "c1", evidence: ["evidence/1/logs/c1.log"], ...d }], same_model_as_builder: false });

    assert.deepEqual(await problemsOf(runDir, "qe_report", defect({}), over), ["defect d1: evidence evidence/1/logs/c1.log does not exist"]);
    await put(runDir, "evidence/1/logs/c1.log", "");
    assert.deepEqual(await problemsOf(runDir, "qe_report", defect({}), over), ["defect d1: evidence evidence/1/logs/c1.log does not exist"], "an empty file is not evidence");
    await put(runDir, "evidence/1/logs/c1.log", "assertion failed\n");

    assert.deepEqual(await problemsOf(runDir, "qe_report", defect({ check: "c9" }), over), ["defect d1 cites c9, which is not a failed check"]);
    assert.deepEqual(await problemsOf(runDir, "qe_report", defect({ evidence: [] }), over), ["defect d1 cites no evidence"]);
    assert.deepEqual(await problemsOf(runDir, "qe_report", envelope("qe_report", { verdict: "defect", defects: [], same_model_as_builder: false }), over), ["verdict defect needs at least one defect"]);

    const ok = await admit(runDir, "qe_report", defect({}), ctxFor(runDir, over));
    assert.equal(ok.ok && ok.artifact.outcome, "defect");
  });
});

test("admissible: every review blocker must appear in some fan-out finding", async () => {
  await withTmp(async (runDir) => {
    const f1 = await mustAdmit(runDir, "review_findings", { findings: [{ id: "f1" }, { id: "f2" }] });
    const f2 = await mustAdmit(runDir, "review_findings", { findings: [{ id: "g1" }] });
    const fan = [f1, f2] as readonly AnyRecorded[];

    assert.deepEqual(await problemsOf(runDir, "review", envelope("review", { blockers: [{ id: "f1" }, { id: "zz" }] }), { fan }), ["blocker zz appears in no reviewer's findings"]);
    const ok = await mustAdmit(runDir, "review", { blockers: [{ id: "f2" }, { id: "g1" }] }, { fan });
    assert.equal(ok.outcome, "blockers");
    assert.deepEqual(ok.facts.blockerIds, ["f2", "g1"]);
    assert.equal((await mustAdmit(runDir, "review", { blockers: [] }, { fan })).outcome, "pass");
  });
});

test("pin: acceptance roots are measured against a real repo; a missing, unpinned or throwing root is declared_file_missing", async () => {
  await withTmp(async (root) => {
    const repo = await newRepo(root);
    const head = await commit(repo, { "locked/check.sh": "assert 1\n", "locked/fx.json": "{}\n" });
    const pin = async (roots: readonly PinnedRoot[]) => {
      const by = new Map<string, string[]>();
      for (const r of roots) by.set(r.repo, [...(by.get(r.repo) ?? []), r.root]);
      return Promise.all([...by].map(([id, rs]) => hashLocked(repo, id as RepoId, head, rs)));
    };
    const runDir = join(root, "run") as AbsPath;
    const body = (roots: string[]) => ({ checks: [check()], locked_roots: roots.map((r) => ({ repo: "app", root: r })) });

    const ok = await mustAdmit(runDir, "acceptance", body(["locked"]), { pin, head });
    assert.deepEqual(ok.pinned.map((p) => [p.repo, p.roots, p.files.map((f) => f.path)]), [["app", ["locked"], ["locked/check.sh", "locked/fx.json"]]]);
    assert.equal(ok.head, head);

    const raw = envelope("acceptance", body(["locked", "gone"]));
    assert.deepEqual(await problemsOf(runDir, "acceptance", raw, { pin }), ["declared_file_missing: app:gone has no files at head"]);
    assert.deepEqual(await problemsOf(runDir, "acceptance", envelope("acceptance", body(["locked"])), { pin: async () => [] }), ["declared_file_missing: app:locked has no files at head"]);
    assert.deepEqual(await problemsOf(runDir, "acceptance", raw, { pin: async () => { throw new Error("boom"); } }), ["declared_file_missing: boom"]);
  });
});

test("admit is idempotent on content: same bytes, or the same value reformatted, give one artifact and one file", async () => {
  await withTmp(async (runDir) => {
    const body = { steps: ["a"], approach: "x", allowed_paths: ["src/**"] };
    const a = await mustAdmit(runDir, "plan", body);
    const b = await mustAdmit(runDir, "plan", body);
    assert.deepEqual(b, a);
    const reordered = JSON.stringify({ body: { allowed_paths: ["src/**"], approach: "x", steps: ["a"] }, attempt: 1, inputs: [], produced_by: { manifest_hash: "sha256:m", role: "x" }, run: "r_1", ticket: "T-1", schema: "plan.v1" }, null, 2);
    const c = await admit(runDir, "plan", reordered, ctxFor(runDir));
    assert.deepEqual(c.ok && c.artifact, a);

    assert.deepEqual((await readdir(join(runDir, "artifacts"), { withFileTypes: true })).map((e) => e.name), [a.path.slice("artifacts/".length)]);
    assert.equal(a.outcome, "done");
    assert.deepEqual(a.facts, { allowedPaths: ["src/**"] });
    assert.match(a.hash, /^sha256:[0-9a-f]{64}$/);
  });
});

test("readArtifact returns the canonical bytes and throws on a tampered, garbage, missing or escaping artifact", async () => {
  await withTmp(async (runDir) => {
    const a = await mustAdmit(runDir, "plan", { steps: [], approach: "x", allowed_paths: ["src/**"] });
    const text = await readArtifact(runDir, a);
    assert.equal(JSON.parse(text).body.approach, "x");

    const file = join(runDir, a.path);
    const original = await readFile(file, "utf8");
    await writeFile(file, original.replace('"src/**"', '"**"')); //   the agent widens its own scope
    await rejects(readArtifact(runDir, a), /does not match its recorded hash/);
    await writeFile(file, "not json");
    await rejects(readArtifact(runDir, a), /not valid JSON/);
    await writeFile(file, original);
    assert.equal(await readArtifact(runDir, a), text, "restored bytes read back again");

    await rejects(readArtifact(runDir, { ...a, path: "artifacts/absent.json" }), /ENOENT/);
    await rejects(readArtifact(runDir, { ...a, path: "../outside.json" }), /escapes the run dir/);

    // re-admitting the same content heals the file (content-addressed overwrite)
    await writeFile(file, "{}");
    await mustAdmit(runDir, "plan", { steps: [], approach: "x", allowed_paths: ["src/**"] });
    assert.equal(await readArtifact(runDir, a), text);
  });
});

test("renderMarkdown derives a view from canonical JSON", () => {
  const md = renderMarkdown("plan", envelope("plan", { approach: "do it", allowed_paths: ["src/**"], steps: [{ n: 1 }] }));
  assert.match(md, /^# plan\n\nT-1 · r_1 · attempt 1\n/);
  assert.match(md, /## approach\n\ndo it\n/);
  assert.match(md, /## allowed_paths\n\n- src\/\*\*\n/);
  assert.match(md, /- \*\*n\*\*: 1/);
});

test("schema: inherited object keys do not satisfy required or additionalProperties", async () => {
  await withTmp(async (runDir) => {
    const doc = JSON.parse(envelope("plan", { steps: [], approach: "a", allowed_paths: [] })) as Record<string, unknown>;
    const extra = await problemsOf(runDir, "plan", `{"constructor":1,"toString":2,${JSON.stringify(doc).slice(1)}`);
    assert.deepEqual(extra, ["$.constructor: is not allowed", "$.toString: is not allowed"]);
    const { body: _body, ...noBody } = doc;
    assert.ok((await problemsOf(runDir, "plan", JSON.stringify(noBody))).includes("$.body: is required"));
  });
});

test("schema: locked roots must be canonical repo-relative paths, so hashLocked and inspectMaterialized agree", async () => {
  await withTmp(async (runDir) => {
    for (const root of ["./tests", "tests//x", ".", "../x", "/abs", "tests/", "a/./b", ""]) {
      const problems = await problemsOf(runDir, "acceptance", envelope("acceptance", { checks: [check()], locked_roots: [{ repo: "app", root }] }));
      assert.equal(problems.length, 1, `root ${JSON.stringify(root)}`);
      assert.match(problems[0]!, /\$\.body\.locked_roots\[0\]\.root: (must match|must not be shorter)/);
    }
  });
});
