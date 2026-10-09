/**
 * cli.ts — `ark` command line. @layer shell. A table, no logic, plus the composition root.
 *
 * Each command parses argv into ONE ArkApi call. Exceptions:
 *  - `gate decide` first reads `view(ticket).gate` and echoes `gate.pins` verbatim into the decision.
 *  - `verify --check` submits `verify.requested`, then polls `view().repros` until the repro record appears and
 *    prints its evidence dir. It never runs the verification itself: there is one verify path and it is inside the service.
 *  - `serve` is the composition root and the ONLY file that imports handler modules and the ledger-owning Engine:
 *      1. flock.tryLockExclusive(~/.ark/ark.lock)  — FIRST. Null => print "already running", exit 1, having touched nothing.
 *      2. build the HandlerTable (the single registration site, a literal object keyed by EffectKind):
 *           { "run.prepare": prepareHandler, attempt: makeAttemptHandler(HARNESSES), verify: verifyHandler,
 *             publish: publishHandler, "forge.wait": waitHandler }
 *         and createExecutor(handlers, ...). Tests build their own table (scripted harness) the same way.
 *      3. Engine.start({ ledgerPath, executor, loadEnvironment, clock, newId })   — opens the ledger, runs recovery
 *      4. api.serve(engineApi, socket, executor.isAgentProcess)                   — binds the socket last
 *    The lock is held until the process exits.
 */
import type { ArkApi } from "./api";

export interface Command {
  readonly name: string; //  "env add" | "env unblock" | "ticket new" | "run" | "gate decide" | "resume" | "status" | "verify" | "emit" | "serve"
  readonly usage: string;
  run(argv: readonly string[], api: ArkApi): Promise<number>; // exit code
}

export declare const CLI_COMMANDS: readonly Command[];

export function main(argv: readonly string[]): Promise<number> {
  throw new Error("not implemented");
}
