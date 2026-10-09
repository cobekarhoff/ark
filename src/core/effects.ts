/**
 * effects.ts — the contract between the pure core and the effect executor. @layer core.
 *
 * An EffectRequest is SELF-CONTAINED: the executor needs nothing but the request
 * (no ticket state, no ledger reads). decide() builds it from state; the executor
 * performs it and reports exactly one Outcome. Both sides depend on this file and
 * on nothing of each other.
 *
 * Handler contract (see executor.ts): every kind declares a REQUIRED recovery policy and
 * one `run`. `run` is idempotent per req.key; the recovery policy says how the executor
 * treats a request that may already have been started by a previous process incarnation.
 */
import type {
  AbsPath, EffectKey, EnvId, GitSha, Glob, ModelId, HarnessId, RepoId, RoleId, RunId,
  SlotId, TicketId, Sha256,
} from "./ids.ts";
import type { AnyRecorded, ArtifactKind, CheckSpec, LockSet } from "./contracts.ts";
import type { Pipeline, RevisionVector, RunManifest, VerifyRecipe, WaitName } from "./pipeline.ts";

/** A capacity-limited resource. One per agentic environment's verification slots. */
export type Resource = `env:${string}`;

/**
 * A held lease: slot `slot` of `resource`. Allocated by decide() from the folded World (smallest free
 * slot of a non-tainted resource), so leases are state, not an executor-memory semaphore. The slot index
 * names the compose project (`ark-<env>-s<slot>`), which is what lets a successor clean a crashed predecessor.
 */
export interface Lease {
  readonly resource: Resource;
  readonly slot: number;
}

export interface EffectRequest<S extends EffectSpec = EffectSpec> {
  readonly key: EffectKey;
  readonly ticket: TicketId;
  readonly lease: Lease | null;
  /**
   * Measured from the handler's own durable start marker, NOT from request time, so a restart does not reset it.
   * null = no deadline: `forge.wait` (a human merges in GitLab; that takes days). Waits emit heartbeat observations instead.
   */
  readonly timeoutMs: number | null;
  readonly spec: S;
}

// ---------------------------------------------------------------- specs

/**
 * Where the ticket's work starts. Absent => current HEAD of every repo the environment mounts. Present => the
 * named revisions (anything `git rev-parse` resolves: `<sha>~1`), resolved to shas by run.prepare and recorded in
 * the manifest. This is how a historical ticket (the pilot ticket: seven repos at contemporaneous shas) is expressed:
 * `ark ticket new --base env=<sha> --base app=<sha>~1 --base lib=<sha> ...`.
 */
export interface BaseSpec {
  readonly env: string | null;
  readonly repos: Readonly<Record<RepoId, string>>;
}

export interface TicketInput {
  readonly title: string;
  readonly intent: string;
  readonly acceptanceHints: readonly string[];
  readonly base: BaseSpec | null;
}

/**
 * run.prepare: load the environment's ark/ config at its CURRENT commit (-> manifest.env.configCommit), resolve
 * pipeline + role bindings + verify recipe + the base revision vector from ticketInput.base, create the primary
 * repo's worktree and branch at its base sha, write manifest.json. Footprint: <run dir>/manifest.json + worktree.
 */
export interface PrepareSpec {
  readonly kind: "run.prepare";
  readonly env: EnvId;
  readonly runId: RunId;
  readonly ticketInput: TicketInput;
}

/** Workspace policy the seal enforces after the attempt. The ONE definition of tampering. */
export interface Guard {
  /** Globs the attempt may change. Empty = read-only role: ANY diff is a violation. */
  readonly allowedPaths: readonly Glob[];
  /**
   * Lock sets that must be byte-identical, with NO new files under their roots. Empty before plan approval AND
   * empty for the role that authors the locked material (see GateStage.locks).
   */
  readonly locked: readonly LockSet[];
  /**
   * Evidence the attempt must leave untouched (QE reads the verification bundle; it must not edit it):
   * the seal recomputes the digest of SHA256SUMS and every file it lists. null for other roles.
   */
  readonly evidence: { readonly dir: string; readonly sumsDigest: Sha256 } | null;
}

export interface AttemptSpec {
  readonly kind: "attempt";
  readonly role: RoleId;
  readonly slot: SlotId;
  readonly n: number; //                       attempt ordinal within (stage, visit, slot)
  readonly harness: HarnessId;
  readonly model: ModelId;
  readonly repo: RepoId; //                    primary repo
  readonly workdir: AbsPath; //                the ticket worktree
  /** Worktree is hard-reset to this before launch; every retry starts from here. */
  readonly baseHead: GitSha;
  readonly skills: readonly { readonly name: string; readonly hash: string }[];
  /**
   * Current input artifacts IN FULL (kind, outcome, facts, head), not just refs: the seal hands them to
   * admit() so cross-artifact truth (QE vs verification) is checked at the one admission boundary.
   */
  readonly inputs: readonly AnyRecorded[];
  /**
   * Join attempts only: the outputs of ALL fan slots, in slot order (the lead sees every reviewer). Also passed to
   * admit() as AdmitInputs.fan. Empty for everything else.
   */
  readonly fanInputs: readonly AnyRecorded[];
  /** Validation error / tamper report from the previous rejected attempt, if any. */
  readonly feedback: string | null;
  readonly out: ArtifactKind;
  readonly guard: Guard;
}

/**
 * verify: the trusted runner (one handler for BOTH the flow stage and defect repro).
 * `repro` non-null = non-flow run of a single check for `ark verify --check`; the same handler, the same
 * slot lease, a different footprint (evidence/repro-<n>/); its outcome never advances a ticket.
 */
export interface VerifySpec {
  readonly kind: "verify";
  readonly primary: RepoId;
  /** The pinned inputs, all of them: env sha + every repo sha, primary at the ticket head. Recorded in environment.json. */
  readonly vector: RevisionVector;
  readonly checks: readonly CheckSpec[];
  readonly locks: readonly LockSet[]; //       materialized files hashed against these; mismatch/addition => env_failure
  readonly recipe: VerifyRecipe;
  readonly n: number; //                       evidence/<n>/ or evidence/repro-<n>/
  readonly slot: number; //                    == request.lease.slot; compose project `ark-<env>-s<slot>`
  readonly project: string; //                 derived by decide from (env, slot); handlers never compute names
  readonly repro: { readonly check: string } | null;
}

export interface PublishSpec {
  readonly kind: "publish";
  readonly repo: RepoId;
  readonly branch: string;
  readonly baseBranch: string;
  readonly head: GitSha;
  /** Inputs for the MR description; handler reads them via admit.ts#readArtifact (re-hashed). */
  readonly describe: readonly AnyRecorded[];
  /** The verification artifact for exactly this head and vector. publish re-digests the evidence dir against facts.sumsDigest first. */
  readonly evidence: AnyRecorded;
}

export interface WaitSpec {
  readonly kind: "forge.wait";
  readonly for: WaitName;
  readonly mr: { readonly iid: number; readonly branch: string };
  readonly head: GitSha;
  readonly pollMs: number;
}

export type EffectSpec = PrepareSpec | AttemptSpec | VerifySpec | PublishSpec | WaitSpec;
export type EffectKind = EffectSpec["kind"];

// ---------------------------------------------------------------- outcomes

/** One representation of cost: `Usage | null`. null = unknown (decision 39), never zero-by-default. */
export interface Usage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
  readonly basis: "reported" | "estimated";
}

/** Why the seal refused an attempt. All variants are detected at the single seal boundary. */
export type Rejection =
  | { readonly class: "missing_output"; readonly details: readonly string[] }
  | { readonly class: "schema"; readonly details: readonly string[] } //                 schema errors AND admissible() problems
  | { readonly class: "locked_check_modified"; readonly details: readonly string[] } //   changed or deleted approved file
  | { readonly class: "locked_root_added"; readonly details: readonly string[] } //       NEW file under an approved root
  | { readonly class: "path_outside_allowed"; readonly details: readonly string[] }
  | { readonly class: "head_rewritten"; readonly details: readonly string[] } //         baseHead not an ancestor
  | { readonly class: "git_tampered"; readonly details: readonly string[] } //           .git/config, hooks, or any .gitattributes changed
  | { readonly class: "evidence_modified"; readonly details: readonly string[] } //       bundle digest differs from the ledger's
  | { readonly class: "declared_file_missing"; readonly details: readonly string[] };

/**
 * The environment (resource) may hold residue that makes the NEXT run unsafe: a failed teardown, or a
 * recovery that could not prove cleanup. decide() turns a taint into `resource.tainted`; every later
 * verify for that resource waits until a human `resource.cleared`.
 */
export interface Taint {
  readonly resource: Resource;
  readonly reason: string;
}

export type OutcomeBody =
  | { readonly tag: "prepared"; readonly manifest: RunManifest; readonly pipeline: Pipeline; readonly head: GitSha }
  | { readonly tag: "produced"; readonly artifact: AnyRecorded; readonly usage: Usage | null }
  | { readonly tag: "rejected"; readonly reason: Rejection; readonly usage: Usage | null } //  attempt, worktree already reset
  | { readonly tag: "crashed"; readonly detail: string; readonly usage: Usage | null } //      nonzero exit / infra error
  | { readonly tag: "interrupted" } //                       attempt: process tree gone w/o exit status; group reaped; worktree reset
  | { readonly tag: "timed_out" }
  | { readonly tag: "cancelled" }
  | { readonly tag: "ambiguous"; readonly why: string };

/**
 * What an executor reports. Exactly one per effect. Everything an outcome says about artifacts has
 * already passed admit() and (for attempts) the seal. `taint` may accompany ANY body.
 */
export type Outcome = OutcomeBody & { readonly taint?: Taint };

/** Observation emitted while an effect runs. Never changes state (type-level: not a fold input). */
export type Signal =
  | { readonly kind: "lifecycle"; readonly phase: "started" | "progress" | "blocked" | "needs-human" | "done" | "failed"; readonly msg: string | null }
  | { readonly kind: "tool_call"; readonly name: string }
  | { readonly kind: "usage"; readonly usage: Usage }
  | { readonly kind: "heartbeat"; readonly detail: string }; // forge.wait: "pipeline running", "awaiting merge"
