/**
 * attempt.ts — the `attempt` effect handler, harness adapters, and the SEAL. @layer shell.
 *
 * THE SEAL is the single boundary for everything that can reject an agent attempt:
 * output present, git control surface untouched, schema valid and admissible (admit), diff paths within
 * allowedPaths, locked checks byte-identical with nothing added under their roots, evidence untouched, head
 * descends from baseHead, declared files exist. decide() never re-checks any of it; it only sees "produced" or
 * "rejected".
 *
 * ---------------------------------------------------------------- HarnessAdapter
 * A harness is a PURE DESCRIPTION. Launch, detach, reattach, SIGTERM, deadlines and
 * transcript capture are identical for every CLI harness (S1: both Claude Code and OMP are
 * "spawn argv in cwd, JSONL on stdout, exit status, SIGTERM kills the tree"), so they live
 * once, in proc.ts and this handler. Adding a harness = one object below + registering it in
 * HARNESSES; no lifecycle code, no interface with five methods.
 */
import type { AbsPath, HarnessId, ModelId } from "./ids";
import type { AttemptSpec, EffectRequest, Outcome, Signal, Usage } from "./effects";
import type { Handler, HandlerContext, Probe } from "./executor";

export interface Invocation {
  readonly argv: readonly string[]; //            e.g. ["claude","-p",prompt,"--output-format","stream-json","--verbose",
  //                                                    "--permission-mode","bypassPermissions","--model",model,"--strict-mcp-config", ...]
  readonly env: Readonly<Record<string, string>>;
  /** Hash input for RoleBinding.configHash: flags + settings the adapter pins (S1 finding 2). */
  readonly configFingerprint: string;
}

export interface HarnessAdapter {
  readonly id: HarnessId;
  /** Always passes --model explicitly (S1 finding 3) and pins config so the manifest explains the run. */
  invocation(input: { readonly prompt: string; readonly model: ModelId; readonly workdir: AbsPath }): Invocation;
  /** One transcript line -> zero or more observation signals. Never throws; unknown lines -> []. */
  parseLine(line: string): readonly Signal[];
  /** Whole-transcript usage: Claude Code reads result.total_cost_usd, OMP sums per-message usage. null = unknown. */
  usage(transcript: readonly string[]): Usage | null;
}

/**
 * The PRODUCTION harnesses: claude-code, omp. Role files can only select ids from the table the composition root
 * passes to `makeAttemptHandler`; tests pass their own table (with a `scripted` shell-script harness) so a test
 * double can never be selected by an environment's role file.
 */
export declare const HARNESSES: Readonly<Record<string, HarnessAdapter>>;

// ---------------------------------------------------------------- the handler

/**
 * Two directories per effect, both outside the worktree:
 *   out dir  `<run dir>/out/<key-dir>/`   output.json — the ONLY path the agent is told. Untrusted input to the seal.
 *   ctl dir  `<run dir>/.ctl/<key-dir>/`  proc.ts control files (claim, abandoned, exit, transcript.jsonl), the
 *                                         git fingerprint taken before launch, `rejected.json`, the emit token.
 *                                         Not told to the agent. Not protected from it either; see proc.ts.
 *
 * THE RULE: no file in either directory is ever believed toward ACCEPTANCE. There is no stored "produced" outcome to
 * adopt. Every adoption re-runs the seal, which is a pure function of (output.json, git objects, the spec's Guard).
 * The one marker that is believed, `rejected.json`, can only push toward rejection (forging it costs the forger a retry).
 *
 * RECOVERY POLICY: probe. `claim` present -> "done", else "absent". All the cases are decided inside run by proc.inspect:
 *   absent -> fresh start
 *   alive  -> ATTACH: tail transcript from line 0 (observation ids dedupe), wait for `exit` or deadline
 *   exited -> seal()
 *   dead   -> reap (confirm clean, else outcome ambiguous), reset the worktree, outcome {tag:"interrupted"}; decide
 *             retries from baseHead
 * There is no "unknown" for attempts: a kernel lock has no spawn-to-pid window.
 *
 * RUN, fresh start
 *   1. git reset --hard baseHead && git clean -fd   (worktree is ark-owned; every attempt starts from baseHead)
 *   2. take gitFingerprint(worktree) into ctl; generate the emit token into ctl
 *   3. proc.launch: claim (O_EXCL), wrapper detached, harness argv with env ARK_EFFECT_KEY, ARK_EMIT_TOKEN,
 *      ARK_OUT=<out dir>
 *   Deadline (timeoutMs from the claim's mtime): proc.reap, outcome {tag:"timed_out"} (worktree reset). cancel(): same, {tag:"cancelled"}.
 *
 * WORKDIR     write attempts run in the ticket worktree (one writer stage at a time: parsePipeline forbids writing
 *             fan-outs). Read-only attempts (guard.allowedPaths empty: reviewers, lead, QE, analyst, planner) run in a
 *             PRIVATE detached worktree `<ctl dir>/wt` at baseHead (`git worktree add --detach`, idempotent), so
 *             concurrent siblings can never contaminate each other's seal. That worktree is REMOVED
 *             (`git worktree remove --force`) once the outcome has been returned, on every path including crash recovery.
 * The engine never reads a worktree for state; the worktree is a product of effects, not a record.
 */
export declare function makeAttemptHandler(harnesses: Readonly<Record<string, HarnessAdapter>>): Handler<"attempt">;

export function probeAttempt(req: EffectRequest<AttemptSpec>, ctx: HandlerContext): Promise<Probe> {
  throw new Error("not implemented");
}

export function runAttempt(req: EffectRequest<AttemptSpec>, ctx: HandlerContext): Promise<Outcome> {
  throw new Error("not implemented");
}

/**
 * seal(): runs once per finished process, and AGAIN on every adoption (it is idempotent: committing a clean tree is
 * a no-op, every other step reads git objects). Order matters (cheapest, most diagnostic first):
 *   0. proc.reap(ctl) FIRST. Whatever still lives in the tree (OMP backgrounds jobs, S1) is killed before anything is
 *      read, so nothing can write, commit, or call `ark` after the seal. "stuck" -> {tag:"ambiguous"}.
 *   1. exit != 0                          -> crashed (no artifact considered)
 *   2. read out/output.json               -> else rejected(missing_output)
 *   3. git control surface: gitFingerprint(worktree) != the pre-launch fingerprint, or ANY `.gitattributes` path in the
 *      diff                               -> rejected(git_tampered). Then commit the dirty tree as "ark: <role> attempt <n>"
 *      (git.ts flags: no hooks, no fsmonitor, no external attributes) so headAfter always names the work
 *   4. git merge-base --is-ancestor baseHead headAfter   -> else rejected(head_rewritten)
 *   5. git diff --no-renames --name-only -z baseHead headAfter; every path must match some guard.allowedPaths
 *                                          -> else rejected(path_outside_allowed)   [guard.ts#pathsOutside]
 *      (--no-renames: a move out of scope into scope lists BOTH paths, so the source is checked too)
 *   6. guard.locked: for each LockSet, guard.inspectLocks(headAfter)
 *                                          -> changed/missing => rejected(locked_check_modified)
 *                                             added          => rejected(locked_root_added)
 *   7. guard.evidence (QE): recompute the SHA256SUMS digest and verify every listed file
 *                                          -> else rejected(evidence_modified)
 *   8. admit(runDir, spec.out, raw, ctx) where ctx = { head: headAfter,
 *        artifacts: the CURRENT recorded inputs from spec.inputs, fan: spec.fanInputs, evidenceExists: file check under
 *        the run dir, pin: roots -> guard.hashLocked per repo at headAfter }
 *                                          -> problems => rejected(schema) (schema errors + admissible problems);
 *                                             unmeasurable pinned root => rejected(declared_file_missing)
 *   9. return {produced, usage}. NOTHING is written that a later adoption would trust.
 * ANY rejection: write ctl/rejected.json (reason; believed only toward rejection), then
 * `git reset --hard baseHead && git clean -fd` BEFORE returning, so a rejected attempt leaves no residue and a retry
 * is a clean start. A re-seal that finds rejected.json returns that rejection without looking at the reset tree.
 * Usage comes from adapter.usage(transcript); null when the harness reported none.
 */
export function seal(req: EffectRequest<AttemptSpec>, ctlDir: AbsPath, outDir: AbsPath): Promise<Outcome> {
  throw new Error("not implemented");
}
