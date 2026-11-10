import { randomUUID } from "node:crypto";
import {
  appendFileSync,
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
import { format } from "node:util";
import { ArkError } from "./errors.ts";

/**
 * `ark test` starts a detached runner process and follows it. The runner owns the host lock, the suites and
 * their process groups; it writes the run folder files below, so the first call, `--wait` and a second call all
 * print the same lines and exit with the same code, and a dead caller changes nothing.
 *
 *   results/runner.json  { pid, start, mode, state, exit_code }  state: running | done | stopped
 *   results/runner.out   what the run printed to stdout
 *   results/runner.err   what it printed to stderr
 *   results/runner.lock/ one live runner per run: a directory with one owner-*.json file, moved into place by one rename
 */
export type RunnerRecord = {
  pid: number;
  /** `ps` start time of the pid: a reused pid or a reboot gives another value. */
  start: string;
  mode: "quick" | "full";
  state: "running" | "done" | "stopped";
  started: string;
  finished?: string;
  exit_code?: number;
};

/** Exit code of a runner that finds another live runner for its run. */
const alreadyRunning = 3;
const pollMilliseconds = 50;
const stopLimitMilliseconds = 30_000;

const files = (resultsDirectory: string) => ({
  record: join(resultsDirectory, "runner.json"),
  out: join(resultsDirectory, "runner.out"),
  err: join(resultsDirectory, "runner.err"),
  lock: join(resultsDirectory, "runner.lock"),
});

function processStart(pid: number): string {
  const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)]);
  return result.exitCode === 0 ? result.stdout.toString().trim() : "";
}

/** Signal 0 reaches the pid, and the pid still started when the record says it did. */
function identityLive(owner: { pid: number; start: string }): boolean {
  try {
    process.kill(owner.pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  return owner.start === "" || processStart(owner.pid) === owner.start;
}

function readRecord(resultsDirectory: string): RunnerRecord | null {
  try {
    return JSON.parse(readFileSync(files(resultsDirectory).record, "utf8")) as RunnerRecord;
  } catch {
    return null;
  }
}

const isLive = (record: RunnerRecord | null): record is RunnerRecord =>
  record !== null && record.state === "running" && identityLive(record);

function writeRecord(resultsDirectory: string, record: RunnerRecord): void {
  const { record: file } = files(resultsDirectory);
  writeFileSync(`${file}.${process.pid}`, JSON.stringify(record, null, 2));
  renameSync(`${file}.${process.pid}`, file);
}

/**
 * Moves a prepared folder to runner.lock; false when a live runner owns it. The folder holds one owner file named
 * for its owner. A dead owner is taken over by removing only the owner file that was inspected, as in
 * test-lock.ts: when another runner replaced the claim first, the removal fails and this runner looks again.
 */
function claim(resultsDirectory: string, start: string): boolean {
  const { lock } = files(resultsDirectory);
  const prepared = `${lock}.${process.pid}`;
  rmSync(prepared, { recursive: true, force: true });
  mkdirSync(prepared);
  writeFileSync(
    join(prepared, `owner-${process.pid}-${randomUUID()}.json`),
    JSON.stringify({ pid: process.pid, start }),
  );
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        renameSync(prepared, lock);
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOTEMPTY" && code !== "EEXIST") throw err;
      }
      const name = (() => {
        try {
          return readdirSync(lock).find((entry) => entry.startsWith("owner-"));
        } catch {
          return undefined; // removed meanwhile: try the rename again
        }
      })();
      if (name !== undefined) {
        try {
          if (identityLive(JSON.parse(readFileSync(join(lock, name), "utf8")))) return false;
          unlinkSync(join(lock, name));
        } catch {
          continue; // taken over by another runner first, or unreadable: look again
        }
      } else {
        try {
          rmdirSync(lock); // a folder with no owner is no claim; fails on a non-empty folder, so a live claim stays
        } catch {
          // a live claim arrived, or the folder is already gone
        }
        continue;
      }
      try {
        rmdirSync(lock); // fails when a new claim already replaced the emptied folder
      } catch {
        // in use again, or already gone
      }
    }
    return false;
  } finally {
    rmSync(prepared, { recursive: true, force: true });
  }
}

/**
 * The process of a detached runner. `execute` runs the checks and suites and throws on failure; `stop` ends every
 * suite process group. SIGTERM, SIGINT and SIGHUP stop the suites, record `stopped` and exit 128 plus the signal number.
 * Returns the exit code.
 */
export async function runnerMain(
  directory: string,
  quick: boolean,
  execute: () => Promise<void>,
  stop: () => Promise<void>,
): Promise<number> {
  const resultsDirectory = join(directory, "results");
  mkdirSync(resultsDirectory, { recursive: true });
  const start = processStart(process.pid);
  if (!claim(resultsDirectory, start)) return alreadyRunning;
  const paths = files(resultsDirectory);
  const record: RunnerRecord = {
    pid: process.pid,
    start,
    mode: quick ? "quick" : "full",
    state: "running",
    started: new Date().toISOString(),
  };
  writeFileSync(paths.out, "");
  writeFileSync(paths.err, "");
  writeRecord(resultsDirectory, record);
  console.log = (...parts: unknown[]) => appendFileSync(paths.out, `${format(...parts)}\n`);
  console.error = (...parts: unknown[]) => appendFileSync(paths.err, `${format(...parts)}\n`);

  const finish = (state: "done" | "stopped", exitCode: number) => {
    writeRecord(resultsDirectory, {
      ...record,
      state,
      exit_code: exitCode,
      finished: new Date().toISOString(),
    });
    rmSync(paths.lock, { recursive: true, force: true });
  };
  let stopping = false;
  for (const [signal, number] of [
    ["SIGHUP", 1],
    ["SIGINT", 2],
    ["SIGTERM", 15],
  ] as const)
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      try {
        await stop();
      } finally {
        finish("stopped", 128 + number);
        process.exit(128 + number);
      }
    });

  let exitCode = 0;
  try {
    await execute();
  } catch (err) {
    exitCode = 1;
    console.error(err instanceof ArkError ? `ark: ${err.message}` : String(err));
  }
  finish("done", exitCode);
  return exitCode;
}

/** Prints what the runner wrote so far, from the offsets, and returns the new offsets. */
function drain(
  resultsDirectory: string,
  offsets: { out: number; err: number },
): { out: number; err: number } {
  const paths = files(resultsDirectory);
  const next = { ...offsets };
  for (const [name, stream] of [
    ["out", process.stdout],
    ["err", process.stderr],
  ] as const) {
    if (!existsSync(paths[name])) continue;
    const bytes = readFileSync(paths[name]);
    if (bytes.length > next[name]) stream.write(bytes.subarray(next[name]));
    next[name] = Math.max(bytes.length, next[name]);
  }
  return next;
}

/** Prints the runner's output as it grows until the runner ends, and returns its exit code. */
async function follow(resultsDirectory: string, runId: string): Promise<number> {
  let offsets = { out: 0, err: 0 };
  for (;;) {
    const record = readRecord(resultsDirectory);
    const running = record?.state === "running";
    // read the files after the record: what the runner wrote before it ended is then all there
    offsets = drain(resultsDirectory, offsets);
    if (record === null)
      throw new ArkError(`no ark test runner for ${runId}: run ark test ${runId}`);
    if (!running) return record.exit_code ?? 1;
    if (!identityLive(record)) {
      // the runner may have finished between the record read and this check: its final record is then on disk
      const final = readRecord(resultsDirectory);
      if (final !== null && final.state !== "running") {
        drain(resultsDirectory, offsets);
        return final.exit_code ?? 1;
      }
      console.error(`ark: the runner of ${runId} (pid ${record.pid}) ended without a result`);
      return 1;
    }
    await Bun.sleep(pollMilliseconds);
  }
}

/** The `ark status` line of a live runner; none when no runner runs for the run. */
export function runnerStatusLines(directory: string): string[] {
  const record = readRecord(join(directory, "results"));
  return isLive(record)
    ? [`test runner: running (pid ${record.pid}, ${record.mode}): ark test <run> --wait`]
    : [];
}

/** Starts a runner and follows it, or attaches to the live one of the run. */
async function startAndFollow(
  runId: string,
  project: string,
  resultsDirectory: string,
  quick: boolean,
): Promise<number> {
  const mode = quick ? "quick" : "full";
  for (;;) {
    const live = readRecord(resultsDirectory);
    if (isLive(live)) {
      if (live.mode !== mode)
        throw new ArkError(
          `a ${live.mode} ark test of ${runId} is running (pid ${live.pid}): ark test ${runId} --wait waits for it, ark test ${runId} --stop stops it`,
        );
      console.error(`ark: attaching to the ${mode} ark test of ${runId} (pid ${live.pid})`);
      return follow(resultsDirectory, runId);
    }
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "ark.ts"),
        "test-runner",
        runId,
        "--project",
        project,
        ...(quick ? ["--quick"] : []),
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true },
    );
    child.unref();
    for (;;) {
      if (readRecord(resultsDirectory)?.pid === child.pid) return follow(resultsDirectory, runId);
      if (child.exitCode !== null) {
        if (readRecord(resultsDirectory)?.pid === child.pid) return follow(resultsDirectory, runId);
        if (child.exitCode === alreadyRunning) break;
        throw new ArkError(`the runner of ${runId} exited ${child.exitCode} before it started`);
      }
      await Bun.sleep(25);
    }
    // another caller's runner won the claim: read its record and attach
    await Bun.sleep(pollMilliseconds);
  }
}

async function stopRunner(runId: string, resultsDirectory: string): Promise<void> {
  const record = readRecord(resultsDirectory);
  if (!isLive(record)) throw new ArkError(`no ark test is running for ${runId}`);
  process.kill(record.pid, "SIGTERM");
  const deadline = Date.now() + stopLimitMilliseconds;
  while (identityLive(record) && Date.now() < deadline) await Bun.sleep(pollMilliseconds);
  if (identityLive(record))
    throw new ArkError(`the runner of ${runId} (pid ${record.pid}) did not stop`);
  console.log(`stopped the ark test of ${runId} (pid ${record.pid})`);
}

/**
 * `ark test` for a caller. Without a flag: start a runner and print what it prints. `--wait`: print what the
 * runner of the run prints, from the start, whatever its mode, and exit with its code. `--stop`: SIGTERM the
 * runner and return when it is gone. A caller that dies leaves the runner running.
 */
export async function callTest(
  runId: string,
  project: string,
  directory: string,
  options: { quick: boolean; wait: boolean; stop: boolean },
): Promise<void> {
  const resultsDirectory = join(directory, "results");
  mkdirSync(resultsDirectory, { recursive: true });
  if (options.stop) return stopRunner(runId, resultsDirectory);
  const code = options.wait
    ? await follow(resultsDirectory, runId)
    : await startAndFollow(runId, project, resultsDirectory, options.quick);
  if (code !== 0) process.exitCode = code;
}
