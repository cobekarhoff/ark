import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { arkHome } from "./paths.ts";

/**
 * One `ark test` at a time per host: the lock directory `test.lock` under $ARK_HOME holds one holder file
 * `holder-<pid>-<uuid>.json`, and a waiting `ark test` leaves a file in test-waiters/ so `ark chief state` can list
 * it. The lock of an ended pid is taken over. The holder file name is unique per acquisition, so taking over and
 * releasing remove exactly the file that was read: a lock that someone else holds now is never touched.
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

/** The holder file of the lock directory and its entry, or null when there is none. */
function readHolder(): { file: string; entry: TestLockEntry } | null {
  try {
    const name = readdirSync(lockDirectory()).find((candidate) => candidate.startsWith("holder-"));
    if (name === undefined) return null;
    const file = join(lockDirectory(), name);
    const entry = readEntry(file);
    return entry && { file, entry };
  } catch {
    return null;
  }
}

/** The host's lock holder and the waiters with a live pid, oldest first. Null holder: no lock, or a holder that ended. */
export function readTestLock(): { holder: TestLockEntry | null; waiters: TestLockEntry[] } {
  const holder = readHolder()?.entry ?? null;
  const waiters = existsSync(waiterDirectory())
    ? readdirSync(waiterDirectory())
        .map((name) => readEntry(join(waiterDirectory(), name)))
        .filter((entry): entry is TestLockEntry => entry !== null && alive(entry.pid))
        .sort((a, b) => a.since.localeCompare(b.since) || a.pid - b.pid)
    : [];
  return { holder: holder && alive(holder.pid) ? holder : null, waiters };
}

/**
 * Tries once to take the lock. The lock directory appears with its holder file already inside (a rename of a
 * prepared directory onto the lock path fails while the target holds a file, and replaces an empty directory), so no
 * reader sees a lock with no holder. A dead holder is taken over by deleting its own holder file, which fails when
 * the file is already gone: a lock that was replaced meanwhile is never exposed. Returns the lock's holder file on
 * success, null when a live holder has it.
 */
function tryTake(runId: string): string | null {
  const lock = lockDirectory();
  const prepared = `${lock}.${process.pid}.new`;
  rmSync(prepared, { recursive: true, force: true });
  mkdirSync(prepared, { recursive: true });
  const name = `holder-${process.pid}-${randomUUID()}.json`;
  const entry: TestLockEntry = { run: runId, pid: process.pid, since: new Date().toISOString() };
  writeFileSync(join(prepared, name), JSON.stringify(entry));
  try {
    for (;;) {
      try {
        renameSync(prepared, lock);
        return join(lock, name);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOTEMPTY" && code !== "EEXIST") throw err;
      }
      const holder = readHolder();
      if (holder === null || alive(holder.entry.pid)) return null;
      try {
        unlinkSync(holder.file);
      } catch {
        continue; // someone else took it over first: try the rename again
      }
      console.log(`took over a stale ark test lock of pid ${holder.entry.pid}`);
      try {
        rmdirSync(lock); // fails when a new holder already replaced the emptied directory
      } catch {
        // in use again, or already gone
      }
    }
  } finally {
    rmSync(prepared, { recursive: true, force: true });
  }
}

/**
 * Waits for the host-wide `ark test` lock and returns its release. SIGINT, SIGTERM and SIGHUP call `onSignal` (it
 * stops child processes and resolves when they have ended), then release the lock, remove the waiter file and exit
 * 128+signal: the lock is held until the work under it has stopped.
 */
export async function takeTestLock(
  runId: string,
  onSignal: () => Promise<void>,
): Promise<() => void> {
  const waiterFile = join(waiterDirectory(), `${process.pid}.json`);
  let holderFile: string | null = null;
  const cleanup = () => {
    rmSync(waiterFile, { force: true });
    if (holderFile !== null) {
      // Only our own holder file: the directory is removed when that leaves it empty.
      rmSync(holderFile, { force: true });
      try {
        rmdirSync(lockDirectory());
      } catch {
        // a new holder already replaced the emptied directory
      }
      holderFile = null;
    }
  };
  const signals = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 } as const;
  let shuttingDown = false;
  const handlers = Object.entries(signals).map(([name, number]) => {
    const handler = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      try {
        await onSignal();
      } finally {
        cleanup();
        process.exit(128 + number);
      }
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
    const since = new Date().toISOString();
    for (;;) {
      // ponytail: a live waiter that never takes the lock blocks newer ones; ARK-390 replaces this lock.
      const olderWaiter = readTestLock().waiters.find(
        (other) =>
          other.pid !== process.pid &&
          (other.since < since || (other.since === since && other.pid < process.pid)),
      );
      const blocked = olderWaiter !== undefined;
      const taken = blocked ? null : tryTake(runId);
      if (taken !== null) {
        holderFile = taken;
        rmSync(waiterFile, { force: true });
        return release;
      }
      if (!waiting) {
        waiting = true;
        mkdirSync(waiterDirectory(), { recursive: true });
        const entry: TestLockEntry = {
          run: runId,
          pid: process.pid,
          since,
        };
        writeFileSync(waiterFile, JSON.stringify(entry));
        const blocker = readHolder()?.entry ?? olderWaiter;
        if (blocker) console.log(`waiting for ark test of ${blocker.run} (pid ${blocker.pid})`);
      }
      await Bun.sleep(pollMilliseconds);
    }
  } catch (err) {
    release();
    throw err;
  }
}
