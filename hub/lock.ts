import { createHash } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { arkHome } from "../cli/paths.ts";

/** Who holds the lock: a hub process and the port it listens on. */
export type HubLock = { pid: number; port: number };

/** One lock per Ark repo (the folder that holds `hub/main.ts`), in ARK_HOME. */
const repository = resolve(import.meta.dir, "..");
const lockPath = () =>
  join(arkHome(), `hub-${createHash("sha1").update(repository).digest("hex").slice(0, 12)}.lock`);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The live hub that holds the lock, or null (no lock, damaged lock or a dead pid). Read-only. */
export function runningHub(): HubLock | null {
  try {
    const held = JSON.parse(readFileSync(lockPath(), "utf8")) as HubLock;
    return Number.isInteger(held.pid) && Number.isInteger(held.port) && isAlive(held.pid)
      ? held
      : null;
  } catch {
    return null;
  }
}

/** A lock file that no live hub holds is `stale`; a missing one is `absent`. */
function inspect(): HubLock | "stale" | "absent" {
  try {
    readFileSync(lockPath(), "utf8");
  } catch {
    return "absent";
  }
  return runningHub() ?? "stale";
}

/** The pid written in a mutex or lock file, or null. */
function ownerOf(path: string): number | null {
  try {
    const pid = (JSON.parse(readFileSync(path, "utf8")) as HubLock).pid;
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Removes a mutex whose owner is dead; never one whose owner lives (however long it has held it).
 * Contenders claim the dead owner by an exclusive link, and re-read the owner after claiming, so a
 * successor's mutex is never removed. ponytail: a claimer killed inside this window leaves its
 * claim file and that dead pid's mutex stays; delete `<lock>.reclaim.dead-<pid>` by hand.
 */
function reclaimDeadMutex(mutex: string): void {
  const owner = ownerOf(mutex);
  if (owner === null || isAlive(owner)) return;
  const claim = `${mutex}.dead-${owner}`;
  try {
    linkSync(mutex, claim);
  } catch {
    return;
  }
  try {
    if (ownerOf(mutex) === owner) rmSync(mutex, { force: true });
  } finally {
    rmSync(claim, { force: true });
  }
}

/**
 * Takes the lock for this process and `port`. Returns the holder when another live hub has it.
 * The content is written to a private file and linked into place, so the create is atomic and a
 * reader never sees a half-written lock. A stale lock is removed only under a reclaim mutex
 * (a file linked into place holding the owner's pid), so an old observation can never unlink a replacement another hub installed meanwhile:
 * only mutex holders remove the lock file, and only the owner removes its own live lock.
 */
export function acquireLock(port: number): HubLock | null {
  const path = lockPath();
  const mutex = `${path}.reclaim`;
  mkdirSync(arkHome(), { recursive: true });
  const mine = `${path}.${process.pid}`;
  writeFileSync(mine, JSON.stringify({ pid: process.pid, port }));
  try {
    for (;;) {
      try {
        linkSync(mine, path);
        return null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const seen = inspect();
      if (seen === "absent") continue;
      if (seen !== "stale") return seen;
      try {
        linkSync(mine, mutex);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        reclaimDeadMutex(mutex);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        continue;
      }
      try {
        // Under the mutex nobody else removes the lock, so a stale observation still holds.
        if (inspect() === "stale") rmSync(path, { force: true });
      } finally {
        if (ownerOf(mutex) === process.pid) rmSync(mutex, { force: true });
      }
    }
  } finally {
    rmSync(mine, { force: true });
  }
}

/** Removes the lock when this process holds it. */
export function releaseLock(): void {
  try {
    if ((JSON.parse(readFileSync(lockPath(), "utf8")) as HubLock).pid === process.pid)
      rmSync(lockPath(), { force: true });
  } catch {
    // No lock, or not readable: nothing of ours to remove.
  }
}

export const refusal = (holder: HubLock) =>
  `Ark hub already runs on http://127.0.0.1:${holder.port} (pid ${holder.pid}); this hub did not start.`;
