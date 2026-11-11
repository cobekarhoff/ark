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

/**
 * Takes the lock for this process and `port`. Returns the holder when another live hub has it.
 * The content is written to a private file and linked into place, so the create is atomic and a
 * reader never sees a half-written lock. A lock of a dead pid is taken over.
 */
export function acquireLock(port: number): HubLock | null {
  const path = lockPath();
  mkdirSync(arkHome(), { recursive: true });
  const mine = `${path}.${process.pid}`;
  writeFileSync(mine, JSON.stringify({ pid: process.pid, port }));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(mine, path);
        return null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const holder = runningHub();
      if (holder) return holder;
      rmSync(path, { force: true });
    }
    // Two hubs took over a dead lock at once and the other one won the link.
    return runningHub();
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
