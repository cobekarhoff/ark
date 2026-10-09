/**
 * admit.ts — THE admission boundary for artifacts. @layer shell.
 *
 * Every artifact in the system enters through `admit`: agent output (via seal), the verification
 * bundle, the MR record, CI and landing status. There is no other way to obtain a RecordedArtifact,
 * so "validated against its schema AND admissible against its inputs" is a property of the TYPE.
 * The way back OUT is also one function: `readArtifact` re-hashes bytes against the ledger's hash.
 */
import type { AbsPath } from "./ids";
import type { AdmitInputs, AnyRecorded, ArtifactKind, ArtifactRef, LockSet, PinnedRoot } from "./contracts";

/** Everything admit needs besides the raw bytes. The caller supplies git/file access as functions. */
export interface AdmitContext extends AdmitInputs {
  /**
   * Measure `roots` into lock sets at `head` (guard.hashLocked per repo). seal passes the real one;
   * callers without a worktree (verify, forge) pass `async () => []`. Throws/returns problems -> declared_file_missing.
   */
  readonly pin: (roots: readonly PinnedRoot[]) => Promise<readonly LockSet[]>;
}

export type Admission =
  | { readonly ok: true; readonly artifact: AnyRecorded }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * 1. parse `raw` JSON
 * 2. validate against schemas/<kind>.v1.json (ajv, compiled once) incl. the common envelope
 * 3. CATALOG[kind].admissible(body, ctx): cross-artifact truth. QE `pass` needs a current verification `pass` for
 *    the same head; every QE defect cites a failed check and existing evidence; the review lead's blockers exist in
 *    the fan-out findings; acceptance rejection-style checks carry a positive control and every check declares
 *    limitations. THE ONLY PLACE these rules run.
 * 4. outcome = outcomeOf(body); facts = factsOf(body); pinned = await ctx.pin(pinnedRoots(body)); hash = sha256(canonical JSON)
 * 5. write <runDir>/artifacts/<hash>.json via tmp+rename (content-addressed => idempotent)
 * 6. construct the RecordedArtifact (the single `as AnyRecorded` cast in the codebase besides ledger.decodeEvent)
 * Problems from 2 and 3 are returned together so one retry can fix both.
 */
export function admit(runDir: AbsPath, kind: ArtifactKind, raw: string, ctx: AdmitContext): Promise<Admission> {
  throw new Error("not implemented");
}

/**
 * The only way artifact bytes are read back (engine.readArtifact, publish, attempt prompts): read
 * `<runDir>/<ref.path>`, recompute sha256 of the canonical JSON, and throw unless it equals `ref.hash`.
 * Files under artifacts/ are agent-reachable; the ledger's hash is the authority.
 */
export function readArtifact(runDir: AbsPath, ref: ArtifactRef): Promise<string> {
  throw new Error("not implemented");
}

/** Canonical JSON rendering for views: Markdown is derived from artifacts, never edited. Pure over bytes. */
export function renderMarkdown(kind: ArtifactKind, canonicalJson: string): string {
  throw new Error("not implemented");
}
