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
} from "./ids";
import type { ArtifactKind } from "./contracts";

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
  throw new Error("not implemented");
}

/** The legal outcome names of a stage (catalog vocabulary, or GATE_OUTCOME values for gates). */
export function outcomesOf(stage: Stage): readonly string[] {
  throw new Error("not implemented");
}

export type PipelineProblem = { readonly where: string; readonly message: string };

/**
 * Validate a parsed pipeline document (YAML already decoded by the shell) against the document schema AND the
 * environment's resolved role bindings (`roles`), because two engine rules are about write scope, which lives in
 * role files, not in the pipeline document. Called from prepare.ts#loadEnvironment, so "registered" means "valid".
 *  - every stage's role/kind/command/wait exists in `roles` / COMMANDS / WAITS; every `in` kind is produced upstream
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
 */
export function parsePipeline(doc: unknown, roles: Readonly<Record<RoleId, RoleBinding>>): Pipeline | readonly PipelineProblem[] {
  throw new Error("not implemented");
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
