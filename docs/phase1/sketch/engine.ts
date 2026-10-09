/**
 * engine.ts — the loop. @layer shell. The ONLY writer of the ledger.
 *
 * It owns no transition logic and no state of its own beyond caches of folded states
 * (TicketState + lastSeq per ticket, one World): memos of folds over the log, droppable at any moment.
 *
 * ONE global serial queue. Every `apply` (human command, executor report, wake-up) runs to completion, including
 * its commit and the cache/World update, before the next begins. There are no per-stream chains. Cross-ticket
 * safety (two tickets never leasing the same verification slot) is therefore a property of this queue, stated once
 * here, and not of the absence of an `await` between two lines of another function. Phase 1 runs one ticket at a
 * time, so the serialization costs nothing. Effects themselves run concurrently: only decide+commit are serialized.
 *
 * One iteration:
 *
 *   inbound  = { id: newId(), ts: clock(), stream, source, ...command }  // engine mints id and ts; no seq yet
 *   state    = cache[ticket].state ?? replay(ledger.read(stream))
 *   d        = decide(state, inbound, world)                            // PURE; chains transitions internally
 *   if d.refusal -> return it, record nothing
 *   batch    = [inbound, ...d.events]                                   // effect.requested are already inside
 *   next     = batch.reduce(fold, state)                                // PURE (same fold decide used)
 *   stored   = ledger.commit({ events: batch, expectLastSeq })          // one txn, fenced; assigns seq
 *   cache[ticket] = { state: next, lastSeq };  world = batch.reduce(foldWorld, world)
 *   for k in d.cancel:         executor.cancel(k)
 *   for r in effectsOf(d):     dispatch(r, "first")                     // AFTER commit, never before
 *   wake(batch)                                                         // see below
 *
 * dispatch(r, mode) = executor.run(r, mode).then(outcome => enqueue(effect.settled{key, outcome}))
 *
 * wake(batch): if the batch contains an effect.settled whose key held a lease, or a resource.cleared, enqueue ONE
 * `resource.released` for the oldest waiter (the ticket whose stage.waitingOn is that resource, FIFO by the seq of
 * its stage.waiting). decide() re-checks availability, so a spurious wake-up is a no-op, a woken waiter that finds the
 * resource taken waits again, and a lost wake-up is repaired by start().
 *
 * Crash windows (all closed by construction):
 *   before commit        : nothing happened; the human/executor retries or the effect reports again
 *   after commit,
 *     before dispatch    : r is in state.inflight -> start()'s recovery pass dispatches it in "recovery" mode
 *   during run()         : handler re-derives truth from the effect footprint (see executor.ts recovery policies)
 *   after run,
 *     before settled commit: the footprint plus a re-seal / re-check yields the result again
 *   after settled commit : r left inflight; its follow-up effects are already in the same batch
 */
import type { AbsPath, EffectKey, EnvId, EventId, TicketId } from "./ids";
import type { Inbound } from "./events";
import type { Refusal } from "./decide";
import type { TicketState, TicketView } from "./state";
import type { Executor } from "./executor";
import type { CrashPoint } from "./ledger";
import type { EnvironmentConfig, EnvConfigProblem } from "./prepare";
import type { Signal, Resource } from "./effects";

export type Receipt =
  | { readonly ok: true; readonly seq: number }
  | { readonly ok: false; readonly refusal: Refusal };

/**
 * What a human may submit: the human-authored inbound events (minus envelope; the engine stamps
 * id/ts/stream/source) plus the one world-level command. `ticket.created`, `run.requested`, `gate.decided`,
 * `human.resolved`, `verify.requested` carry their ticket in `data`.
 */
export type HumanCommand =
  | {
      [T in Extract<Inbound, { source: "human" }>["type"]]: Pick<Extract<Inbound, { type: T }>, "type" | "data">;
    }[Extract<Inbound, { source: "human" }>["type"]]
  | { readonly type: "resource.cleared"; readonly data: { readonly resource: Resource; readonly by: string } };

/** Everything that enters decide(): a human command, an executor report, or a wake-up. The engine adds envelope fields. */
type Incoming =
  | Exclude<HumanCommand, { type: "resource.cleared" }>
  | Pick<Extract<Inbound, { type: "effect.settled" | "resource.released" }>, "type" | "data">;

export interface EngineOptions {
  readonly ledgerPath: AbsPath;
  readonly runsRoot: AbsPath; //                  <env>/.ark/runs
  readonly executor: Executor;
  /**
   * Injected by the composition root (cli.ts `serve`), which is the only importer of prepare.ts: `ark env add` must
   * validate the environment without the engine depending on a handler module.
   */
  readonly loadEnvironment: (path: AbsPath) => Promise<EnvironmentConfig | readonly EnvConfigProblem[]>;
  readonly clock: () => string; //                injected: the only clock in the system; tests pass a counter
  readonly newId: () => EventId; //               injected: ULIDs in production, a counter in tests
  readonly crash?: CrashPoint; //                 test-only; forwarded to openLedger
}

export class Engine {
  /**
   * PRECONDITION: the caller already holds the exclusive process lock (flock.ts on ~/.ark/ark.lock). Engine.start
   * never races another service for the ledger; the epoch fence inside openLedger is only a backstop.
   * Opens the ledger (new epoch), replays every stream into the caches, then RECOVERS:
   *   status "preparing" | "running"  : every key in run.inflight -> dispatch(req, "recovery")
   *   status "needs_human"            : inflight REPRO verifies -> dispatch (a repro after the repair cap is the point
   *                                     of a repro); every other inflight key -> executor.cancel
   *   status "aborted" | "landed"     : every inflight key -> executor.cancel
   *   stage.waitingOn                 : wake it (lost wake-ups repaired)
   * That is all recovery is. There is no recovery state machine and no second code path: "recovery"
   * differs from "first" only in that the executor first consults the handler's declared recovery policy.
   */
  static start(opts: EngineOptions): Promise<Engine> {
    throw new Error("not implemented");
  }

  /** Human commands. Returns the refusal or the committed seq. `resource.cleared` is validated against World and appended to the world stream. */
  submit(cmd: HumanCommand): Promise<Receipt> {
    throw new Error("not implemented");
  }

  /** `ark env add`: loadEnvironment(path) (I/O, injected) then appends env.registered to the world stream. */
  registerEnv(path: AbsPath): Promise<EnvId> {
    throw new Error("not implemented");
  }

  /**
   * Observation ingest (harness telemetry, `ark emit`, heartbeats). Cannot change state; ledger.observe is idempotent.
   * `token` must satisfy executor.emitTokenValid(key, token) or the call is dropped.
   */
  observe(key: EffectKey, token: string, signal: Signal): Promise<void> {
    throw new Error("not implemented");
  }

  list(): readonly TicketView[] {
    throw new Error("not implemented");
  }
  view(ticket: TicketId): TicketView | null {
    throw new Error("not implemented");
  }
  /** Read a stored artifact: admit.readArtifact (re-hashed against the ledger). */
  readArtifact(ticket: TicketId, hash: string): Promise<string> {
    throw new Error("not implemented");
  }
  /** Evidence file under the run's evidence dir; path traversal refused. */
  readEvidence(ticket: TicketId, rel: string): Promise<string> {
    throw new Error("not implemented");
  }

  stop(): Promise<void> {
    throw new Error("not implemented");
  }

  // ------------------------------------------------------------------ private
  /** The iteration described in the header, run on the global serial queue. */
  private apply(ticket: TicketId, incoming: Incoming): Promise<Receipt> {
    throw new Error("not implemented");
  }
  private dispatch(req: Parameters<Executor["run"]>[0], mode: "first" | "recovery"): void {
    throw new Error("not implemented");
  }
  private state(ticket: TicketId): TicketState {
    throw new Error("not implemented");
  }
}
