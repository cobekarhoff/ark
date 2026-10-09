/**
 * guard.ts — tamper detection primitives. @layer shell.
 *
 * Each function is the ONLY implementation of its rule. attempt.ts#seal and verify.ts call them; nobody else may
 * decide whether a path is allowed, what a lock set is, whether it was violated, or whether evidence changed.
 * All git reads go through git.ts (hardened flags) and are by object (`git ls-tree`, `git diff --no-renames`),
 * never by working-tree stat.
 */
import type { AbsPath, GitSha, Glob, RepoId, Sha256 } from "./ids";
import type { LockSet } from "./contracts";

/**
 * Paths (repo-relative) that match NO glob in `allowed`. Empty result = within scope. Empty `allowed` = nothing allowed.
 * `changed` MUST come from `git diff --no-renames --name-only -z base head`: with rename detection on, a file moved
 * from outside scope into scope lists only its destination and would slip through; with it off, both the deleted
 * source and the added destination are listed and each is checked.
 */
export function pathsOutside(changed: readonly string[], allowed: readonly Glob[]): readonly string[] {
  throw new Error("not implemented");
}

/**
 * Build the LockSet for `roots` at `head`: `git ls-tree -r <head> -- <roots>`, every file under every root with
 * its blob hash. A root that does not exist at `head` yields no files; the caller (admit's pin callback) turns
 * that into declared_file_missing. Used at artifact admission (acceptance) — the approved set is thus measured
 * once, from git objects, at the head the author produced.
 */
export function hashLocked(repoDir: AbsPath, repo: RepoId, head: GitSha, roots: readonly string[]): Promise<LockSet> {
  throw new Error("not implemented");
}

export type LockViolation =
  | { readonly kind: "changed"; readonly repo: RepoId; readonly path: string }
  | { readonly kind: "missing"; readonly repo: RepoId; readonly path: string } // deleted or renamed away
  | { readonly kind: "added"; readonly repo: RepoId; readonly path: string }; //  new file under an approved root

/**
 * Compare git objects at `head` with an approved LockSet: recompute hashLocked(roots) and diff against
 * `approved.files`. changed + missing => "locked_check_modified"; added => "locked_root_added".
 * Caller: seal (every attempt of a role that is not exempt from locks).
 */
export function inspectLocks(repoDir: AbsPath, head: GitSha, approved: LockSet): Promise<readonly LockViolation[]> {
  throw new Error("not implemented");
}

/**
 * The same comparison over MATERIALIZED FILES: hash the bytes of every file under `approved.roots` in the clean
 * directory that `git archive` produced, and compare to `approved.files`. verify calls this, not inspectLocks, because
 * verify must check the bytes it is about to EXECUTE (`.gitattributes export-ignore` / `export-subst` can make
 * `git archive` output diverge from the git objects that inspectLocks reads).
 */
export function inspectMaterialized(dir: AbsPath, approved: LockSet): Promise<readonly LockViolation[]> {
  throw new Error("not implemented");
}

/**
 * Digest of an evidence bundle: sha256 of `SHA256SUMS` after verifying that every file it lists hashes to its
 * line. null if any listed file is missing or differs. The ledger stores this digest in verification.facts.sumsDigest;
 * QE's seal and publish both recompute it.
 */
export function evidenceDigest(evidenceDir: AbsPath): Promise<Sha256 | null> {
  throw new Error("not implemented");
}
