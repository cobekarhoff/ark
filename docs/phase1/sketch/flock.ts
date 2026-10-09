/**
 * flock.ts — advisory file locks: the one liveness primitive. @layer shell.
 *
 * Used for exactly two things, both "is something alive that holds this?":
 *   1. the service singleton: `serve` holds an exclusive lock on ~/.ark/ark.lock for the life of the process
 *      (cli.ts), taken BEFORE the ledger is opened or recovery runs;
 *   2. effect liveness: a detached wrapper holds an exclusive lock on an effect's `claim` file for the life of its
 *      process tree (proc.ts). The lock fd is inherited by every descendant, so "busy" means SOME process of the
 *      tree is still alive, and the kernel releases it when the last one dies, however it dies (kill -9, reboot).
 *
 * Why not pid files: a pid file needs start-time matching to survive pid reuse and has a window between spawn
 * and write. A kernel lock has neither, and survives service death by construction.
 *
 * Implementation note (an open risk, see RATIONALE): Node has no built-in flock. The implementation needs a
 * native addon (`fs-ext`) or a ~10-line helper (`perl -MFcntl -e 'flock'`, present on macOS). Whichever it is,
 * it is confined to this file.
 */
import type { AbsPath } from "./ids";

export interface HeldLock {
  /** Releases explicitly. Process death releases it too. */
  release(): void;
}

/** Non-blocking exclusive lock; null if someone holds it. Creates the file if absent. */
export function tryLockExclusive(path: AbsPath): HeldLock | null {
  throw new Error("not implemented");
}

/** True iff the lock is currently held by someone else. Takes and immediately drops it to find out. */
export function isHeld(path: AbsPath): boolean {
  throw new Error("not implemented");
}
