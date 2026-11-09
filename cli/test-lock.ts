import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { arkHome } from "./paths.ts";

/**
 * A CPU budget per host instead of one `ark test` at a time. The folder `test-budget` under $ARK_HOME holds one
 * ticket file per suite (or check) of every `ark test`: run, pid, cores and arrival, plus `started` once admitted.
 * A ticket is admitted in arrival order, with no overtaking, when the cores of the running tickets plus its own fit
 * the budget. Admission needs no mutex: only a ticket whose every older ticket already runs may start, so two
 * waiters never pass at once. A ticket of an ended pid is deleted by whoever sees it.
 */
export type Ticket = { run: string; pid: number; cores: number; arrival: string; started?: string };

const pollMilliseconds = 100;
const lineWindowMilliseconds = 30_000;

const ticketDirectory = () => join(arkHome(), "test-budget");

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
      mkdirSync(ticketDirectory(), { recursive: true });
      const file = join(ticketDirectory(), `${process.pid}-${randomUUID()}.json`);
      const ticket: Ticket = {
        run: runId,
        pid: process.pid,
        cores,
        arrival: new Date().toISOString(),
      };
      writeTicket(file, ticket);
      files.add(file);
      let printedKey: string | null = null;
      let printedAt = 0;
      try {
        for (;;) {
          const tickets = readTickets();
          const mine = tickets.findIndex((entry) => entry.file === file);
          const running = tickets.filter((entry) => entry.ticket.started !== undefined);
          const used = running.reduce((sum, entry) => sum + entry.ticket.cores, 0);
          const older = tickets.slice(0, mine);
          if (
            mine >= 0 &&
            older.every((entry) => entry.ticket.started !== undefined) &&
            used + cores <= budget
          ) {
            writeTicket(file, { ...ticket, started: new Date().toISOString() });
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
