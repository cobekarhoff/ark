/**
 * flock.ts — advisory file locks: the one liveness primitive. @layer shell.
 *
 * Used for the service singleton and effect process-tree liveness. The native fs-ext addon supplies flock(2); the
 * process launcher passes the locked descriptor to the shell, whose descendants inherit it. The kernel releases it
 * when the last holder dies, including SIGKILL. No pid-file or directory-lock fallback.
 */


import { open } from "node:fs/promises";
import { createRequire } from "node:module";
import { flockSync } from "fs-ext";
import type { AbsPath } from "../core/ids.ts";

export interface HeldLock {
  /** Releases explicitly; resolves once the lock is really free. Process death releases it too. */
  release(): Promise<void>;
}

/** Locks `argv[0]` (created if absent) without blocking, then holds it until the process exits. */
const LOCK_EXEC = String.raw`
import { closeSync, existsSync, openSync, ftruncateSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const { flockSync } = createRequire(${JSON.stringify(import.meta.url)})("fs-ext");
const [claim, abandoned, ...command] = process.argv.slice(1);
let fd;
try {
  fd = openSync(claim, "r+");
  flockSync(fd, "exnb");
} catch (error) {
  if (error.code === "EWOULDBLOCK" || error.code === "EAGAIN") process.exit(75);
  process.exit(71);
}
if (existsSync(abandoned)) process.exit(76);
ftruncateSync(fd, 0);
writeSync(fd, String(process.pid) + "\n");
try {
  const child = spawn(command[0], command.slice(1), { stdio: ["ignore", "ignore", "ignore", fd] });
  child.once("error", () => process.exit(72));
  child.once("close", () => closeSync(fd));
} catch {
  process.exit(72);
}
`;

/** argv that starts `command` after locking `claim`, passing the locked descriptor to its process tree. */
export const lockThenSpawn = (claim: AbsPath, abandoned: AbsPath, command: readonly string[]): string[] =>
  [process.execPath, "--input-type=module", "-e", LOCK_EXEC, "--", claim, abandoned, ...command];

/** Non-blocking exclusive lock; null if someone holds it. Creates the file if absent. */
export async function tryLockExclusive(path: AbsPath): Promise<HeldLock | null> {
  const file = await open(path, "a+");
  try {
    flockSync(file.fd, "exnb");
    return { release: () => file.close() };
  } catch (error) {
    await file.close();
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EWOULDBLOCK" || code === "EAGAIN") return null;
    throw new Error(`flock ${path}: ${(error as Error).message}`);

  }
}

/** True iff the lock is currently held by someone else. Takes and immediately drops it to find out. */
export async function isHeld(path: AbsPath): Promise<boolean> {
  const lock = await tryLockExclusive(path);
  if (lock === null) return true;
  await lock.release();
  return false;
}
