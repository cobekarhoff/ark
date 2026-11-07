import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { arkHome } from "./paths.ts";

/**
 * One `ark test` at a time per host: a lock directory under $ARK_HOME holds holder.json, and a waiting `ark test`
 * leaves a file in test-waiters/ so `ark chief state` can list it. The lock of an ended pid is taken over.
 */
export type TestLockEntry = { run: string; pid: number; since: string };

const pollMilliseconds = 100;

const lockDirectory = () => join(arkHome(), "test.lock");
const waiterDirectory = () => join(arkHome(), "test-waiters");

/** A pid is alive when signal 0 reaches it; EPERM means it exists under another user. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readEntry(file: string): TestLockEntry | null {
  try {
    const entry = JSON.parse(readFileSync(file, "utf8")) as TestLockEntry;
    return Number.isInteger(entry.pid) && typeof entry.run === "string" ? entry : null;
  } catch {
    return null;
  }
}

/** The host's lock holder and the waiters with a live pid, oldest first. Null holder: no lock, or a holder that ended. */
export function readTestLock(): { holder: TestLockEntry | null; waiters: TestLockEntry[] } {
  const holder = readEntry(join(lockDirectory(), "holder.json"));
  const waiters = existsSync(waiterDirectory())
    ? readdirSync(waiterDirectory())
        .map((name) => readEntry(join(waiterDirectory(), name)))
        .filter((entry): entry is TestLockEntry => entry !== null && alive(entry.pid))
        .sort((a, b) => a.since.localeCompare(b.since))
    : [];
  return { holder: holder && alive(holder.pid) ? holder : null, waiters };
}

/**
 * Tries once to take the lock. The lock directory appears with its holder.json already inside (rename of a prepared
 * directory fails while the target exists), so no reader sees a lock with no holder. Returns the stale pid taken
 * over (or null) on success, `"busy"` when a live holder has it.
 */
function tryTake(runId: string): { staleOf: number | null } | "busy" {
  const lock = lockDirectory();
  const prepared = `${lock}.${process.pid}.new`;
  rmSync(prepared, { recursive: true, force: true });
  mkdirSync(prepared, { recursive: true });
  const entry: TestLockEntry = { run: runId, pid: process.pid, since: new Date().toISOString() };
  writeFileSync(join(prepared, "holder.json"), JSON.stringify(entry));
  let staleOf: number | null = null;
  try {
    for (;;) {
      try {
        renameSync(prepared, lock);
        return { staleOf };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOTEMPTY" && code !== "EEXIST") throw err;
      }
      const holder = readEntry(join(lock, "holder.json"));
      if (holder === null || alive(holder.pid)) return "busy";
      // Move the stale lock away, then check what we moved: another waiter may have replaced it in between.
      const grave = `${lock}.${process.pid}.stale`;
      try {
        renameSync(lock, grave);
      } catch {
        continue; // someone else took it away: try the rename again
      }
      const moved = readEntry(join(grave, "holder.json"));
      if (moved !== null && moved.pid !== holder.pid && alive(moved.pid)) {
        // ponytail: we moved a live lock; put it back. If that fails too, the lock is lost until its holder exits.
        try {
          renameSync(grave, lock);
        } catch {
          rmSync(grave, { recursive: true, force: true });
        }
        return "busy";
      }
      rmSync(grave, { recursive: true, force: true });
      staleOf = holder.pid;
    }
  } finally {
    rmSync(prepared, { recursive: true, force: true });
  }
}

/**
 * Waits for the host-wide `ark test` lock and returns its release. SIGINT, SIGTERM and SIGHUP release the lock,
 * remove the waiter file, call `onSignal` (to stop child processes) and exit 128+signal.
 */
export async function takeTestLock(runId: string, onSignal: () => void): Promise<() => void> {
  const waiterFile = join(waiterDirectory(), `${process.pid}.json`);
  let held = false;
  const cleanup = () => {
    rmSync(waiterFile, { force: true });
    if (held) {
      held = false;
      rmSync(lockDirectory(), { recursive: true, force: true });
    }
  };
  const signals = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 } as const;
  const handlers = Object.entries(signals).map(([name, number]) => {
    const handler = () => {
      onSignal();
      cleanup();
      process.exit(128 + number);
    };
    process.on(name as NodeJS.Signals, handler);
    return [name as NodeJS.Signals, handler] as const;
  });
  const release = () => {
    for (const [name, handler] of handlers) process.off(name, handler);
    process.off("exit", cleanup);
    cleanup();
  };
  process.on("exit", cleanup);

  try {
    let waiting = false;
    for (;;) {
      const taken = tryTake(runId);
      if (taken !== "busy") {
        held = true;
        if (taken.staleOf !== null)
          console.log(`took over a stale ark test lock of pid ${taken.staleOf}`);
        rmSync(waiterFile, { force: true });
        return release;
      }
      if (!waiting) {
        waiting = true;
        mkdirSync(waiterDirectory(), { recursive: true });
        const entry: TestLockEntry = {
          run: runId,
          pid: process.pid,
          since: new Date().toISOString(),
        };
        writeFileSync(waiterFile, JSON.stringify(entry));
        const holder = readEntry(join(lockDirectory(), "holder.json"));
        if (holder) console.log(`waiting for ark test of ${holder.run} (pid ${holder.pid})`);
      }
      await Bun.sleep(pollMilliseconds);
    }
  } catch (err) {
    release();
    throw err;
  }
}
