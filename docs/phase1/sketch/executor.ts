/**
 * executor.ts — the thin effect executor. @layer shell.
 *
 * Stateless w.r.t. tickets: it receives EffectRequests, performs them, returns
 * Outcomes. Its only memory is in-process (running promises, abort controllers) and is rebuilt
 * from `state.inflight` by the engine's recovery pass. Leases are NOT its concern: they are
 * allocated by decide() and folded into World; the executor just carries `req.lease` through.
 *
 * Every effect kind has exactly one Handler = { run, recover }:
 *
 *   run(req, ctx)   Performs the effect and reports ONE Outcome. Idempotent per req.key: called a second
 *                   time for a key that already started or finished, it ADOPTS what is there (attach to a live
 *                   process tree, re-derive the result from the footprint, converge a remote) instead of acting twice.
 *                   It NEVER trusts a stored verdict toward acceptance: a footprint may say "rejected", never "accepted".
 *   recover         REQUIRED. How the executor treats a request that a PREVIOUS process incarnation may have
 *                   started (mode "recovery"). Either
 *                     "rerun"        run() is safe from scratch whatever happened (it cleans up first),
 *                     probe(req)     inspects the footprint and answers:
 *                        "done"      the footprint proves the effect took place or is live and owned by this key:
 *                                    run() will ADOPT it (re-seal what exists / attach / converge) and start nothing new
 *                        "absent"    provably nothing was started: run() starts fresh
 *                        "unknown"   something MAY be running or half-done and the footprint cannot say:
 *                                    the executor does NOT call run(); it reports {tag:"ambiguous"} and decide()
 *                                    raises needs_human. Never a guess.
 *
 * `recover` is a required property of `Handler<K>`, and `HandlerTable` is a mapped type over EffectKind:
 * a new effect kind without a recovery policy does not compile. Policies in this design:
 *
 *   run.prepare  probe    manifest.json present -> done; worktree at another sha -> unknown; else absent
 *   attempt      probe    `claim` present -> done (proc.inspect decides inside run: alive = attach, exited = re-seal,
 *                         dead = reap + `interrupted`); no claim -> absent. Never "unknown": a kernel lock has no gap
 *   verify       "rerun"  run reaps the slot's predecessor tree (proc.reap), then `down -v` of the slot-named project;
 *                         a teardown that cannot complete, or a tree that will not die, carries a Taint on the environment
 *   publish      probe    branch/MR agree with spec -> done; none -> absent; foreign sha or >1 MR -> unknown
 *   forge.wait   "rerun"  read-only polling
 */
import type { AbsPath, EffectKey } from "./ids";
import type { EffectKind, EffectRequest, EffectSpec, Outcome, Signal } from "./effects";

export type DispatchMode = "first" | "recovery";

export interface Executor {
  /**
   * Resolves with exactly one Outcome for req.key.
   *  - mode "first": handler.run(req).
   *  - mode "recovery": apply handler.recover as documented above, then run() unless it said "unknown".
   *  - deadline (when req.timeoutMs != null): measured from the handler's durable start marker; on expiry the handler
   *    stops the work (proc.reap) and resolves {tag:"timed_out"}.
   *  - never rejects: handler exceptions become {tag:"crashed"} (or "ambiguous" when the footprint cannot say).
   * Concurrent calls with the same key share one in-flight promise.
   */
  run(req: EffectRequest, mode: DispatchMode): Promise<Outcome>;

  /** Stop a running effect (proc.reap for process-backed kinds); its pending run() then resolves {tag:"cancelled"}. No-op if unknown/finished. */
  cancel(key: EffectKey): Promise<void>;

  /**
   * `ark emit` authentication. Each attempt's wrapper is given a secret token (env ARK_EMIT_TOKEN, also stored in
   * the control dir, never in the ledger); emit presents it. A token is valid only for ITS key and only while that
   * attempt's tree is alive.
   */
  emitTokenValid(key: EffectKey, token: string): Promise<boolean>;

  /** True iff `pid` is inside the process group of a live attempt/verify tree. Used by the API to refuse human commands from agents. */
  isAgentProcess(pid: number): Promise<boolean>;
}

export interface HandlerContext {
  readonly runsRoot: AbsPath;
  /** Feed live signals to the engine (observation only). */
  readonly observe: (key: EffectKey, signal: Signal) => void;
  readonly signal: AbortSignal; // aborted by cancel()
}

type SpecOf<K extends EffectKind> = Extract<EffectSpec, { kind: K }>;

export type Probe = "done" | "absent" | "unknown";
export type Recovery<K extends EffectKind> =
  | "rerun"
  | ((req: EffectRequest<SpecOf<K>>, ctx: HandlerContext) => Promise<Probe>);

export interface Handler<K extends EffectKind> {
  run(req: EffectRequest<SpecOf<K>>, ctx: HandlerContext): Promise<Outcome>;
  /** REQUIRED. Omitting it is a compile error; there is no default. */
  readonly recover: Recovery<K>;
}

/** Mapped over EffectKind: adding a kind without a handler (and so without a recovery policy) is a compile error. */
export type HandlerTable = { readonly [K in EffectKind]: Handler<K> };

export function createExecutor(handlers: HandlerTable, ctx: Omit<HandlerContext, "signal">): Executor {
  throw new Error("not implemented");
}
