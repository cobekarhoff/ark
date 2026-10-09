/**
 * git.ts — every git invocation ark makes. @layer shell.
 *
 * The unsandboxed agent can edit the repository's own `.git/config`, hooks and `.gitattributes`
 * (decision 44), and git runs configured programs from all three (hooks, `core.fsmonitor`, `filter.*`).
 * So the service NEVER runs bare `git` against a ticket repo. Everything goes through `git()`, which:
 *   - passes `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.attributesFile=/dev/null
 *     -c protocol.ext.allow=never -c diff.external= -c core.pager=cat`
 *   - sets GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=/dev/null, GIT_TERMINAL_PROMPT=0, GIT_OPTIONAL_LOCKS=0
 *   - uses plumbing (`ls-tree`, `diff --no-renames --no-ext-diff --no-textconv`, `merge-base`, `archive`) whenever a
 *     porcelain command would apply filters
 * What this does not stop: an in-tree `.gitattributes` or `.git/config` filter applying to `git add` in the seal's
 * commit step. That is closed by DETECTION: the seal compares a `GitFingerprint` taken before launch and fails with
 * git_tampered on any change, and fails on any `.gitattributes` path in the diff (attempt.ts seal step 3).
 *
 * One module, one set of flags: guard.ts, attempt.ts, forge.ts, prepare.ts and verify.ts all call this and no
 * other child_process git. (A lint rule bans `spawn("git"` elsewhere.)
 */
import type { AbsPath, Sha256 } from "./ids";

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run git in `repoDir` with the hardened flags above. Never throws on a nonzero exit; callers decide. */
export function git(repoDir: AbsPath, args: readonly string[], opts?: { readonly input?: string }): Promise<GitResult> {
  throw new Error("not implemented");
}

/**
 * Hash of the repo's agent-editable git control surface: the common-dir `config`, every file under `hooks/`,
 * `info/attributes`, and the blob hash of every `.gitattributes` in HEAD's tree. Taken by the attempt handler before
 * launch (kept in the effect's control dir) and again by the seal; and by publish before it pushes.
 */
export function gitFingerprint(repoDir: AbsPath): Promise<Sha256> {
  throw new Error("not implemented");
}
