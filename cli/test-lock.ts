import { randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { arkHome } from "./paths.ts";

/**
 * A CPU budget per host instead of one `ark test` at a time. The folder `test-budget` under $ARK_HOME holds one
 * ticket file per suite (or check) of every `ark test`: run, pid, cores and arrival, plus `started` once admitted.
 * A ticket is admitted in arrival order, with no overtaking, when the cores of the running tickets plus its own fit
 * the budget. Ticket publication (arrival time and file) and the admission
 * read/check/start run one at a time under a host-wide mutex file, so a newly published older ticket cannot be
 * missed by a snapshot that is already taken. A ticket of an ended pid is deleted by whoever sees it.
 */
export type Ticket = { run: string; pid: number; cores: number; arrival: string; started?: string };

const pollMilliseconds = 100;
const lineWindowMilliseconds = 30_000;

const ticketDirectory = () => join(arkHome(), "test-budget");

const mutexStaleMilliseconds = 5_000;

/**
 * Runs `action` while holding the host-wide mutex: an exclusive-create file with the owner pid and a unique token. It
 * is held for one short synchronous step only. A mutex of an ended pid (or an unreadable one older than a few
 * seconds) is taken over by `reclaim`; release removes the file only while it still holds this owner's token.
 */
function withMutex<T>(action: () => T): T {
  mkdirSync(ticketDirectory(), { recursive: true });
  const file = join(ticketDirectory(), "mutex.lock");
  const token = `${process.pid}:${randomUUID()}`;
  for (;;) {
    try {
      writeFileSync(file, token, { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let observed: string | undefined;
      try {
        const content = readFileSync(file, "utf8");
        const owner = Number.parseInt(content, 10);
        const stale = Number.isInteger(owner)
          ? !alive(owner)
          : Date.now() - statSync(file).mtimeMs > mutexStaleMilliseconds;
        if (stale) observed = content;
      } catch {
        // released between the two calls: try to create it again
      }
      if (observed !== undefined) reclaim(file, observed);
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    return action();
  } finally {
    try {
      if (readFileSync(file, "utf8") === token) rmSync(file, { force: true });
    } catch {
      // already gone
    }
  }
}

/**
 * Removes the stale mutex whose content was `observed`. The file is first renamed to a name of its own, which only
 * one contender can win, and deleted only when it still holds the observed content. When a replacement owner took the
 * pathname after the observation, the rename caught that live file: it is linked back, never deleted.
 * ponytail: another contender can create the mutex in the instant between that rename and the link back; it needs a
 * crashed owner and three contenders, use a per-owner lock directory if it ever shows.
 */
function reclaim(file: string, observed: string): void {
  const moved = `${file}.stale.${randomUUID()}`;
  try {
    renameSync(file, moved);
  } catch {
    return; // another contender took it first
  }
  try {
    if (readFileSync(moved, "utf8") !== observed) linkSync(moved, file);
  } catch {
    // the replacement is already back or gone
  }
  rmSync(moved, { force: true });
}

/** A pid is alive when signal 0 reaches it; EPERM means it exists under another user. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readTicket(file: string): Ticket | null {
  try {
    const entry = JSON.parse(readFileSync(file, "utf8")) as Ticket;
    return Number.isInteger(entry.pid) &&
      Number.isInteger(entry.cores) &&
      typeof entry.run === "string" &&
      typeof entry.arrival === "string"
      ? entry
      : null;
  } catch {
    return null;
  }
}

/** Every ticket in arrival order with its file. Tickets of ended pids are deleted and reported once each. */
function readTickets(): { file: string; ticket: Ticket }[] {
  let names: string[];
  try {
    names = readdirSync(ticketDirectory()).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const tickets: { file: string; ticket: Ticket }[] = [];
  for (const name of names) {
    const file = join(ticketDirectory(), name);
    const ticket = readTicket(file);
    if (ticket === null) continue;
    if (alive(ticket.pid)) tickets.push({ file, ticket });
    else {
      try {
        unlinkSync(file);
        console.log(`took over a stale ark test lock of pid ${ticket.pid}`);
      } catch {
        // another process deleted it first
      }
    }
  }
  return tickets.sort(
    (a, b) =>
      a.ticket.arrival.localeCompare(b.ticket.arrival) ||
      a.ticket.pid - b.ticket.pid ||
      a.file.localeCompare(b.file),
  );
}

/** The running and the waiting suites of the host, waiting ones in arrival order. Tickets of ended pids are left out. */
export function readTestLock(): { running: Ticket[]; waiting: Ticket[] } {
  const tickets = readTickets().map(({ ticket }) => ticket);
  return {
    running: tickets.filter((ticket) => ticket.started !== undefined),
    waiting: tickets.filter((ticket) => ticket.started === undefined),
  };
}

function writeTicket(file: string, ticket: Ticket): void {
  writeFileSync(`${file}.tmp`, JSON.stringify(ticket));
  renameSync(`${file}.tmp`, file);
}

function minutes(started: string, now: number): string {
  const whole = Math.floor((now - Date.parse(started)) / 60_000);
  return whole < 1 ? "<1" : String(whole);
}

/** `waiting: place 3 of 3; running: <run> 3 cores 12 min, ...` */
function waitingLine(place: number, total: number, running: Ticket[], now: number): string {
  const holders =
    running.length === 0
      ? "none"
      : running
          .map(
            (ticket) => `${ticket.run} ${ticket.cores} cores ${minutes(ticket.started!, now)} min`,
          )
          .join(", ");
  return `waiting: place ${place} of ${total}; running: ${holders}`;
}

export type TestBudget = {
  /** Waits for admission of one suite and returns its release. Cores above the budget, or none, take the whole budget. */
  take(cores: number | undefined): Promise<{ cores: number; release: () => void }>;
  /** Removes the signal handlers and every ticket of this process. */
  close(): void;
};

type Options = {
  /** The clock, in milliseconds. */
  now?: () => number;
  /** Where waiting lines go. */
  print?: (line: string) => void;
};

/**
 * Opens the budget for one `ark test`. SIGINT, SIGTERM and SIGHUP call `onSignal` (it stops child processes and
 * resolves when they have ended), then remove every ticket of this process and exit 128+signal: cores stay taken
 * until the work under them has stopped.
 */
export function openTestBudget(
  runId: string,
  budget: number,
  onSignal: () => Promise<void>,
  { now = Date.now, print = console.log }: Options = {},
): TestBudget {
  const files = new Set<string>();
  const cleanup = () => {
    for (const file of files) rmSync(file, { force: true });
    files.clear();
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
  process.on("exit", cleanup);

  return {
    close() {
      for (const [name, handler] of handlers) process.off(name, handler);
      process.off("exit", cleanup);
      cleanup();
    },
    async take(requested) {
      const cores = requested === undefined || requested > budget ? budget : Math.max(1, requested);
      const file = join(ticketDirectory(), `${process.pid}-${randomUUID()}.json`);
      withMutex(() => {
        writeTicket(file, {
          run: runId,
          pid: process.pid,
          cores,
          arrival: new Date().toISOString(),
        });
        files.add(file);
      });
      let printedKey: string | null = null;
      let printedAt = 0;
      try {
        for (;;) {
          const { tickets, admitted } = withMutex(() => {
            const snapshot = readTickets();
            const mine = snapshot.findIndex((entry) => entry.file === file);
            const used = snapshot
              .filter((entry) => entry.ticket.started !== undefined)
              .reduce((sum, entry) => sum + entry.ticket.cores, 0);
            const fits =
              mine >= 0 &&
              snapshot.slice(0, mine).every((entry) => entry.ticket.started !== undefined) &&
              used + cores <= budget;
            if (fits)
              writeTicket(file, { ...snapshot[mine]!.ticket, started: new Date().toISOString() });
            return { tickets: snapshot, admitted: fits };
          });
          const running = tickets.filter((entry) => entry.ticket.started !== undefined);
          if (admitted) {
            return {
              cores,
              release: () => {
                files.delete(file);
                rmSync(file, { force: true });
              },
            };
          }
          const waiting = tickets.filter((entry) => entry.ticket.started === undefined);
          const place = waiting.findIndex((entry) => entry.file === file) + 1;
          const holders = running.map((entry) => entry.ticket);
          // Minutes ticking over never count as a change.
          const key = `${place}/${waiting.length}|${holders.map((holder) => `${holder.run}:${holder.cores}`).join(",")}`;
          const time = now();
          if (
            printedKey === null ||
            (key !== printedKey && time - printedAt >= lineWindowMilliseconds)
          ) {
            print(waitingLine(place, waiting.length, holders, time));
            printedKey = key;
            printedAt = time;
          }
          await Bun.sleep(pollMilliseconds);
        }
      } catch (err) {
        files.delete(file);
        rmSync(file, { force: true });
        throw err;
      }
    },
  };
}
