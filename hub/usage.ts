import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isInside } from "../cli/usage/index.ts";
import type { StepWindow } from "../cli/retro.ts";

export type Harness = "omp" | "claude" | "codex";
export type CompactMessage = { time: number; cost: number | null };
export type WorkerRequest = { id: number; kind: "head" | "parse"; file: string; harness: Harness };
export type WorkerReply = {
  id: number;
  cwd?: string | null;
  messages?: CompactMessage[];
  error?: string;
};

export type RunCost = { total: number | null; steps: Record<string, number | null> };

type Entry = {
  signature: string;
  cwd: string | null;
  harness: Harness;
  /** Null until the file is parsed. Only files of open runs are ever parsed. */
  messages: CompactMessage[] | null;
  failed: boolean;
};

function roots(): { harness: Harness; root: string; pattern: string }[] {
  return [
    {
      harness: "omp",
      root: process.env.ARK_OMP_SESSIONS ?? join(homedir(), ".omp", "agent", "sessions"),
      pattern: "**/*.jsonl",
    },
    {
      harness: "claude",
      root: process.env.ARK_CLAUDE_SESSIONS ?? join(homedir(), ".claude", "projects"),
      pattern: "**/*.jsonl",
    },
    {
      harness: "codex",
      root: process.env.ARK_CODEX_SESSIONS ?? join(homedir(), ".codex", "sessions"),
      pattern: "**/*.jsonl{,.zst}",
    },
  ];
}

const workerCount = 3;
/** A worker that has not answered this long is hung: it is dropped and its requests fail. */
const requestTimeoutMilliseconds = 60_000;

/** The folder and its symlink-resolved path: a session records whichever the agent started in. */
function parentsOf(directory: string): string[] {
  return [resolve(directory), ...(existsSync(directory) ? [realpathSync(directory)] : [])];
}

/** Sum of known costs, or null when nothing was measured or one message has no price. */
function sum(messages: CompactMessage[]): number | null {
  let total = 0;
  for (const message of messages) {
    if (message.cost === null) return null;
    total += message.cost;
  }
  return messages.length === 0 ? null : total;
}

/**
 * Cost of a closed run, from the `metrics.json` that `ark retro` wrote (cli/retro.ts). No session
 * file is read. Null when the file is missing, unreadable or says "unknown".
 */
export function readMetricsCost(directory: string): RunCost | null {
  try {
    const cost = JSON.parse(readFileSync(join(directory, "metrics.json"), "utf8")).cost;
    const steps: Record<string, number | null> = {};
    for (const [id, group] of Object.entries<{ usd?: unknown }>(cost.by_step ?? {}))
      steps[id] = typeof group?.usd === "number" ? group.usd : null;
    return { total: typeof cost.total_usd === "number" ? cost.total_usd : null, steps };
  } catch {
    return null;
  }
}

/**
 * Per-message cost of every session file whose cwd is inside an open run, in memory. A file is
 * keyed by path, size and mtime; when one changes the whole file is parsed again (Claude removes
 * duplicate response ids across a file, so the tail alone is not enough). Parsing runs in Bun
 * Workers, so the event loop of the server never waits for it.
 */
export class UsageIndex {
  /** Whole-file parses since the index was made. A refresh with no changed file adds 0. */
  parseCount = 0;
  /** Grows each time a refresh changed what the index holds. */
  version = 0;
  #entries = new Map<string, Entry>();
  #workers: (Worker | undefined)[] = [];
  #waiting = new Map<number, { slot: number; resolve: (reply: WorkerReply) => void }>();
  #nextId = 0;
  #queue: Promise<void> = Promise.resolve();
  #workerUrl: URL;

  /** `workerUrl` exists so a test can crash the worker; the hub uses the default. */
  constructor(workerUrl = new URL("./usage-worker.ts", import.meta.url)) {
    this.#workerUrl = workerUrl;
  }

  /** Brings the index up to date for the open runs of `directories`. Calls run one after the other. */
  refresh(directories: string[]): Promise<void> {
    const next = this.#queue.then(() => this.#refresh(directories));
    this.#queue = next.catch(() => {});
    return next;
  }

  async #refresh(directories: string[]): Promise<void> {
    const parents = directories.flatMap(parentsOf);
    const seen = new Set<string>();
    const changed: [string, Entry][] = [];
    for (const { harness, root, pattern } of roots()) {
      if (!existsSync(root)) continue;
      for await (const relative of new Bun.Glob(pattern).scan({ cwd: root, dot: true })) {
        const file = join(root, relative);
        let signature: string;
        try {
          const stat = statSync(file);
          signature = `${stat.size}:${stat.mtimeMs}`;
        } catch {
          continue;
        }
        seen.add(file);
        if (this.#entries.get(file)?.signature === signature) continue;
        changed.push([file, { signature, cwd: null, harness, messages: null, failed: false }]);
      }
    }
    let didChange = changed.length > 0;
    for (const file of this.#entries.keys()) {
      if (seen.has(file)) continue;
      this.#entries.delete(file);
      didChange = true;
    }
    // A changed file is read for its cwd first; a file already known is parsed when a new run needs it.
    await Promise.all(
      changed.map(async ([file, entry]) => {
        const reply = await this.#ask({ kind: "head", file, harness: entry.harness });
        entry.cwd = reply.cwd ?? null;
        entry.failed = reply.error !== undefined;
        this.#entries.set(file, entry);
      }),
    );
    const parses: Promise<void>[] = [];
    for (const [file, entry] of this.#entries) {
      if (entry.cwd === null || entry.failed) continue;
      const cwd = entry.cwd;
      if (!parents.some((parent) => isInside(cwd, parent))) {
        if (entry.messages !== null) entry.messages = null; // the run closed: free the memory
        continue;
      }
      if (entry.messages !== null) continue;
      parses.push(
        this.#ask({ kind: "parse", file, harness: entry.harness }).then((reply) => {
          this.parseCount += 1;
          entry.failed = reply.error !== undefined;
          entry.messages = reply.messages ?? [];
          didChange = true;
        }),
      );
    }
    await Promise.all(parses);
    if (didChange) this.version += 1;
  }

  /**
   * Cost of one run. A closed run reads `metrics.json` and touches no session. An open run sums the
   * messages of the sessions that ran inside its folder; a message belongs to a step when its session
   * ran in the step's worktree during the step's window (the rule of `ark retro`). A number is
   * never made up: no session, one unpriced message or one unreadable file gives null.
   */
  runCost(directory: string, closed: boolean, windows: StepWindow[]): RunCost {
    if (closed) return readMetricsCost(directory) ?? { total: null, steps: {} };
    const parents = parentsOf(directory);
    const all: CompactMessage[] = [];
    const byStep = new Map<string, CompactMessage[]>();
    let incomplete = false;
    for (const entry of this.#entries.values()) {
      const cwd = entry.cwd;
      if (cwd === null || !parents.some((parent) => isInside(cwd, parent))) continue;
      // A file that is unreadable or not parsed yet makes the total unknown, never a partial sum.
      if (entry.failed || entry.messages === null) {
        incomplete = true;
        continue;
      }
      for (const message of entry.messages) {
        all.push(message);
        const window = windows.find(
          (candidate) =>
            isInside(cwd, join(directory, "workspace", candidate.repo)) &&
            message.time >= candidate.start &&
            message.time <= (candidate.end ?? Infinity),
        );
        if (!window) continue;
        const list = byStep.get(window.id) ?? [];
        list.push(message);
        byStep.set(window.id, list);
      }
    }
    const steps: Record<string, number | null> = {};
    for (const window of windows) steps[window.id] = sum(byStep.get(window.id) ?? []);
    return { total: incomplete ? null : sum(all), steps };
  }

  /**
   * Sends one request to the worker of its slot. It always resolves: a worker that errors, closes,
   * sends an unreadable message or stays silent past the timeout is dropped (the next request
   * makes a new one) and every request it held resolves with `error`, so the caller marks that file failed.
   */
  #ask(request: Omit<WorkerRequest, "id">): Promise<WorkerReply> {
    const id = this.#nextId++;
    const slot = id % workerCount;
    const { promise, resolve } = Promise.withResolvers<WorkerReply>();
    const worker = this.#workerOf(slot);
    const timer = setTimeout(
      () => this.#drop(slot, worker, "the usage worker did not answer in time"),
      requestTimeoutMilliseconds,
    );
    this.#waiting.set(id, {
      slot,
      resolve: (reply) => {
        clearTimeout(timer);
        resolve(reply);
      },
    });
    worker.postMessage({ ...request, id });
    return promise;
  }

  #workerOf(slot: number): Worker {
    const known = this.#workers[slot];
    if (known) return known;
    const worker = new Worker(this.#workerUrl);
    const lost = () => this.#drop(slot, worker, "the usage worker stopped");
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const entry = this.#waiting.get(event.data.id);
      this.#waiting.delete(event.data.id);
      entry?.resolve(event.data);
    };
    worker.onerror = lost;
    worker.onmessageerror = lost;
    worker.addEventListener("close", lost);
    this.#workers[slot] = worker;
    return worker;
  }

  #drop(slot: number, worker: Worker, error: string): void {
    if (this.#workers[slot] !== worker) return;
    this.#workers[slot] = undefined;
    worker.terminate();
    for (const [id, entry] of this.#waiting) {
      if (entry.slot !== slot) continue;
      this.#waiting.delete(id);
      entry.resolve({ id, error });
    }
  }

  close(): void {
    this.#workers.forEach((worker, slot) => worker && this.#drop(slot, worker, "closed"));
  }
}
