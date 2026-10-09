/**
 * fixtures.ts — literal values and a tiny driver for the core's replay tests. TEST-ONLY (not imported by shell code).
 *
 * `Sim` is not a mock of anything in ark: it is the engine's loop with the I/O removed. Each `send` is
 * decide(state, inbound, world) followed by folding the inbound and the decision's events into the state and the
 * world, which is exactly what the engine does around ledger.commit. `log` is the resulting event list.
 *
 * `art()` builds a RecordedArtifact literal. Production code can only obtain one from admit() (shell, unit 3),
 * which does not exist yet; this one cast stands in for it and is confined to this file.
 */
import type { AbsPath, EffectKey, EnvId, EventId, GitSha, HarnessId, IsoTime, ModelId, RepoId, RoleId, RunId, Sha256, SlotId, StageId, StreamId, TicketId } from "./ids.ts";
import { effectKey } from "./ids.ts";
import type { AnyRecorded, ArtifactKind, CheckSpec, FactsTable, LockSet, OutcomeOf, RecordedArtifact } from "./contracts.ts";
import type { Decision } from "./decide.ts";
import { decide } from "./decide.ts";
import type { AuthoritativeEvent, Draft, Inbound, TicketEvent } from "./events.ts";
import type { EffectRequest, Outcome, Resource } from "./effects.ts";
import { parsePipeline } from "./pipeline.ts";
import type { Pipeline, RoleBinding, RunManifest } from "./pipeline.ts";
import { emptyState, fold } from "./state.ts";
import type { TicketState } from "./state.ts";
import { emptyWorld, foldWorld } from "./world.ts";
import type { World } from "./world.ts";

export const T1 = "PROJ-1" as TicketId;
export const T2 = "PROJ-2" as TicketId;
export const ENV = "app-env" as EnvId;
export const RESOURCE = `env:${ENV}` as Resource;
export const sha = (s: string): Sha256 => `sha256:${s}` as Sha256;
export const head = (s: string): GitSha => s as GitSha;

// ---------------------------------------------------------------- the default pipeline (MODULES §3), parsed form

export const defaultPipelineDoc = {
  version: 1,
  repair_cap: 3,
  entry: "intake",
  stages: {
    intake: { kind: "agent", role: "intake", out: "ticket" },
    analyze: { kind: "agent", role: "analyst", in: ["ticket"], out: "analysis" },
    plan: { kind: "agent", role: "planner", in: ["ticket", "analysis"], out: "plan" },
    acceptance: { kind: "agent", role: "acceptance-author", in: ["plan"], out: "acceptance" },
    plan_gate: { kind: "gate", approves: ["plan", "acceptance"], locks: true },
    build: { kind: "agent", role: "builder", in: ["plan", "acceptance"], out: "build" },
    review: { kind: "agent", fanout: { role: "reviewer", out: "review_findings" }, role: "review-lead", in: ["build"], out: "review" },
    verify: { kind: "command", run: "ark.verify" },
    qe: { kind: "agent", role: "qe", in: ["verification"], out: "qe_report" },
    publish: { kind: "command", run: "ark.publish" },
    ci: { kind: "wait", for: "gitlab.pipeline" },
    landing: { kind: "wait", for: "gitlab.merged" },
  },
  transitions: {
    intake: { done: "analyze" },
    analyze: { done: "plan" },
    plan: { done: "acceptance" },
    acceptance: { done: "plan_gate" },
    plan_gate: { approved: "build", changes_requested: "plan", rejected: "needs_human" },
    build: { done: "review", material_change: "plan" },
    review: { pass: "verify", blockers: "build" },
    verify: { pass: "qe", fail: "qe", flaky: "needs_human", env_failure: "needs_human" },
    qe: { pass: "publish", defect: "build", check_invalid: "needs_human" },
    publish: { opened: "ci" },
    ci: { pass: "landing", blockers: "build", infra_failure: "needs_human" },
    landing: { merged: "landed", closed: "needs_human" },
  },
};

/** A deep copy of the default document, for tests that mutate it. */
export const cloneDoc = (): typeof defaultPipelineDoc => JSON.parse(JSON.stringify(defaultPipelineDoc));

const role = (name: string, writes: RoleBinding["writes"], extra: Partial<RoleBinding> = {}): [RoleId, RoleBinding] => [
  name as RoleId,
  {
    role: name as RoleId, harness: "claude-code" as HarnessId, model: "model-1" as ModelId, configHash: sha("cfg"),
    skills: [], writes, deadlineMs: 600_000, maxRetries: 2, count: 1, ...extra,
  },
];
const none = { kind: "none" } as const;

export const roles: Readonly<Record<RoleId, RoleBinding>> = Object.fromEntries([
  role("intake", none),
  role("analyst", none),
  role("planner", none),
  role("acceptance-author", { kind: "globs", globs: ["tests/acceptance/**"] as never }),
  role("builder", { kind: "plan.allowedPaths" }),
  role("reviewer", none, { count: 2 }),
  role("review-lead", none),
  role("qe", none),
]);

export function parsed(doc: unknown = defaultPipelineDoc, r: Readonly<Record<RoleId, RoleBinding>> = roles): Pipeline {
  const p = parsePipeline(doc, r);
  if (Array.isArray(p)) throw new Error(`fixture pipeline invalid: ${JSON.stringify(p)}`);
  return p as Pipeline;
}
export const pipeline = parsed();

export function manifestWith(slots = 1, r: Readonly<Record<RoleId, RoleBinding>> = roles): RunManifest {
  return {
    arkVersion: "0.0.0",
    env: { id: ENV, configCommit: head("cfg0") },
    pipeline: { path: "ark/pipeline.yaml", hash: pipeline.hash },
    primary: "app" as RepoId,
    base: { env: head("env0"), repos: { ["app" as RepoId]: head("h0"), ["lib" as RepoId]: head("lib0") } },
    repos: [
      { id: "app" as RepoId, baseBranch: "main", worktree: "/work/app" as AbsPath, branch: "ark/PROJ" },
      { id: "lib" as RepoId, baseBranch: "main", worktree: null, branch: null },
    ],
    roles: r,
    verify: {
      envClass: "local-emulator",
      tasks: { up: ["task", "up"], seed: ["task", "seed"], health: ["task", "health"], down: ["task", "down"] },
      limitations: ["stubbed auth"], slots, timeoutMs: 900_000,
    },
    disclosures: ["unsandboxed"],
  };
}

// ---------------------------------------------------------------- artifacts

let artifactSeq = 0;
export function art<K extends ArtifactKind>(kind: K, outcome: OutcomeOf<K>, facts: FactsTable[K], at: string, pinned: readonly LockSet[] = []): RecordedArtifact<K> {
  const n = ++artifactSeq;
  return { kind, hash: sha(`${kind}-${n}`), path: `artifacts/${kind}-${n}.json`, outcome, facts, pinned, head: head(at) } as unknown as RecordedArtifact<K>;
}

const check = (id: string, over: Partial<CheckSpec> = {}): CheckSpec => ({
  id, repo: "app" as RepoId, command: ["pytest", id], timeoutS: 60, environmentClass: "local-emulator",
  rejectionStyle: false, positiveControl: null, limitations: [], ...over,
});
export const lockSet = (file: string): LockSet => ({ repo: "app" as RepoId, roots: ["tests/acceptance"], files: [{ path: file, blob: sha(`blob-${file}`) }] });

export const A = {
  ticket: (h: string) => art("ticket", "done", {}, h),
  analysis: (h: string) => art("analysis", "done", {}, h),
  plan: (h: string, paths: string[] = ["src/**"]) => art("plan", "done", { allowedPaths: paths as never }, h),
  acceptance: (h: string, file = "tests/acceptance/a.py") => art("acceptance", "done", { checks: [check("acc-1")] }, h, [lockSet(file)]),
  build: (h: string, outcome: OutcomeOf<"build"> = "done") => art("build", outcome, {}, h),
  findings: (h: string, ids: string[] = []) => art("review_findings", "done", { findingIds: ids }, h),
  review: (h: string, blockers: string[] = []) => art("review", blockers.length ? "blockers" : "pass", { blockerIds: blockers }, h),
  verification: (h: string, outcome: OutcomeOf<"verification"> = "pass", failed: string[] = []) =>
    art("verification", outcome, { evidenceDir: "evidence/1", sumsDigest: sha("sums"), failedChecks: failed, limitations: [] }, h),
  qe: (h: string, outcome: OutcomeOf<"qe_report"> = "pass") => art("qe_report", outcome, { defectIds: outcome === "defect" ? ["d1"] : [], sameModelAsBuilder: false }, h),
  mr: (h: string) => art("mr", "opened", { iid: 7, url: "https://forge.example/mr/7", branch: "ark/PROJ" }, h),
  ci: (h: string, outcome: OutcomeOf<"ci"> = "pass") => art("ci", outcome, { pipelineId: 9, failedJobs: outcome === "blockers" ? ["unit"] : [] }, h),
  landing: (h: string, outcome: OutcomeOf<"landing"> = "merged") => art("landing", outcome, { mergedSha: outcome === "merged" ? head("merged0") : null }, h),
};

// ---------------------------------------------------------------- events

const HUMAN: Record<string, true> = { "ticket.created": true, "run.requested": true, "gate.decided": true, "human.resolved": true, "verify.requested": true };
let eventSeq = 0;

/** Build an event literal. `id` defaults to a fresh `ev<N>`; pass one to pin `run.requested` (the run id derives from it). */
export function ev<T extends TicketEvent["type"]>(ticket: TicketId, type: T, data: Extract<TicketEvent, { type: T }>["data"], id?: string): Draft<Extract<TicketEvent, { type: T }>> {
  const n = ++eventSeq;
  return {
    id: (id ?? `ev${n}`) as EventId, v: 1, ts: `2026-01-01T00:00:${String(n % 60).padStart(2, "0")}Z` as IsoTime,
    stream: `ticket:${ticket}` as StreamId, type, data, authority: "authoritative", source: HUMAN[type] ? "human" : "orchestrator",
  } as unknown as Draft<Extract<TicketEvent, { type: T }>>;
}

export const keyOf = (ticket: TicketId, run: string, stage: string, visit: number, slot = "main", n = 1): EffectKey =>
  effectKey({ ticket, run: run as RunId, stage: stage as StageId, visit, slot: slot as SlotId, n });

// ---------------------------------------------------------------- the driver

export interface WorldRef { world: World }
export const sharedWorld = (): WorldRef => ({ world: emptyWorld() });

export interface Sim {
  readonly ticket: TicketId;
  readonly log: Draft<TicketEvent>[];
  readonly state: TicketState;
  readonly world: World;
  readonly manifest: RunManifest;
  send<T extends Inbound["type"]>(type: T, data: Extract<Inbound, { type: T }>["data"]): Decision;
  /** Fold an event that some other decision already produced (no decide). */
  append(event: Draft<TicketEvent>): void;
  /** World-stream events (env.registered, resource.cleared). */
  worldEvent(event: Draft<AuthoritativeEvent>): void;
  pending(): EffectRequest[];
  settle(key: EffectKey, outcome: Outcome): Decision;
  /** Settle the in-flight request this artifact belongs to as `produced`. */
  produce(artifact: AnyRecorded, o?: { slot?: string; taint?: Outcome["taint"] }): Decision;
  approve(): Decision;
}

export function sim(o: { ticket?: TicketId; world?: WorldRef; slots?: number; roles?: Readonly<Record<RoleId, RoleBinding>> } = {}): Sim {
  const ticket = o.ticket ?? T1;
  const w = o.world ?? sharedWorld();
  const log: Draft<TicketEvent>[] = [];
  let state = emptyState(ticket);
  const append = (e: Draft<TicketEvent>): void => { log.push(e); state = fold(state, e); w.world = foldWorld(w.world, e); };
  const self: Sim = {
    ticket, log, manifest: manifestWith(o.slots ?? 1, o.roles ?? roles),
    get state() { return state; },
    get world() { return w.world; },
    send(type, data) {
      const inbound = ev(ticket, type, data as never) as Draft<Inbound>;
      const d = decide(state, inbound, w.world);
      if (!d.refusal) for (const e of [inbound, ...d.events]) append(e);
      return d;
    },
    append,
    worldEvent(e) { w.world = foldWorld(w.world, e); },
    pending() {
      const run = state.run;
      return run ? Object.values(run.inflight) : state.prepare?.inflight ? [state.prepare.inflight] : [];
    },
    settle: (key, outcome) => self.send("effect.settled", { ticket, key, outcome }),
    produce(artifact, opts = {}) {
      const hit = self.pending().find((r) => {
        const s = r.spec;
        return s.kind === "attempt" ? s.out === artifact.kind && (!opts.slot || s.slot === opts.slot)
          : s.kind === "verify" ? artifact.kind === "verification" && !s.repro
          : s.kind === "publish" ? artifact.kind === "mr"
          : s.kind === "forge.wait" ? artifact.kind === (s.for === "gitlab.pipeline" ? "ci" : "landing")
          : false;
      });
      if (!hit) throw new Error(`no pending effect produces ${artifact.kind}: ${JSON.stringify(self.pending().map((r) => r.key))}`);
      return self.settle(hit.key, { tag: "produced", artifact, usage: null, ...(opts.taint ? { taint: opts.taint } : {}) });
    },
    approve() {
      const g = state.run!.gate!;
      return self.send("gate.decided", { ticket, gate: g.gate, decision: "approve", pins: g.pins, decider: "engineer", comment: "" });
    },
  };
  return self;
}

// ---------------------------------------------------------------- drive helpers (each leaves the sim waiting on the named stage)

export function registerEnv(s: Sim): void {
  s.worldEvent({ id: "w1" as EventId, v: 1, ts: "2026-01-01T00:00:00Z" as IsoTime, stream: "world" as StreamId, type: "env.registered", authority: "authoritative", source: "human", data: { env: ENV, path: "/envs/app", configHash: sha("env") } });
}
/** env registered, ticket.created, run.requested, prepared: the intake attempt is in flight. */
export function start(s: Sim): void {
  registerEnv(s);
  s.send("ticket.created", { ticket: s.ticket, env: ENV, input: { title: "t", intent: "i", acceptanceHints: [], base: null } });
  s.send("run.requested", { ticket: s.ticket });
  s.settle(s.pending()[0]!.key, { tag: "prepared", manifest: s.manifest, pipeline, head: head("h0") });
}
/** …through acceptance: the plan gate is open. Heads: h0 until the acceptance author commits h1. */
export function toGate(s: Sim): void {
  start(s);
  s.produce(A.ticket("h0"));
  s.produce(A.analysis("h0"));
  s.produce(A.plan("h0"));
  s.produce(A.acceptance("h1"));
}
/** …approved: the builder attempt is in flight on h1. */
export function toBuild(s: Sim): void { toGate(s); s.approve(); }
/** …build produced at `h`: both reviewers are in flight. */
export function toReview(s: Sim, h = "h2"): void { toBuild(s); s.produce(A.build(h)); }
/** …both reviewers done, lead passed: verification is in flight (or waiting). */
export function toVerify(s: Sim, h = "h2"): void {
  toReview(s, h);
  s.produce(A.findings(h, ["f1"]), { slot: "fan:0" });
  s.produce(A.findings(h), { slot: "fan:1" });
  s.produce(A.review(h));
}
/** …through landing (a clean run from toVerify). */
export function finish(s: Sim, h = "h2"): void {
  toVerify(s, h);
  s.produce(A.verification(h));
  s.produce(A.qe(h));
  s.produce(A.mr(h));
  s.produce(A.ci(h));
  s.produce(A.landing(h));
}
/** One failed review round starting from an in-flight build: build at `h`, two findings, lead says blockers. */
export function blockedRound(s: Sim, h: string): Decision {
  s.produce(A.build(h));
  s.produce(A.findings(h, ["f1"]), { slot: "fan:0" });
  s.produce(A.findings(h), { slot: "fan:1" });
  return s.produce(A.review(h, ["f1"]));
}

export const types = (d: Decision): string[] => d.events.map((e) => e.type);
