/**
 * pipeline.ts — typed pipeline + run manifest. @layer core.
 *
 * `pipeline.yaml` is data. This file defines what the data means after
 * `parsePipeline` has validated it, and `parsePipeline` refuses any file whose
 * graph violates the engine rules (so decide() may trust a Pipeline completely).
 * The validated Pipeline is stored in RunState (from `run.started`), so decide() reads it from state.
 *
 * Stage kinds are CLOSED here: agent | command | gate | wait. A new stage *instance*
 * (a new reviewer fan-out, another gate, another command from COMMANDS) is a yaml
 * edit. A new stage *kind* is a code change and the compiler walks you through every
 * switch (exhaustive `never` checks in decide.ts and executor.ts).
 */
import type {
  AbsPath, GitSha, Glob, HarnessId, ModelId, RepoId, RoleId, Sha256, StageId, EnvId,
} from "./ids.ts";
import { ARTIFACT_KINDS, CATALOG, countsRepair } from "./contracts.ts";
import type { ArtifactKind } from "./contracts.ts";
import { canonicalJson, sha256 } from "./hash.ts";

// ---------------------------------------------------------------- pipeline

export type Target = StageId | "needs_human" | "landed";

export interface AgentStage {
  readonly kind: "agent";
  readonly role: RoleId;
  /**
   * Parallel read-only fan-out before `role` runs as the joiner (local review: N reviewers, then lead).
   * The joiner's inputs are the fan slots' outputs AS A LIST (decide.ts#attemptRequestFor), not a per-kind lookup.
   */
  readonly fanout: { readonly role: RoleId; readonly out: ArtifactKind } | null;
  /** Latest artifacts of these kinds (plus the artifact that triggered the current repair, automatically). */
  readonly in: readonly ArtifactKind[];
  readonly out: ArtifactKind;
}

/** Built-in trusted commands. Value = the artifact kind the command produces. */
export const COMMANDS = {
  "ark.verify": "verification",
  "ark.publish": "mr",
} as const satisfies Record<string, ArtifactKind>;
export type CommandName = keyof typeof COMMANDS;

/** Built-in external status waits. Waits have NO deadline (a merge takes days); they emit heartbeat observations. */
export const WAITS = {
  "gitlab.pipeline": "ci",
  "gitlab.merged": "landing",
} as const satisfies Record<string, ArtifactKind>;
export type WaitName = keyof typeof WAITS;

export interface CommandStage { readonly kind: "command"; readonly run: CommandName }
export interface WaitStage { readonly kind: "wait"; readonly for: WaitName }

export const GATE_DECISIONS = ["approve", "request_changes", "reject"] as const;
export type GateDecision = (typeof GATE_DECISIONS)[number];
/** decision -> outcome name used as a transition key */
export const GATE_OUTCOME = {
  approve: "approved", request_changes: "changes_requested", reject: "rejected",
} as const satisfies Record<GateDecision, string>;

export interface GateStage {
  readonly kind: "gate";
  /** Artifact kinds whose CURRENT hashes the decision records (the decision record of spec §10). */
  readonly approves: readonly ArtifactKind[];
  /**
   * On `approved`, pin the approved artifacts' lock sets into state.run.locks, REPLACING whatever was locked.
   * The role that PRODUCES a kind in `approves` of a locking gate is exempt from the locks (decide.ts#guardFor):
   * it is the author of the locked material; a re-plan must be able to change it, and the gate is what re-locks it.
   */
  readonly locks: boolean;
}

export type Stage = AgentStage | CommandStage | GateStage | WaitStage;

export interface Pipeline {
  readonly version: 1;
  readonly hash: Sha256; //                       of the canonical form; pinned in the manifest
  readonly repairCap: number; //                  shared across review blockers, QE defects, CI blockers
  readonly entry: StageId;
  readonly stages: Readonly<Record<StageId, Stage>>;
  /** stage -> outcome name -> target. Keys are EXACTLY outcomesOf(stage): no missing edge, no extra. */
  readonly transitions: Readonly<Record<StageId, Readonly<Record<string, Target>>>>;
}

/** The artifact kind a stage produces; null for gates (their product is the human decision event). */
export function producesOf(stage: Stage): ArtifactKind | null {
  switch (stage.kind) {
    case "agent": return stage.out;
    case "command": return COMMANDS[stage.run];
    case "wait": return WAITS[stage.for];
    case "gate": return null;
  }
}

/** The legal outcome names of a stage (catalog vocabulary, or GATE_OUTCOME values for gates). */
export function outcomesOf(stage: Stage): readonly string[] {
  const kind = producesOf(stage);
  return kind === null ? Object.values(GATE_OUTCOME) : Object.keys(CATALOG[kind].outcomes);
}

export type PipelineProblem = { readonly where: string; readonly message: string };

/**
 * Validate a parsed pipeline document (YAML already decoded by the shell) against the document schema AND the
 * environment's resolved role bindings (`roles`), because two engine rules are about write scope, which lives in
 * role files, not in the pipeline document. Called from prepare.ts#loadEnvironment, so "registered" means "valid".
 *  - every stage's role/kind/command/wait exists in `roles` / COMMANDS / WAITS; every `in` kind is produced upstream
 *    (on EVERY path from the entry stage)
 *  - transitions cover exactly outcomesOf(stage); targets exist
 *  - ENGINE RULES independent of file content (spec §4):
 *      * a `gate{locks:true}` stage dominates every path to any agent stage whose role has `writes != none`
 *        EXCEPT the roles that produce the gate's approved kinds
 *      * `ark.verify` dominates `ark.publish`, and the locking gate dominates `ark.verify`
 *      * the `ark.verify` stage routes `pass` and `fail` to a stage producing qe_report (QE interprets a red run:
 *        defect, or check_invalid), and `flaky` / `env_failure` to needs_human
 *      * `ark.publish` is reachable only through a `pass` edge of the qe stage (the stage producing qe_report)
 *      * a fanout role has WriteScope "none" (concurrent writers in one worktree are unrepresentable)
 *      * build's `material_change` edge leads to a stage that reaches the locking gate again
 *      * no cycle avoids a repair edge (a loop must pass through an outcome with countsRepair,
 *        or a human gate) — unbounded automatic loops are unrepresentable
 *  - repairCap >= 1
 * Pure graph checks; testable with literal objects.
 *
 * Document shape (the yaml of MODULES §3, decoded): `{ version, repair_cap, entry, stages, transitions }`; stages are
 * `{kind: agent, role, in?, out, fanout?: {role, out}}`, `{kind: command, run}`, `{kind: gate, approves, locks?}`,
 * `{kind: wait, for}`. "Dominates" = removing the dominating stage(s) leaves the dominated stage unreachable from
 * `entry`; several locking gates (or several verify stages) are taken together ("every path passes through one of them").
 * Returns the problems found (never throws on a bad document), or the Pipeline with its `hash` set.
 */
export function parsePipeline(doc: unknown, roles: Readonly<Record<RoleId, RoleBinding>>): Pipeline | readonly PipelineProblem[] {
  const problems: PipelineProblem[] = [];
  const bad = (where: string, message: string): void => { problems.push({ where, message }); };
  if (!isRec(doc)) return [{ where: "", message: "pipeline document must be a mapping" }];

  if (doc.version !== 1) bad("version", "must be 1");
  const repairCap = doc.repair_cap;
  if (typeof repairCap !== "number" || !Number.isInteger(repairCap) || repairCap < 1) bad("repair_cap", "must be an integer >= 1");
  if (!isRec(doc.stages) || Object.keys(doc.stages).length === 0) bad("stages", "must be a non-empty mapping");
  if (!isRec(doc.transitions)) bad("transitions", "must be a mapping");
  if (problems.length > 0) return problems;
  const rawStages = doc.stages as Record<string, unknown>;
  const rawTransitions = doc.transitions as Record<string, unknown>;

  // ---- structure: each stage, the entry, the transition table
  const stages: Record<string, Stage> = {};
  for (const [id, raw] of Object.entries(rawStages)) {
    if (!STAGE_ID.test(id) || RESERVED_STAGE_IDS.includes(id)) bad(`stages.${id}`, "stage id must match [A-Za-z][A-Za-z0-9_-]* and not be 'prepare' or 'repro'");
    const stage = parseStage(`stages.${id}`, raw, roles, bad);
    if (stage) stages[id] = stage;
  }
  const entry = typeof doc.entry === "string" ? doc.entry : "";
  if (!Object.hasOwn(stages, entry)) bad("entry", `${JSON.stringify(doc.entry)} is not a stage`);
  const transitions: Record<string, Record<string, string>> = {};
  for (const id of Object.keys(rawTransitions)) if (!Object.hasOwn(rawStages, id)) bad(`transitions.${id}`, "transitions for a stage that does not exist");
  for (const [id, stage] of Object.entries(stages)) {
    const row = rawTransitions[id];
    if (!isRec(row)) { bad(`transitions.${id}`, "missing transition row"); continue; }
    const want = outcomesOf(stage);
    for (const o of want) if (!Object.hasOwn(row, o)) bad(`transitions.${id}.${o}`, `missing outcome edge (stage ${id} can produce ${o})`);
    transitions[id] = {};
    for (const [o, target] of Object.entries(row)) {
      if (!want.includes(o)) { bad(`transitions.${id}.${o}`, `${o} is not an outcome of stage ${id} (${want.join(", ")})`); continue; }
      if (typeof target !== "string" || !(Object.hasOwn(stages, target) || target === "needs_human" || target === "landed")) { bad(`transitions.${id}.${o}`, `target ${JSON.stringify(target)} is not a stage, needs_human or landed`); continue; }
      transitions[id]![o] = target;
    }
  }
  if (problems.length > 0) return problems;

  graphRules(stages, transitions, entry, roles, bad);
  if (problems.length > 0) return problems;

  const body = { version: 1 as const, repairCap: repairCap as number, entry: entry as StageId, stages, transitions };
  return { ...body, hash: sha256(canonicalJson(body)) } as unknown as Pipeline;
}

const STAGE_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const RESERVED_STAGE_IDS = ["prepare", "repro"];
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isKind = (v: unknown): v is ArtifactKind => (ARTIFACT_KINDS as readonly unknown[]).includes(v);

type Bad = (where: string, message: string) => void;

function parseStage(where: string, raw: unknown, roles: Readonly<Record<RoleId, RoleBinding>>, bad: Bad): Stage | null {
  if (!isRec(raw)) { bad(where, "must be a mapping"); return null; }
  const role = (field: string, v: unknown): RoleBinding | null => {
    const b = typeof v === "string" && Object.hasOwn(roles, v) ? roles[v as RoleId] : undefined;
    if (!b) bad(`${where}.${field}`, `role ${JSON.stringify(v)} is not bound in the environment's roles`);
    return b ?? null;
  };
  const kindList = (field: string, v: unknown): ArtifactKind[] => {
    if (!Array.isArray(v)) { bad(`${where}.${field}`, "must be a list of artifact kinds"); return []; }
    return v.filter((k): k is ArtifactKind => isKind(k) || (bad(`${where}.${field}`, `unknown artifact kind ${JSON.stringify(k)}`), false));
  };
  switch (raw.kind) {
    case "agent": {
      role("role", raw.role);
      const inKinds = raw.in === undefined ? [] : kindList("in", raw.in);
      if (!isKind(raw.out)) bad(`${where}.out`, `unknown artifact kind ${JSON.stringify(raw.out)}`);
      let fanout: AgentStage["fanout"] = null;
      if (raw.fanout !== undefined && raw.fanout !== null) {
        const f = raw.fanout;
        if (!isRec(f) || !isKind(f.out)) bad(`${where}.fanout`, "must be {role, out} with a known artifact kind");
        else {
          const b = role("fanout.role", f.role);
          if (b && b.writes.kind !== "none") bad(`${where}.fanout.role`, `fan-out role ${String(f.role)} must have writes: none (concurrent writers in one worktree are unrepresentable)`);
          fanout = { role: f.role as RoleId, out: f.out };
        }
      }
      return { kind: "agent", role: raw.role as RoleId, fanout, in: inKinds, out: raw.out as ArtifactKind };
    }
    case "command":
      if (typeof raw.run !== "string" || !Object.hasOwn(COMMANDS, raw.run)) { bad(`${where}.run`, `unknown command ${JSON.stringify(raw.run)}`); return null; }
      return { kind: "command", run: raw.run as CommandName };
    case "wait":
      if (typeof raw.for !== "string" || !Object.hasOwn(WAITS, raw.for)) { bad(`${where}.for`, `unknown wait ${JSON.stringify(raw.for)}`); return null; }
      return { kind: "wait", for: raw.for as WaitName };
    case "gate": {
      const approves = kindList("approves", raw.approves);
      if (approves.length === 0) bad(`${where}.approves`, "a gate approves at least one artifact kind");
      if (raw.locks !== undefined && typeof raw.locks !== "boolean") bad(`${where}.locks`, "must be a boolean");
      return { kind: "gate", approves, locks: raw.locks === true };
    }
    default:
      bad(`${where}.kind`, `unknown stage kind ${JSON.stringify(raw.kind)} (agent | command | gate | wait)`);
      return null;
  }
}

/** Reachability-based graph rules over an already structurally valid document. */
function graphRules(
  stages: Readonly<Record<string, Stage>>, transitions: Readonly<Record<string, Readonly<Record<string, string>>>>,
  entry: string, roles: Readonly<Record<RoleId, RoleBinding>>, bad: Bad,
): void {
  const ids = Object.keys(stages);
  const succ = (s: string): string[] => Object.values(transitions[s] ?? {}).filter((t) => Object.hasOwn(stages, t));
  /** Stages reachable from `from` (default: entry) without passing through `removed`. */
  const reach = (removed: ReadonlySet<string>, from = entry): Set<string> => {
    const seen = new Set<string>();
    const stack = removed.has(from) ? [] : [from];
    for (let s = stack.pop(); s !== undefined; s = stack.pop()) {
      if (seen.has(s)) continue;
      seen.add(s);
      for (const t of succ(s)) if (!removed.has(t)) stack.push(t);
    }
    return seen;
  };
  const where = (kind: Stage["kind"], pred: (s: Stage) => boolean): string[] => ids.filter((id) => stages[id]!.kind === kind && pred(stages[id]!));
  const commandStages = (run: CommandName): string[] => where("command", (s) => s.kind === "command" && s.run === run);
  const dominated = (by: string[], id: string): boolean => !reach(new Set(by)).has(id);

  // every `in` kind is produced upstream on every path
  for (const id of ids) {
    const s = stages[id]!;
    if (s.kind !== "agent") continue;
    for (const k of s.in) {
      const producers = ids.filter((p) => p !== id && (producesOf(stages[p]!) === k || (stages[p]!.kind === "agent" && (stages[p] as AgentStage).fanout?.out === k)));
      if (!dominated(producers, id)) bad(`stages.${id}.in`, `${k} is not produced on every path to ${id}`);
    }
  }

  // locking gate dominates every non-exempt writing stage
  const lockingGates = where("gate", (s) => s.kind === "gate" && s.locks);
  const lockedKinds = new Set(lockingGates.flatMap((g) => (stages[g] as GateStage).approves));
  const exemptRoles = new Set(ids.flatMap((id) => { const s = stages[id]!; return s.kind === "agent" && lockedKinds.has(s.out) ? [s.role] : []; }));
  for (const id of where("agent", () => true)) {
    const s = stages[id] as AgentStage;
    if (roles[s.role]!.writes.kind === "none" || exemptRoles.has(s.role)) continue;
    if (!dominated(lockingGates, id)) bad(`stages.${id}`, `writing stage ${id} (role ${s.role}) is reachable without passing a gate with locks: true`);
  }

  // verify / publish
  const verifies = commandStages("ark.verify");
  const publishes = commandStages("ark.publish");
  for (const id of publishes) if (!dominated(verifies, id)) bad(`stages.${id}`, `ark.publish is reachable without passing ark.verify`);
  for (const id of verifies) {
    if (!dominated(lockingGates, id)) bad(`stages.${id}`, `ark.verify is reachable without passing a gate with locks: true`);
    for (const o of ["pass", "fail"]) {
      const t = transitions[id]![o]!;
      if (!(Object.hasOwn(stages, t) && producesOf(stages[t]!) === "qe_report")) bad(`transitions.${id}.${o}`, `verify ${o} must route to a stage producing qe_report, not ${t}`);
    }
    for (const o of ["flaky", "env_failure"]) if (transitions[id]![o] !== "needs_human") bad(`transitions.${id}.${o}`, `verify ${o} must route to needs_human`);
  }
  for (const [from, row] of Object.entries(transitions)) for (const [o, t] of Object.entries(row)) {
    if (publishes.includes(t) && !(producesOf(stages[from]!) === "qe_report" && o === "pass")) bad(`transitions.${from}.${o}`, `ark.publish may only be entered through the pass edge of the qe_report stage`);
  }
  if (publishes.includes(entry)) bad("entry", "entry may not be ark.publish");

  // material_change must lead back to the locking gate
  for (const [from, row] of Object.entries(transitions)) {
    const t = row["material_change"];
    if (t !== undefined && !(Object.hasOwn(stages, t) && [...reach(new Set(), t)].some((s) => lockingGates.includes(s)))) {
      bad(`transitions.${from}.material_change`, `material_change must lead to a stage that reaches a gate with locks: true again, not ${t}`);
    }
  }

  // no cycle avoids a repair edge or a gate
  const free = (s: string): string[] => {
    const stage = stages[s]!;
    if (stage.kind === "gate") return [];
    const kind = producesOf(stage)!;
    return Object.entries(transitions[s]!).filter(([o, t]) => Object.hasOwn(stages, t) && !countsRepair(kind, o as never)).map(([, t]) => t);
  };
  const state = new Map<string, 1 | 2>(); // 1 = on the DFS stack, 2 = done
  const cyclic = (s: string): boolean => {
    if (state.get(s) === 2) return false;
    if (state.get(s) === 1) return true;
    state.set(s, 1);
    const hit = free(s).some(cyclic);
    state.set(s, 2);
    return hit;
  };
  const looping = ids.find(cyclic);
  if (looping !== undefined) bad(`stages.${looping}`, "a cycle through this stage passes no repair edge (countsRepair outcome) and no gate");
}

// ---------------------------------------------------------------- manifest

/** What a role may write. Closed; resolved to globs by decide()'s guardFor from recorded facts. */
export type WriteScope =
  | { readonly kind: "none" } //                          read-only roles: reviewers, lead, QE, analyst, planner
  | { readonly kind: "plan.allowedPaths" } //             builder: the approved plan's allowed_paths
  | { readonly kind: "globs"; readonly globs: readonly Glob[] }; // acceptance author: where the ENVIRONMENT says checks live

export interface RoleBinding {
  readonly role: RoleId;
  readonly harness: HarnessId;
  readonly model: ModelId;
  /** Hash of the effective harness config (flags, settings, skills dir) — S1 finding 2. */
  readonly configHash: Sha256;
  readonly skills: readonly { readonly name: string; readonly hash: Sha256 }[];
  readonly writes: WriteScope;
  readonly deadlineMs: number;
  /** Retries after rejected/crashed/interrupted attempts (default 2). Timeouts never auto-retry. */
  readonly maxRetries: number;
  /** Fan-out width for fanout roles (reviewers); 1 otherwise. */
  readonly count: number;
}

/**
 * The full revision vector (S4): a sha for the environment repo and for EVERY repo the environment mounts.
 * `env` is the tree the verification environment is MATERIALIZED from; it is a different thing from the
 * environment's CONFIG commit (`RunManifest.env.configCommit`, the commit whose `ark/` was loaded). A historical
 * replay pins `env` to the contemporaneous commit while still running current ark config.
 */
export interface RevisionVector {
  readonly env: GitSha;
  readonly repos: Readonly<Record<RepoId, GitSha>>;
}

/**
 * Per-repo checkout facts. Shas live ONLY in `RunManifest.base` (one place). Only `primary` has a ticket
 * worktree and moves; the rest are pinned read-only inputs of verify.
 */
export interface RepoPin {
  readonly id: RepoId;
  readonly baseBranch: string;
  /** Ticket worktree for the primary repo; null for pins used only by verify. */
  readonly worktree: AbsPath | null;
  readonly branch: string | null;
}

export interface VerifyRecipe {
  readonly envClass: "local-emulator" | "ephemeral";
  /** Environment-repo tasks, argv each. The ENVIRONMENT owns image identity; verify forces run-scoped tags. */
  readonly tasks: { readonly up: readonly string[]; readonly seed: readonly string[]; readonly health: readonly string[]; readonly down: readonly string[] };
  /** Recipe-level limitations ("seed-data pip-installs unpinned boto3", "base images by tag"); merged with each check's. */
  readonly limitations: readonly string[];
  /** Verification slots for this environment (default 1). Slot i owns compose project `ark-<env>-s<i>`. */
  readonly slots: number;
  readonly timeoutMs: number;
}

/** Pinned at run start by run.prepare; immutable afterwards. Credentials never appear here. */
export interface RunManifest {
  readonly arkVersion: string;
  /** `configCommit`: the commit whose `ark/` config was loaded. NOT the commit verify materializes (that is `base.env`). */
  readonly env: { readonly id: EnvId; readonly configCommit: GitSha };
  readonly pipeline: { readonly path: string; readonly hash: Sha256 };
  readonly primary: RepoId;
  /** The base revision vector, resolved from TicketInput.base (defaults: current HEAD of each mounted repo). */
  readonly base: RevisionVector;
  readonly repos: readonly RepoPin[];
  readonly roles: Readonly<Record<RoleId, RoleBinding>>;
  readonly verify: VerifyRecipe;
  /** Always contains "unsandboxed" in Phases 0-1 (decision 44); also same-model QE, stubbed auth, … */
  readonly disclosures: readonly string[];
}
