import { dlopen } from "bun:ffi";
import {
  closeSync,
  constants,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { arkHome } from "../cli/paths.ts";

/** Who holds the lock: a hub process and the port it listens on. */
export type HubLock = { pid: number; port: number };

/** One lock per Ark repo (the folder that holds `hub/main.ts`), in ARK_HOME. */
const repository = resolve(import.meta.dir, "..");
const lockPath = () =>
  join(arkHome(), `hub-${createHash("sha1").update(repository).digest("hex").slice(0, 12)}.lock`);

// The operating system holds the lock: an flock on the open file, released when the process dies, however it dies.
// `LOCK_EX | LOCK_NB` are 2 and 4 on macOS and Linux. Bun's `openSync` does NOT set close-on-exec (`fcntl(F_GETFD)` reads 0),
// so the descriptor is not protected by the flag. No leak was seen through `Bun.spawn` (ARK-T266 K5 and a live
// `git cat-file --batch` child both left the lock free after the hub was killed); a spawn path other than `Bun.spawn` must be checked again.
const LOCK_EXCLUSIVE_NONBLOCKING = 2 | 4;
const { symbols } = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
  flock: { args: ["i32", "i32"], returns: "i32" },
});

/** The lock file, opened for read and write and never truncated. It is never removed: a removed file would split the lock across two inodes. */
export function openLockFile(): number {
  mkdirSync(arkHome(), { recursive: true });
  return openSync(lockPath(), constants.O_RDWR | constants.O_CREAT, 0o600);
}

/** Takes the exclusive flock without waiting. False when another process holds it. */
export function tryFlock(descriptor: number): boolean {
  return symbols.flock(descriptor, LOCK_EXCLUSIVE_NONBLOCKING) === 0;
}

/** Writes this process and `port` into the lock file in one write. */
export function writeHolder(descriptor: number, port: number): void {
  ftruncateSync(descriptor, 0);
  writeSync(descriptor, JSON.stringify({ pid: process.pid, port }), 0);
}

/** True when `pid` is a live process. EPERM means it exists and belongs to another user. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ponytail: a previous hub's JSON stays in the file until the new holder truncates it. A dead pid marks it stale, so the
// contender waits for the new holder's write. A reused pid of a dead hub still passes; a generation token needs a second lock.
function readHolder(): HubLock | null {
  try {
    const held = JSON.parse(readFileSync(lockPath(), "utf8")) as HubLock;
    return Number.isInteger(held.pid) && Number.isInteger(held.port) && isAlive(held.pid)
      ? held
      : null;
  } catch {
    return null;
  }
}

// Kept for the life of the process: closing it, or losing it to the garbage collector, drops the lock.
let heldDescriptor: number | undefined;

/**
 * Takes the lock for this process. Returns the holder when another live hub has it, null when this
 * process now holds it. The holder writes its port only after it listens, so a contender that finds
 * the file empty or half written retries, and takes the lock itself if the holder died before writing.
 */
export function acquireLock(): HubLock | null {
  const descriptor = openLockFile();
  const deadline = Date.now() + 5000;
  for (;;) {
    if (tryFlock(descriptor)) {
      ftruncateSync(descriptor, 0); // A dead holder's JSON must not read as ours.
      heldDescriptor = descriptor;
      return null;
    }
    const holder = readHolder();
    if (holder) {
      closeSync(descriptor);
      return holder;
    }
    if (Date.now() > deadline) {
      closeSync(descriptor);
      throw new Error("another hub holds the lock but has not published its port");
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}

/** Publishes the port of the hub that holds the lock. Call after `acquireLock` returned null. */
export function recordPort(port: number): void {
  if (heldDescriptor === undefined) throw new Error("recordPort needs the lock");
  writeHolder(heldDescriptor, port);
}

export const refusal = (holder: HubLock) =>
  `Ark hub already runs on http://127.0.0.1:${holder.port} (pid ${holder.pid}); this hub did not start.`;
