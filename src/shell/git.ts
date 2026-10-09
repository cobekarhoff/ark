/**
 * git.ts — every git invocation ark makes. @layer shell.
 *
 * The unsandboxed agent can edit the repository's own `.git/config`, hooks and `.gitattributes` (decision 44), and
 * git runs configured programs from all three (hooks, `core.fsmonitor`, `filter.*`). So the service NEVER runs bare
 * `git` against a ticket repo. Everything goes through `git()`, which:
 *   - passes `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.attributesFile=/dev/null
 *     -c protocol.ext.allow=never -c diff.external= -c core.pager=cat`
 *   - sets GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=/dev/null, GIT_TERMINAL_PROMPT=0, GIT_OPTIONAL_LOCKS=0
 *   - callers use plumbing (`ls-tree`, `cat-file`, `diff --no-renames --no-ext-diff --no-textconv`, `merge-base`,
 *     `archive`) wherever a porcelain command would apply filters
 * What this does not stop: an in-tree `.gitattributes` or `.git/config` filter applying to `git add` in the seal's
 * commit step. That is closed by DETECTION: the seal compares a `GitFingerprint` taken before launch and fails with
 * git_tampered on any change, and fails on any `.gitattributes` path in the diff (attempt.ts seal step 3).
 *
 * One module, one set of flags: guard.ts, attempt.ts, forge.ts, prepare.ts and verify.ts all call this and no
 * other child_process git. (A lint rule bans `spawn("git"` elsewhere.)
 */
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { env } from "node:process";
import { join, resolve } from "node:path";
import type { AbsPath, Sha256 } from "../core/ids.ts";

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Same as GitResult, but stdout is the raw bytes (`cat-file --batch`, `archive`): utf8 decoding would corrupt them. */
export interface GitBytesResult {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

const HARDEN = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "core.attributesFile=/dev/null",
  "-c", "protocol.ext.allow=never",
  "-c", "diff.external=",
  "-c", "core.pager=cat",
];

/** Variables that would point git at a different repository than `repoDir`. */
const LOCATION_VARS = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_PREFIX",
];

function gitEnv(): Record<string, string | undefined> {
  const e = { ...env };
  for (const k of LOCATION_VARS) delete e[k];
  return { ...e, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

/** The one place a git child process is spawned. Never throws on a nonzero exit; rejects only if git cannot start. */
export function gitBytes(repoDir: AbsPath, args: readonly string[], opts?: { readonly input?: string }): Promise<GitBytesResult> {
  const { promise, resolve, reject } = Promise.withResolvers<GitBytesResult>();
  const p = spawn("git", [...HARDEN, ...args], { cwd: repoDir, env: gitEnv(), stdio: ["pipe", "pipe", "pipe"] });
  const out: Uint8Array[] = [];
  const err: Uint8Array[] = [];
  p.stdout.on("data", (c) => out.push(c));
  p.stderr.on("data", (c) => err.push(c));
  p.on("error", reject);
  p.on("close", (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }));
  p.stdin.on("error", () => {}); // git may exit without reading its input (EPIPE); the exit code is the answer
  p.stdin.end(opts?.input);
  return promise;
}

/** Run git in `repoDir` with the hardened flags above. Never throws on a nonzero exit; callers decide. */
export async function git(repoDir: AbsPath, args: readonly string[], opts?: { readonly input?: string }): Promise<GitResult> {
  const r = await gitBytes(repoDir, args, opts);
  return { code: r.code, stdout: r.stdout.toString("utf8"), stderr: r.stderr };
}

/** Every file under `dir` (relative, "/"-separated), without following symlinks. */
async function walk(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
    const r = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...(await walk(dir, r)));
    else out.push(r);
  }
  return out;
}

const lstatOrNull = (p: string): Promise<{ isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean } | null> => lstat(p).then((s) => s, () => null);

/**
 * Hash of the repo's agent-editable git control surface: the common-dir `config`, every file under `hooks/`,
 * `info/attributes`, and the blob hash of every `.gitattributes` in HEAD's tree. Taken by the attempt handler before
 * launch (kept in the effect's control dir) and again by the seal; and by publish before it pushes.
 * Also covers a linked worktree's own `config.worktree`.
 */
export async function gitFingerprint(repoDir: AbsPath): Promise<Sha256> {
  const dirs = await git(repoDir, ["rev-parse", "--git-common-dir", "--git-dir"]);
  if (dirs.code !== 0) throw new Error(`gitFingerprint: not a git repository: ${dirs.stderr.trim()}`);
  const [common, own] = dirs.stdout.trim().split("\n").map((d) => resolve(repoDir, d));
  if (common === undefined || own === undefined) throw new Error("gitFingerprint: unexpected rev-parse output");

  const entries = new Map<string, string>(); // name -> content digest ("-" = absent)
  // Symlinks are hashed by target, never followed: a dangling or directory-pointing link is tampering to report, not a crash.
  const file = async (name: string, path: string): Promise<void> => {
    const st = await lstatOrNull(path);
    entries.set(name, st === null ? "-" : st.isSymbolicLink() ? `link:${await readlink(path)}` : st.isFile() ? createHash("sha256").update(await readFile(path)).digest("hex") : "dir");
  };
  await file("config", join(common, "config"));
  await file("config.worktree", join(own, "config.worktree"));
  await file("info/attributes", join(common, "info", "attributes"));
  const hooks = await lstatOrNull(join(common, "hooks"));
  if (hooks?.isDirectory()) for (const f of await walk(common, "hooks")) await file(f, join(common, f));
  else await file("hooks", join(common, "hooks")); // absent, or a symlink standing in for the directory

  const tree = await git(repoDir, ["ls-tree", "-r", "-z", "HEAD"]); // nonzero before the first commit: no blobs yet
  if (tree.code === 0) {
    for (const rec of tree.stdout.split("\0")) {
      const tab = rec.indexOf("\t");
      const path = rec.slice(tab + 1);
      if (tab > 0 && (path === ".gitattributes" || path.endsWith("/.gitattributes"))) entries.set(`HEAD:${path}`, rec.slice(0, tab).split(" ")[2] ?? "");
    }
  }

  const h = createHash("sha256");
  for (const name of [...entries.keys()].sort()) h.update(`${name.length}:${name}=${entries.get(name)}\n`);
  return `sha256:${h.digest("hex")}` as Sha256;
}
