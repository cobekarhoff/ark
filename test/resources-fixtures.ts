// Fixtures for the `resources` source, shared by Bun (test/resources-*.test.ts) and Node (test/pw/resources.pw.ts):
// no bun:test, no Bun.* globals. The fakes replace `/bin/ps` and `lsof` through ARK_PS and ARK_LSOF, the seams of
// cli/process-table.ts and hub/resources.ts, and print the shapes the real tools print.
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type FakeProcess = {
  pid: number;
  parent?: number;
  group?: number;
  memoryMegabytes?: number;
  cpuSeconds?: number;
  /** `ps` etime: `MM:SS`, `HH:MM:SS` or `D-HH:MM:SS`. */
  elapsed?: string;
  /** The program and its arguments, with no environment. */
  command: string;
  /** `NAME=value` words printed after the command on the same line, as `ps -E` prints them. */
  environment?: string[];
  /** Working directory for the fake `lsof`; none leaves the process out of its output. */
  directory?: string;
};

const clockText = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;

/** One line of `ps -E -ww -A -o pid=,ppid=,pgid=,rss=,time=,etime=,command=`. */
export function psLine(process: FakeProcess): string {
  const pid = process.pid;
  return [
    String(pid).padStart(6),
    String(process.parent ?? 1).padStart(6),
    String(process.group ?? pid).padStart(6),
    String(Math.round((process.memoryMegabytes ?? 10) * 1024)).padStart(8),
    clockText(process.cpuSeconds ?? 1).padStart(10),
    (process.elapsed ?? "01:00").padStart(12),
    [process.command, ...(process.environment ?? [])].join(" "),
  ].join(" ");
}

export type ProcessFakes = {
  /** What the fake `ps` and `lsof` print from now on. */
  setProcesses(processes: FakeProcess[]): void;
  /** The fake `lsof` exits 1 and prints nothing. */
  failLsof(failing: boolean): void;
  /** The fake `ps` exits 1 for `-E`, as the `ps` on PATH of some hosts does. */
  rejectEnvironment(rejecting: boolean): void;
  /** Every argument list the fake `ps` was called with, one per line. */
  psCalls(): string;
};

/** Writes the fake `ps` and `lsof` into `stateDirectory` and points ARK_PS and ARK_LSOF at them. */
export function installProcessFakes(stateDirectory: string): ProcessFakes {
  mkdirSync(stateDirectory, { recursive: true });
  const marker = (name: string) => join(stateDirectory, name);
  const script = (name: string, body: string) => {
    const file = join(stateDirectory, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };
  writeFileSync(marker("ps.out"), "");
  writeFileSync(marker("lsof.out"), "");
  writeFileSync(marker("ps.log"), "");
  process.env.ARK_PS = script(
    "fake-ps",
    `echo "$*" >> '${marker("ps.log")}'
for argument in "$@"; do
  [ "$argument" = "-E" ] && [ -e '${marker("ps.rejectEnvironment")}' ] && exit 1
done
cat '${marker("ps.out")}'`,
  );
  process.env.ARK_LSOF = script(
    "fake-lsof",
    `[ -e '${marker("lsof.fail")}' ] && exit 1
cat '${marker("lsof.out")}'`,
  );
  const toggle = (name: string, on: boolean) => {
    if (on) writeFileSync(marker(name), "");
    else rmSync(marker(name), { force: true });
  };
  return {
    setProcesses(processes) {
      writeFileSync(marker("ps.out"), `${processes.map(psLine).join("\n")}\n`);
      writeFileSync(
        marker("lsof.out"),
        processes
          .filter((process) => process.directory !== undefined)
          .map((process) => `p${process.pid}\nfcwd\nn${process.directory}\n`)
          .join(""),
      );
    },
    failLsof: (failing) => toggle("lsof.fail", failing),
    rejectEnvironment: (rejecting) => toggle("ps.rejectEnvironment", rejecting),
    psCalls: () => (existsSync(marker("ps.log")) ? readFileSync(marker("ps.log"), "utf8") : ""),
  };
}

/**
 * A started `ark test` ticket of `run` in the lock folder of $ARK_HOME (`test-budget`), in the format of
 * cli/test-lock.ts. `pid` must be a living process: the lock reader drops a ticket of an ended pid.
 */
export function writeStartedTicket(
  run: string,
  pid: number,
  options: { cores?: number; startedAt?: Date; arrivalAt?: Date } = {},
): void {
  const directory = join(process.env.ARK_HOME as string, "test-budget");
  mkdirSync(directory, { recursive: true });
  const started = options.startedAt ?? new Date();
  writeFileSync(
    join(directory, `${pid}-${randomUUID()}.json`),
    JSON.stringify({
      run,
      pid,
      cores: options.cores ?? 4,
      arrival: (options.arrivalAt ?? started).toISOString(),
      started: started.toISOString(),
    }),
  );
}

/** A waiting `ark test` ticket (no `started`) of `run`. */
export function writeWaitingTicket(run: string, pid: number, arrivalAt: Date, cores = 4): void {
  const directory = join(process.env.ARK_HOME as string, "test-budget");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${pid}-${randomUUID()}.json`),
    JSON.stringify({ run, pid, cores, arrival: arrivalAt.toISOString() }),
  );
}

export const secrets = {
  token: "ghp_FAKE_SECRET_418",
  awsValue: "FAKE_SECRET_418",
  names: ["GH_TOKEN", "AWS_SECRET_ACCESS_KEY"],
};

/** The variables every fixture process carries, so a leak shows in a text search of any output. */
export const secretEnvironment = [
  `GH_TOKEN=${secrets.token}`,
  `AWS_SECRET_ACCESS_KEY=${secrets.awsValue}`,
];

/**
 * Resolves with the first value `ready()` returns that is not undefined: at once when it already does, else after each
 * change event under `directory` (recursive). An event wait: no timer, so a condition that never holds ends at the
 * caller's test timeout.
 */
export async function whenFilesChange<Value>(
  directory: string,
  ready: () => Value | undefined,
): Promise<Value> {
  const found = ready();
  if (found !== undefined) return found;
  const { promise, resolve } = Promise.withResolvers<Value>();
  const watcher = watch(directory, { recursive: true }, () => {
    const value = ready();
    if (value !== undefined) resolve(value);
  });
  try {
    return await promise;
  } finally {
    watcher.close();
  }
}

/**
 * Runs `action` after `milliseconds` of real time and returns the function that cancels it. The wait that `ark test`
 * measures for admission is real time, so holding a ticket for a known span needs a real timer; no event stands in.
 */
export function after(milliseconds: number, action: () => void): () => void {
  const timer = setTimeout(action, milliseconds);
  return () => clearTimeout(timer);
}
