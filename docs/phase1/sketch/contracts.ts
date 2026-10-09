/**
 * contracts.ts — the artifact catalog. @layer core (pure data + pure functions).
 *
 * ONE table, `CATALOG`, owns everything the system knows about an artifact kind:
 * its JSON Schema, its outcome vocabulary (and which outcomes are failed rounds
 * that spend the repair cap), whether it is a claim about the source head, and the
 * pure projections decide() needs so that it never reads an artifact file:
 *
 *   outcomeOf(body)    -> which pipeline edge to take
 *   factsOf(body)      -> the small typed slice of the body that transition logic reads
 *   pinnedRoots(body)  -> repo roots (dirs or files) whose contents get locked at approval
 *   admissible(body, inputs) -> cross-artifact truth (see below)
 *
 * Everything else that used to be a "list of kinds" (pipeline outcome vocabularies,
 * repair-counting rule, schema file names, TS types of facts) is DERIVED from here.
 * Adding an artifact kind = one entry here + one schema file; the mapped types make
 * the build fail until both exist.
 *
 * Schema validation AND `admissible` run exactly once, in shell/admit.ts. Core never
 * sees unvalidated bodies.
 */
import type { Glob, GitSha, RepoId, Sha256 } from "./ids";

export const ARTIFACT_KINDS = [
  "ticket", "analysis", "plan", "acceptance", "build",
  "review_findings", "review", "verification", "qe_report",
  "mr", "ci", "landing",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Outcome vocabulary per kind. A stage producing kind K may only branch on these. */
export interface OutcomeTable {
  ticket: "done";
  analysis: "done";
  plan: "done";
  acceptance: "done";
  /** material_change: the builder asks for a plan amendment (spec §4 "material deviation"); the pipeline routes it to `plan`. */
  build: "done" | "material_change";
  review_findings: "done";
  review: "pass" | "blockers";
  /**
   * pass: every locked check passed on a fresh environment. fail: at least one failed twice.
   * flaky: failed once, passed on a fresh rerun. env_failure: provisioning, teardown, or locked-input mismatch
   * at materialization (the reason is in the bundle). flaky and env_failure never reach QE.
   */
  verification: "pass" | "fail" | "flaky" | "env_failure";
  /**
   * QE's only real choices, given a verification that reached it (`pass` or `fail`):
   *   pass          verification was pass.
   *   defect        verification was fail and QE confirms a defect in the SOURCE (cites a failed check + evidence). Counts repair.
   *   check_invalid verification was fail and QE concludes the CHECK itself is wrong (not the source). Does NOT count
   *                 repair (the builder did nothing wrong); the pipeline sends it to needs_human, since an approved
   *                 check can only change through a human gate (decision 9).
   */
  qe_report: "pass" | "defect" | "check_invalid";
  mr: "opened";
  ci: "pass" | "blockers" | "infra_failure";
  landing: "merged" | "closed";
}
export type OutcomeOf<K extends ArtifactKind> = OutcomeTable[K];

export interface CheckSpec {
  readonly id: string;
  readonly repo: RepoId; //                    owning repo (decision 10)
  /** argv, run from the repo root of the materialized head */
  readonly command: readonly string[];
  readonly timeoutS: number;
  readonly environmentClass: "local-emulator" | "ephemeral";
  /**
   * Rejection-style check ("X must be refused"): passes vacuously when the system is broken for an unrelated
   * reason (S4: both revisions returned 401 until the positive control was added). admissible() requires
   * `positiveControl` for every such check.
   */
  readonly rejectionStyle: boolean;
  /** Id of a check in the same artifact that proves the happy path, or "self" when this command asserts both halves (S4). */
  readonly positiveControl: string | "self" | null;
  /** What this check does NOT establish, e.g. "service-account auth stubbed". Flows into evidence. */
  readonly limitations: readonly string[];
}

/** Typed projection of an artifact body that decide() is allowed to read. */
export interface FactsTable {
  ticket: Record<string, never>;
  analysis: Record<string, never>;
  plan: { readonly allowedPaths: readonly Glob[] };
  acceptance: { readonly checks: readonly CheckSpec[] };
  build: Record<string, never>;
  /** One reviewer's output. The review lead receives ALL of them (the fan slots' artifacts), not "the latest". */
  review_findings: { readonly findingIds: readonly string[] };
  review: { readonly blockerIds: readonly string[] };
  verification: {
    readonly evidenceDir: string; //                 relative to the run dir
    /** sha256 of SHA256SUMS. In the ledger, so evidence rewritten after verify (by QE, or anyone) is detectable. */
    readonly sumsDigest: Sha256;
    readonly failedChecks: readonly string[]; //     ids that failed on both tries (QE defects must cite one)
    readonly limitations: readonly string[]; //      recipe + per-check limitations, as written into environment.json
  };
  qe_report: { readonly defectIds: readonly string[]; readonly sameModelAsBuilder: boolean };
  mr: { readonly iid: number; readonly url: string; readonly branch: string };
  ci: { readonly pipelineId: number; readonly failedJobs: readonly string[] };
  landing: { readonly mergedSha: GitSha | null };
}

export interface LockedFile {
  readonly path: string; // repo-relative
  readonly blob: Sha256; // git blob content hash at the pinned head
}

/**
 * Locked ROOTS plus per-file hashes, per repo. The roots are what the human approved ("everything under
 * tests/acceptance/ and this fixture"); the files are what was there. A file ADDED under a root later
 * (a shadowing fixture) is a violation even though no approved file changed.
 *
 * SCOPE, stated honestly: a lock covers the bytes under its roots and nothing else. A check whose behaviour
 * depends on a file OUTSIDE every root (a parent-directory `conftest.py`, an imported helper module, a
 * `.gitattributes`) is not protected by this mechanism. Mitigations that ARE in the design: (1) the Acceptance
 * Author must list helper and fixture paths as roots (spec §5 acceptance contract) and the human sees them at the
 * gate; (2) the seal rejects any change to a `.gitattributes` or to git config/hooks (attempt.ts); (3) verify hashes
 * the MATERIALIZED files against the lock, not just git objects; (4) `environment.json` records the roots so a
 * reviewer can see what was and was not locked. Closing the rest needs a sandbox (decision 44 parks it).
 */
export interface LockSet {
  readonly repo: RepoId;
  readonly roots: readonly string[]; //  repo-relative dirs or files
  readonly files: readonly LockedFile[]; // every file under the roots at the pinned head
}

export interface PinnedRoot {
  readonly repo: RepoId;
  readonly root: string;
}

declare const admitted: unique symbol;

/**
 * A schema-valid, admissible, hashed, stored artifact as it appears in the ledger.
 * The `admitted` brand is not exported, so the only way to obtain one is `admit()`.
 * Exactly TWO sanctioned casts exist: shell/admit.ts (construction) and shell/ledger.ts
 * `decodeEvent` (rehydrating events that only admit-produced values were ever committed
 * into; it trusts the ledger, it does not validate). NOTHING else parses an artifact out of a file: effect
 * footprints never contain one (attempt.ts re-seals on adoption instead of trusting a stored outcome), and
 * artifact bytes are re-hashed against `hash` on every read (admit.ts#readArtifact). A lint rule bans assertions
 * to RecordedArtifact anywhere else, tests included (fixtures call admit() against a temp dir).
 * Core code treats the type as proof of validity.
 */
export interface RecordedArtifact<K extends ArtifactKind = ArtifactKind> {
  readonly [admitted]: true;
  readonly kind: K;
  readonly hash: Sha256; //                 sha256 of canonical JSON
  readonly path: string; //                 relative to the run dir: artifacts/<hash>.json
  readonly outcome: OutcomeOf<K>;
  readonly facts: FactsTable[K];
  /** Lock sets measured at `head` by admit()'s `pin` callback. Empty except acceptance. */
  readonly pinned: readonly LockSet[];
  /** Primary-repo head at production time. For `headBound` kinds, staleness = `head !== state.run.head`. */
  readonly head: GitSha;
}
export type AnyRecorded = { [K in ArtifactKind]: RecordedArtifact<K> }[ArtifactKind];
export type ArtifactRef = Pick<AnyRecorded, "kind" | "hash" | "path">;

/** Body types are GENERATED from schemas/<kind>.v1.json at build time (json-schema-to-ts). */
export type Body = Readonly<Record<string, unknown>>;

/**
 * What `admissible` may consult. Everything is a value or a pure predicate: the CALLER (the seal, or
 * verify) supplies them, so `admissible` stays a pure function and testable with literals.
 */
export interface AdmitInputs {
  /** Head the artifact is being produced against. */
  readonly head: GitSha;
  /** CURRENT artifacts, one per kind (headBound ones for another head already filtered out by decide). */
  readonly artifacts: Readonly<{ [K in ArtifactKind]?: RecordedArtifact<K> }>;
  /**
   * The outputs of the fan slots of THIS stage visit (the review lead's N `review_findings`), in slot order.
   * Empty for stages without fan-out. This is where "the lead saw every reviewer" is checkable;
   * `artifacts` holds only one per kind and cannot.
   */
  readonly fan: readonly AnyRecorded[];
  /** True iff `rel` (relative to the run dir) exists as a non-empty file. */
  readonly evidenceExists: (rel: string) => boolean;
}

export interface ArtifactDef<K extends ArtifactKind> {
  readonly schemaFile: `schemas/${K}.v1.json`;
  /** `countsRepair: true` = a failed round: taking this outcome spends one unit of the repair cap. */
  readonly outcomes: { readonly [O in OutcomeOf<K>]: { readonly countsRepair: boolean } };
  outcomeOf(body: Body): OutcomeOf<K>;
  factsOf(body: Body): FactsTable[K];
  /**
   * true for artifacts that are CLAIMS ABOUT THE SOURCE (build, review*, verification, qe_report, mr, ci, landing):
   * a new head makes them stale. false for ticket/analysis/plan/acceptance, which stay valid across head moves
   * (the acceptance author's commit advances the head; that must not invalidate the plan).
   * This flag is the whole of "a new source head invalidates review, verification, and CI".
   */
  readonly headBound: boolean;
  /** Roots whose contents get pinned when a gate that `locks` approves this artifact. */
  pinnedRoots(body: Body): readonly PinnedRoot[];
  /**
   * Cross-artifact and semantic truth beyond the schema. Pure over (body, inputs). Returns problems;
   * non-empty => the attempt is rejected(schema) with the problems as feedback, no artifact exists.
   *
   *   acceptance : every rejectionStyle check has a positiveControl ("self" or an id present in the artifact);
   *                every check declares `limitations` (possibly empty); ids unique
   *   qe_report  : verdict pass          requires verification.outcome === "pass" and .head === inputs.head
   *                verdict defect        requires verification.outcome === "fail"; EVERY defect cites a check id in
   *                                      verification.facts.failedChecks AND each evidence path satisfies evidenceExists
   *                                      ("a defect without a failing check and evidence is not a defect")
   *                verdict check_invalid requires verification.outcome === "fail" and a cited failed check
   *                (QE is never offered a verdict for flaky/env_failure: those never reach it)
   *   review     : every blocker id appears in the facts of SOME artifact in `inputs.fan`
   *   others     : []
   * This is the ONLY place these cross-artifact rules exist; decide() does not repeat them.
   */
  admissible(body: Body, inputs: AdmitInputs): readonly string[];
}

export declare const CATALOG: { readonly [K in ArtifactKind]: ArtifactDef<K> };

/** Single derivation of "does this outcome spend the repair cap". decide() calls only this. */
export function countsRepair<K extends ArtifactKind>(kind: K, outcome: OutcomeOf<K>): boolean {
  throw new Error("not implemented");
}
