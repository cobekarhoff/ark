/**
 * proc.ts — detached, lock-guarded process trees: the ONE launch/liveness/reap mechanism. @layer shell.
 *
 * `attempt` (agent harnesses) and `verify` (the verification worker, i.e. docker compose, seed, checks) are both
 * "start a process tree that must survive the service, and be able to tell afterwards whether anything of it is
 * still alive". They share this module; neither has its own process code.
 *
 * Control directory of one effect: `<run dir>/.ctl/<effectDirName(key)>/` (the agent is NOT told this path; the
 * agent is told only `<run dir>/out/<effectDirName(key)>/`). It is not protected from an unsandboxed agent: the
 * design's defence is that NOTHING in it is trusted toward acceptance (attempt.ts re-seals; "markers that can only
 * push toward rejection" are the only ones believed).
 *
 *   claim      created O_EXCL by launch() BEFORE the wrapper is spawned. The wrapper takes an exclusive flock on it
 *              as its very first act and keeps it for the life of the tree (children inherit the fd). Its content,
 *              written after locking, is the wrapper's pid, which is also the process-group id (setsid).
 *   abandoned  written by a recoverer (inspect) before it declares the tree dead; a wrapper that obtains the lock and
 *              finds it exits without launching. This closes the only race: a wrapper that is spawned but not yet
 *              locked when the service dies cannot start the harness after a successor has already decided it is dead.
 *   exit       written by the wrapper when the child exits: `echo $? > exit.tmp; mv exit.tmp exit`.
 *   transcript.jsonl  the child's stdout.
 *
 * States (inspect), decided from the files and ONE non-blocking lock attempt:
 *   absent   no claim: never launched.
 *   alive    lock busy: some process of the tree exists. Attach (attempt) or reap (verify).
 *   exited   lock free and `exit` present: the tree finished; its results can be collected.
 *   dead     lock free, no `exit`: the tree died without reporting (kill -9, reboot) or never started
 *            (`abandoned` is written by this call so that it never will).
 * There is no "unknown": a kernel lock cannot be stale and a pid cannot be reused into it.
 */
import type { AbsPath } from "./ids";

export type ProcState = "absent" | "alive" | "exited" | "dead";

export interface LaunchSpec {
  readonly ctlDir: AbsPath;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: AbsPath;
}

/** Create `claim` (O_EXCL; throws if it exists), spawn the wrapper detached (own session), return once spawned. */
export function launch(spec: LaunchSpec): Promise<void> {
  throw new Error("not implemented");
}

export function inspect(ctlDir: AbsPath): Promise<ProcState> {
  throw new Error("not implemented");
}

/**
 * SIGKILL the whole process group named in `claim`, then confirm the lock was released within a grace period.
 * "clean": nothing of the tree is alive. "stuck": the lock is still held (a descendant called setsid and escaped the
 * group): the caller reports `ambiguous` and the attempt/verify taints, because a writer may still exist.
 * Called (a) by the seal BEFORE it looks at the worktree (OMP backgrounds shell jobs, S1), (b) by recovery of a
 * `dead`/`alive` tree that will not be attached, (c) by verify's recovery before `down -v`.
 */
export function reap(ctlDir: AbsPath): Promise<"clean" | "stuck"> {
  throw new Error("not implemented");
}

/** Exit code from `exit`, or null if absent. */
export function exitCode(ctlDir: AbsPath): Promise<number | null> {
  throw new Error("not implemented");
}

/** Tail `transcript.jsonl` from line 0 (observation ids are `${key}:${line}`, so re-reading is idempotent). */
export function tail(ctlDir: AbsPath, onLine: (line: string, index: number) => void, signal: AbortSignal): Promise<void> {
  throw new Error("not implemented");
}
