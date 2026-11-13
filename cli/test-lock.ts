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
import {
  defaultMaximumSwapGigabytes,
  defaultMinimumFreeMemoryPercent,
  memoryReasons,
  readHost,
} from "./host.ts";
import { arkHome } from "./paths.ts";

/**
 * A CPU budget per host instead of one `ark test` at a time. The folder `test-budget` under $ARK_HOME holds one
 * ticket file per suite (or check) of every `ark test`: run, pid, cores and arrival, plus `started` once admitted.
 * There is no lock. Arrival (time, pid, file name) is a total order, and a process writes only its own ticket:
 * 1. The first waiting ticket marks itself `started` when the started cores plus its own fit the budget.
 * 2. It reads all tickets again. If the started tickets up to its own arrival exceed the budget it revokes itself
 *    (removes `started`) and waits again; the earliest ticket never revokes.
 * 3. It runs only when all started tickets, later ones included, fit the budget. A later ticket that missed this one
 *    revokes on its own re-read or runs and ends first, so two overflowing suites never run at the same time.
 * A ticket is removed by its owner, or by a reader that sees its pid ended.
 */
export type Ticket = { run: string; pid: number; cores: number; arrival: string; started?: string };

const pollMilliseconds = 100;
const lineWindowMilliseconds = 30_000;
const memoryReadingMilliseconds = 1000;

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
function readTickets(prune = true): { file: string; ticket: Ticket }[] {
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
    else if (prune && JSON.stringify(readTicket(file)) === JSON.stringify(ticket)) {
      // Only this stale file is removed, and only while it still holds what was read: a dead owner never writes.
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
export function readTestLock(prune = true): { running: Ticket[]; waiting: Ticket[] } {
  const tickets = readTickets(prune).map(({ ticket }) => ticket);
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
  take(
    cores: number | undefined,
  ): Promise<{ cores: number; waitMilliseconds: number; release: () => void }>;
  /** Removes every ticket of this process. */
  close(): void;
};

type Options = {
  /** The clock, in milliseconds. */
  now?: () => number;
  /** Where waiting lines go. */
  print?: (line: string) => void;
  /** A suite waits while free memory is below this percent (inclusive: equal admits). */
  minimumFreeMemoryPercent?: number;
  /** A suite waits while swap used is above this many GB (inclusive: equal admits). */
  maximumSwapGigabytes?: number;
};

/**
 * Opens the budget for one `ark test`, held by its detached runner. The runner stops the suites on a signal and
 * exits, so the tickets stay until the work under them has stopped; the exit handler then removes every ticket
 * of this process, and a runner that was killed leaves tickets that count as ended pids.
 */
export function openTestBudget(
  runId: string,
  budget: number,
  {
    now = Date.now,
    print = console.log,
    minimumFreeMemoryPercent = defaultMinimumFreeMemoryPercent,
    maximumSwapGigabytes = defaultMaximumSwapGigabytes,
  }: Options = {},
): TestBudget {
  let uncheckedPrinted = false;
  let reasons: string[] = [];
  let readAt = -Infinity;
  /** The memory reasons that hold a suite now. One reading a second, because a reading starts processes. */
  const memoryHold = async (): Promise<string[]> => {
    if (Date.now() - readAt >= memoryReadingMilliseconds) {
      const verdict = memoryReasons(
        await readHost(),
        minimumFreeMemoryPercent,
        maximumSwapGigabytes,
      );
      readAt = Date.now();
      reasons = verdict.reasons;
      if (verdict.unchecked && !uncheckedPrinted) {
        uncheckedPrinted = true;
        print("memory: unchecked");
      }
    }
    return reasons;
  };
  const files = new Set<string>();
  // After close() no ticket may be written: close() also drops the exit handler, so a ticket written by a take() that
  // was still awaiting a memory reading or a nap would stay on disk when the process exits.
  let closed = false;
  const cleanup = () => {
    for (const file of files) rmSync(file, { force: true });
    files.clear();
  };
  process.on("exit", cleanup);

  return {
    close() {
      closed = true;
      process.off("exit", cleanup);
      cleanup();
    },
    async take(requested) {
      if (closed) throw new Error("ark test: the budget is closed");
      const cores = requested === undefined || requested > budget ? budget : Math.max(1, requested);
      const file = join(ticketDirectory(), `${process.pid}-${randomUUID()}.json`);
      mkdirSync(ticketDirectory(), { recursive: true });
      writeTicket(file, {
        run: runId,
        pid: process.pid,
        cores,
        arrival: new Date().toISOString(),
      });
      files.add(file);
      let printedKey: string | null = null;
      let printedAt = 0;
      let memoryPrinted: string | null = null;
      // The time spent waiting for others or for memory: the polling sleeps only, so a suite that is admitted at once waits 0.
      let waitMilliseconds = 0;
      const nap = async () => {
        const slept = Date.now();
        await Bun.sleep(pollMilliseconds);
        waitMilliseconds += Date.now() - slept;
      };
      try {
        for (;;) {
          if (closed) throw new Error("ark test: the budget is closed");
          const tickets = readTickets();
          const mine = tickets.findIndex((entry) => entry.file === file);
          const startedTickets = tickets.filter((entry) => entry.ticket.started !== undefined);
          const sumOf = (entries: typeof tickets) =>
            entries.reduce((sum, entry) => sum + entry.ticket.cores, 0);
          if (mine >= 0 && tickets[mine]!.ticket.started !== undefined) {
            // Verification after my own `started` write. Only tickets up to mine in arrival order can revoke me;
            // an earlier ticket never gives way, so the earliest one always progresses.
            if (sumOf(startedTickets.filter((entry) => tickets.indexOf(entry) <= mine)) > budget) {
              writeTicket(file, { ...tickets[mine]!.ticket, started: undefined });
              await nap();
              continue;
            }
            // Fits among the earlier tickets. A later started ticket may not have seen mine yet: wait for it to
            // revoke or end, so that two suites never run together. Report like any other waiting ticket.
            if (sumOf(startedTickets) <= budget) {
              return {
                cores,
                waitMilliseconds,
                release: () => {
                  files.delete(file);
                  rmSync(file, { force: true });
                },
              };
            }
          } else {
            const firstWaiting = tickets.find((entry) => entry.ticket.started === undefined);
            if (
              mine >= 0 &&
              firstWaiting?.file === file &&
              sumOf(startedTickets) + cores <= budget
            ) {
              const held = await memoryHold();
              if (closed) throw new Error("ark test: the budget is closed");
              if (held.length > 0) {
                // Its own line and key: once for each change of reason, never for each poll.
                const line = `ark test: waiting for memory: ${held.join("; ")}`;
                if (line !== memoryPrinted) print(line);
                memoryPrinted = line;
                await nap();
                continue;
              }
              memoryPrinted = null;
              writeTicket(file, { ...tickets[mine]!.ticket, started: new Date().toISOString() });
              continue; // read everything again before running
            }
          }
          // My own reservation is not a running suite: it counts as waiting, in arrival order.
          const waiting = tickets.filter(
            (entry) => entry.ticket.started === undefined || entry.file === file,
          );
          const place = waiting.findIndex((entry) => entry.file === file) + 1;
          const holders = startedTickets
            .filter((entry) => entry.file !== file)
            .map((entry) => entry.ticket);
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
          await nap();
        }
      } catch (err) {
        files.delete(file);
        rmSync(file, { force: true });
        throw err;
      }
    },
  };
}
