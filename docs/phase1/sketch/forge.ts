/**
 * forge.ts — GitLab: the `publish` and `forge.wait` handlers. @layer shell.
 *
 * One forge in Phase 1, so no Forge interface (no speculative seam). The GitLab REST
 * calls are private functions of this file; a second forge would extract the seam from
 * these two handlers, not before.
 *
 * ---------------------------------------------------------------- publish
 * FOOTPRINT   remote branch `ark/<ticket>/<run-short>` at some head + the MR whose source_branch is that branch
 * RECOVERY POLICY: probe. `git ls-remote` (git.ts) + list MRs by source_branch:
 *   branch at spec.head and exactly one MR           -> "done"
 *   no branch and no MR                              -> "absent"
 *   branch at an ancestor of spec.head, 0 or 1 MR    -> "absent" (a repair round republishes: fast-forward)
 *   branch at a foreign sha, or >1 MR                -> "unknown": somebody else wrote our branch
 * RUN         BEFORE pushing, two checks that make the agent-writable surface harmless:
 *               - gitFingerprint(worktree) equals the one recorded at the last sealed attempt (config, hooks, .gitattributes
 *                 unchanged), and the push uses git.ts flags (no hooks);
 *               - guard.evidenceDigest(evidence dir) equals spec.evidence.facts.sumsDigest, else {tag:"ambiguous",
 *                 why:"evidence modified after verify"}; the MR description quotes only digests the ledger holds.
 *             Then converge remote to spec: push if needed (fast-forward only), create MR or update its description to
 *             name spec.head, the evidence digest and the revision vector; admit({mr: iid, url, branch}) -> produced.
 *             "Exactly one MR per ticket" is an invariant of the probe, asserted by the crash test.
 *             Artifact content is read with admit.readArtifact (re-hashed). Ark never merges and never approves.
 *
 * ---------------------------------------------------------------- forge.wait
 * FOOTPRINT   none needed: read-only polling
 * RECOVERY POLICY: "rerun".
 * RUN         NO DEADLINE (request.timeoutMs is null: a human merge takes days, and a deadline that resets on every
 *             restart means nothing). Poll every pollMs; every poll emits a `heartbeat` observation ("pipeline running",
 *             "awaiting merge") so the dashboard shows liveness. Terminal:
 *               gitlab.pipeline: success -> ci:pass
 *                                failed, any job with failure_reason script_failure -> ci:blockers (+ failed job names)
 *                                failed otherwise (runner/system/timeout/stuck) -> ci:infra_failure
 *               gitlab.merged:   merged -> landing:merged ; closed unmerged -> landing:closed
 *             A head mismatch (MR source moved) -> {tag:"ambiguous"}: results for another head are not ours.
 */
import type { Handler } from "./executor";

export declare const publishHandler: Handler<"publish">;
export declare const waitHandler: Handler<"forge.wait">;
