/**
 * guard.ts — tamper detection primitives. @layer shell.
 *
 * Each function is the ONLY implementation of its rule. attempt.ts#seal and verify.ts call them; nobody else may
 * decide whether a path is allowed, what a lock set is, whether it was violated, or whether evidence changed.
 * All git reads go through git.ts (hardened flags) and are by object (`git ls-tree`, `git diff --no-renames`),
 * never by working-tree stat.
 */
import type { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { AbsPath, GitSha, Glob, RepoId, Sha256 } from "../core/ids.ts";
import type { LockSet, LockedFile } from "../core/contracts.ts";
import { git, gitBytes } from "./git.ts";

const sha256Of = (bytes: string | Uint8Array): Sha256 => `sha256:${createHash("sha256").update(bytes).digest("hex")}` as Sha256;

/** `**` crosses "/", `*` and `?` do not; dotfiles are ordinary names. Everything else is literal. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/**
 * Paths (repo-relative) that match NO glob in `allowed`. Empty result = within scope. Empty `allowed` = nothing allowed.
 * `changed` MUST come from `changedPaths` (`git diff --no-renames --name-only -z base head`): with rename detection
 * on, a file moved from outside scope into scope lists only its destination and would slip through; with it off, both
 * the deleted source and the added destination are listed and each is checked.
 */
export function pathsOutside(changed: readonly string[], allowed: readonly Glob[]): readonly string[] {
  const res = allowed.map(globToRegExp);
  return changed.filter((p) => !res.some((re) => re.test(p)));
}

/** Every path that differs between two commits, by object, with rename detection and all filters off. */
export async function changedPaths(repoDir: AbsPath, base: GitSha, head: GitSha): Promise<readonly string[]> {
  const r = await git(repoDir, ["diff", "--no-renames", "--no-ext-diff", "--no-textconv", "--name-only", "-z", base, head, "--"]);
  if (r.code !== 0) throw new Error(`git diff ${base}..${head} failed: ${r.stderr.trim()}`);
  return r.stdout.split("\0").filter((p) => p !== "");
}

/** True iff `base` is an ancestor of (or equal to) `head`. False = history was rewritten. */
export async function descendsFrom(repoDir: AbsPath, base: GitSha, head: GitSha): Promise<boolean> {
  const r = await git(repoDir, ["merge-base", "--is-ancestor", base, head]);
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  throw new Error(`git merge-base ${base} ${head} failed: ${r.stderr.trim()}`);
}

/** `cat-file --batch` over `oids`: raw object bytes (no filters), sha256'd. */
async function blobDigests(repoDir: AbsPath, oids: readonly string[]): Promise<Map<string, Sha256>> {
  const digests = new Map<string, Sha256>();
  if (oids.length === 0) return digests;
  const r = await gitBytes(repoDir, ["cat-file", "--batch"], { input: oids.join("\n") + "\n" });
  if (r.code !== 0) throw new Error(`git cat-file failed: ${r.stderr.trim()}`);
  let pos = 0;
  for (const oid of oids) {
    const nl = r.stdout.indexOf(10, pos);
    const [, type, size] = r.stdout.toString("utf8", pos, nl).split(" ");
    if (type !== "blob" || size === undefined) throw new Error(`object ${oid} is not a blob`);
    digests.set(oid, sha256Of(r.stdout.subarray(nl + 1, nl + 1 + Number(size))));
    pos = nl + 1 + Number(size) + 1;
  }
  return digests;
}

/**
 * Build the LockSet for `roots` at `head`: `git ls-tree -r <head> -- <roots>`, every file under every root with
 * its content hash. A root that does not exist at `head` yields no files; the caller (admit's pin callback) turns
 * that into declared_file_missing. Used at artifact admission (acceptance) — the approved set is thus measured
 * once, from git objects, at the head the author produced.
 */
export async function hashLocked(repoDir: AbsPath, repo: RepoId, head: GitSha, roots: readonly string[]): Promise<LockSet> {
  if (roots.length === 0) return { repo, roots: [], files: [] }; // `ls-tree` with no pathspec would list the whole repo
  const r = await git(repoDir, ["--literal-pathspecs", "ls-tree", "-r", "-z", head, "--", ...roots]);
  if (r.code !== 0) throw new Error(`git ls-tree ${head} failed: ${r.stderr.trim()}`);
  const entries: { path: string; oid: string }[] = [];
  for (const rec of r.stdout.split("\0")) {
    const tab = rec.indexOf("\t");
    const [, type, oid] = rec.slice(0, tab).split(" ");
    if (tab > 0 && type === "blob" && oid !== undefined) entries.push({ path: rec.slice(tab + 1), oid });
  }
  const digests = await blobDigests(repoDir, [...new Set(entries.map((e) => e.oid))]);
  const files = entries.map((e): LockedFile => ({ path: e.path, blob: digests.get(e.oid)! })).sort((a, b) => (a.path < b.path ? -1 : 1));
  return { repo, roots: [...roots], files };
}

export type LockViolation =
  | { readonly kind: "changed"; readonly repo: RepoId; readonly path: string }
  | { readonly kind: "missing"; readonly repo: RepoId; readonly path: string } // deleted or renamed away
  | { readonly kind: "added"; readonly repo: RepoId; readonly path: string }; //  new file under an approved root

function compare(approved: LockSet, actual: readonly LockedFile[]): readonly LockViolation[] {
  const now = new Map(actual.map((f) => [f.path, f.blob]));
  const was = new Map(approved.files.map((f) => [f.path, f.blob]));
  const out: LockViolation[] = [];
  for (const [path, blob] of was) {
    const cur = now.get(path);
    if (cur === undefined) out.push({ kind: "missing", repo: approved.repo, path });
    else if (cur !== blob) out.push({ kind: "changed", repo: approved.repo, path });
  }
  for (const path of now.keys()) if (!was.has(path)) out.push({ kind: "added", repo: approved.repo, path });
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Compare git objects at `head` with an approved LockSet: recompute hashLocked(roots) and diff against
 * `approved.files`. changed + missing => "locked_check_modified"; added => "locked_root_added".
 * Caller: seal (every attempt of a role that is not exempt from locks).
 */
export async function inspectLocks(repoDir: AbsPath, head: GitSha, approved: LockSet): Promise<readonly LockViolation[]> {
  return compare(approved, (await hashLocked(repoDir, approved.repo, head, approved.roots)).files);
}

/** Files under `abs` (a file, symlink or directory), as repo-relative paths; symlinks are hashed, never followed. */
async function materialized(base: string, rel: string, out: LockedFile[]): Promise<void> {
  const abs = join(base, rel);
  const st = await lstat(abs).catch(() => null);
  if (st === null) return;
  if (st.isDirectory()) {
    for (const e of await readdir(abs, { withFileTypes: true })) await materialized(base, `${rel}/${e.name}`, out);
  } else if (st.isSymbolicLink()) out.push({ path: rel, blob: sha256Of(await readlink(abs)) });
  else if (st.isFile()) out.push({ path: rel, blob: sha256Of(await readFile(abs)) });
}

/**
 * The same comparison over MATERIALIZED FILES: hash the bytes of every file under `approved.roots` in the clean
 * directory that `git archive` produced, and compare to `approved.files`. verify calls this, not inspectLocks, because
 * verify must check the bytes it is about to EXECUTE (`.gitattributes export-ignore` / `export-subst` can make
 * `git archive` output diverge from the git objects that inspectLocks reads).
 */
export async function inspectMaterialized(dir: AbsPath, approved: LockSet): Promise<readonly LockViolation[]> {
  const files: LockedFile[] = [];
  for (const root of approved.roots) {
    const rel = root.replace(/\/+$/, "");
    if (rel === "" || isAbsolute(rel) || rel.split("/").includes("..")) throw new Error(`invalid locked root: ${JSON.stringify(root)}`);
    await materialized(dir, rel, files);
  }
  return compare(approved, files);
}

/**
 * Digest of an evidence bundle: sha256 of `SHA256SUMS` after verifying that every file it lists hashes to its
 * line. null if any listed file is missing or differs. The ledger stores this digest in verification.facts.sumsDigest;
 * QE's seal and publish both recompute it.
 */
export async function evidenceDigest(evidenceDir: AbsPath): Promise<Sha256 | null> {
  let sums: Buffer;
  try {
    sums = await readFile(join(evidenceDir, "SHA256SUMS"));
  } catch {
    return null;
  }
  for (const line of sums.toString("utf8").split("\n")) {
    if (line === "") continue;
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line); // `sha256sum` format: "<hex>  <path>" (text) or "<hex> *<path>" (binary)
    if (m === null || isAbsolute(m[2]!) || m[2]!.split("/").includes("..")) return null;
    const bytes = await readFile(join(evidenceDir, m[2]!)).catch(() => null);
    if (bytes === null || sha256Of(bytes) !== `sha256:${m[1]}`) return null;
  }
  return sha256Of(sums);
}
