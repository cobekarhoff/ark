import { readFileSync, statfsSync } from "node:fs";
import { availableParallelism, cpus, loadavg } from "node:os";
import { exec } from "./exec.ts";
import { arkHome } from "./paths.ts";

export const defaultMinimumFreeMemoryPercent = 20;
export const defaultMaximumSwapGigabytes = 8;

/** One reading of the host. A value that cannot be read is null, never a guess. */
export type HostReading = {
  /** Whole percent of memory that is free. */
  freeMemoryPercent: number | null;
  /** Gigabytes, unrounded: limits compare these; only printing rounds. */
  swapUsedGigabytes: number | null;
  swapTotalGigabytes: number | null;
  /** macOS memory pressure: 1 normal, 2 warn, 4 critical. */
  pressureLevel: 1 | 2 | 4 | null;
  /** Load average over 1 minute. */
  loadOne: number | null;
  /** The 5-minute load average. */
  load: number | null;
  /** Load average over 15 minutes. */
  loadFifteen: number | null;
  cores: number | null;
  /** Percent of CPU busy since the last reading of this process; null on the first. */
  cpuPercent: number | null;
  /** Gigabytes with no decimal, on the volume of ARK_HOME. */
  freeDiskGigabytes: number | null;
  /** Gigabytes with no decimal, on `/`: what the disk level uses. */
  freeRootGigabytes: number | null;
};

/** macOS: `memory_pressure` and `sysctl vm.swapusage`. Linux: /proc/meminfo. */
async function readMemory(): Promise<
  Pick<HostReading, "freeMemoryPercent" | "swapUsedGigabytes" | "swapTotalGigabytes">
> {
  const unread = { freeMemoryPercent: null, swapUsedGigabytes: null, swapTotalGigabytes: null };
  if (process.platform === "darwin") {
    const pressure = await exec(["memory_pressure"]);
    const percent = pressure?.match(/free percentage:\s*(\d+)%/)?.[1];
    const swap = (await exec(["sysctl", "vm.swapusage"]))?.match(
      /total = ([\d.]+)M\s+used = ([\d.]+)M/,
    );
    return {
      freeMemoryPercent: percent === undefined ? null : Number(percent),
      swapUsedGigabytes: swap ? Number(swap[2]) / 1024 : null,
      swapTotalGigabytes: swap ? Number(swap[1]) / 1024 : null,
    };
  }
  try {
    const meminfo = readFileSync("/proc/meminfo", "utf8");
    const kilobytes = (name: string) => {
      const value = meminfo.match(new RegExp(`^${name}:\\s+(\\d+) kB`, "m"))?.[1];
      return value === undefined ? null : Number(value);
    };
    const total = kilobytes("MemTotal");
    const available = kilobytes("MemAvailable");
    const swapTotal = kilobytes("SwapTotal");
    const swapFree = kilobytes("SwapFree");
    return {
      freeMemoryPercent:
        total === null || available === null || total === 0
          ? null
          : Math.floor((available / total) * 100),
      swapUsedGigabytes:
        swapTotal === null || swapFree === null ? null : (swapTotal - swapFree) / 1024 ** 2,
      swapTotalGigabytes: swapTotal === null ? null : swapTotal / 1024 ** 2,
    };
  } catch {
    return unread;
  }
}

/**
 * How each signal is read. A reader that returns null or throws leaves its signal unread, so a test passes fakes
 * for the signals it cares about and the rest read the real host.
 */
export type HostReaders = {
  memory: () => Promise<
    Pick<HostReading, "freeMemoryPercent" | "swapUsedGigabytes" | "swapTotalGigabytes">
  >;
  /** macOS `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical. */
  pressureLevel: () => Promise<number | null> | number | null;
  /** Load averages over 1, 5 and 15 minutes. */
  loadAverages: () => [number, number, number] | null;
  cores: () => number | null;
  cpuPercent: () => number | null | Promise<number | null>;
  freeGigabytesOf: (path: string) => number | null;
};

async function readPressureLevel(): Promise<number | null> {
  if (process.platform !== "darwin") return null;
  const text = await exec(["sysctl", "kern.memorystatus_vm_pressure_level"]);
  const level = text?.match(/:\s*(\d+)/)?.[1];
  return level === undefined ? null : Number(level);
}

function freeGigabytesOf(path: string): number | null {
  const disk = statfsSync(path);
  return Math.floor((disk.bavail * disk.bsize) / 1e9);
}

/** Busy and total ticks of every core, summed. */
function cpuTicks(): { busy: number; total: number } {
  let busy = 0;
  let total = 0;
  for (const { times } of cpus()) {
    const all = times.user + times.nice + times.sys + times.idle + times.irq;
    total += all;
    busy += all - times.idle;
  }
  return { busy, total };
}

let previousTicks: { busy: number; total: number } | null = null;

/**
 * Percent of CPU busy since the previous call of this process; null on the first call (there is no span yet).
 * `ARK_FAKE_CPU_PERCENT` replaces it on every reading: a number; any other text is a reading that failed.
 */
function readCpuPercent(): number | null {
  const fake = process.env.ARK_FAKE_CPU_PERCENT;
  if (fake !== undefined)
    return fake.trim() !== "" && Number.isFinite(Number(fake)) ? Number(fake) : null;
  const ticks = cpuTicks();
  const before = previousTicks;
  previousTicks = ticks;
  if (before === null || ticks.total === before.total) return null;
  return Math.round(((ticks.busy - before.busy) / (ticks.total - before.total)) * 1000) / 10;
}

/**
 * CPU percent over a fresh span of `milliseconds`. One-shot commands and the `ark test` admission use it:
 * `readCpuPercent` has no span on its first call. `ARK_FAKE_CPU_PERCENT` replaces it with no wait.
 */
export async function sampleCpuPercent(milliseconds = 1000): Promise<number | null> {
  if (process.env.ARK_FAKE_CPU_PERCENT !== undefined) return readCpuPercent();
  const before = cpuTicks();
  await Bun.sleep(milliseconds);
  const after = cpuTicks();
  if (after.total === before.total) return null;
  return Math.round(((after.busy - before.busy) / (after.total - before.total)) * 1000) / 10;
}
/**
 * Real load averages. `ARK_FAKE_LOAD_ONE` replaces the 1-minute figure on every reading: a number, or `file:<path>`
 * (a file whose number is read each time). A value that is not a number is a reading that failed.
 */
function readLoadAverages(): [number, number, number] {
  const averages = loadavg() as [number, number, number];
  const fake = process.env.ARK_FAKE_LOAD_ONE;
  if (fake === undefined) return averages;
  const text = (
    fake.startsWith("file:") ? readFileSync(fake.slice("file:".length), "utf8") : fake
  ).trim();
  const loadOne = text === "" ? Number.NaN : Number(text);
  if (!Number.isFinite(loadOne)) throw new Error(`ARK_FAKE_LOAD_ONE is not a number: ${fake}`);
  return [loadOne, averages[1], averages[2]];
}

/** The 1-minute load average now, through the reader the admission uses; null when it cannot be read. */
function readLoadOne(): number | null {
  try {
    return readLoadAverages()[0];
  } catch {
    return null;
  }
}

/** How long a retry waits for the load to fall below the budget: `ARK_RETRY_LOAD_WAIT_S` seconds, 180 by default. */
function retryLoadWaitSeconds(): number {
  const seconds = Number(process.env.ARK_RETRY_LOAD_WAIT_S ?? "");
  return process.env.ARK_RETRY_LOAD_WAIT_S !== undefined && Number.isFinite(seconds) && seconds >= 0
    ? seconds
    : 180;
}

/**
 * Before a retry: waits until the 1-minute load is below `budget` (strictly), at most `retryLoadWaitSeconds()`.
 * `announce` gets the load once, when the wait starts. Returns the load that is still not below the budget when the
 * limit ends, so the caller runs the retry anyway and says so; null when the load is below the budget now or fell
 * during the wait. An unreadable load never holds the retry.
 */
export async function waitForLoadBelow(
  budget: number,
  announce: (load: number) => void,
): Promise<number | null> {
  let load = readLoadOne();
  if (load === null || load < budget) return null;
  announce(load);
  const deadline = Date.now() + retryLoadWaitSeconds() * 1000;
  while (load !== null && load >= budget) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return load;
    await Bun.sleep(Math.min(1000, remaining));
    load = readLoadOne();
  }
  return null;
}

/** The 1-minute load when it started and the highest value sampled since; both null while nothing could be read. */
export type LoadSampler = {
  start: number | null;
  /** Takes a last sample, ends the sampling and returns the highest value. Safe to call twice. */
  stop(): number | null;
};

/** Samples the 1-minute load once a second. `read` is a parameter so a test can feed it values. */
export function sampleLoad(read: () => number | null = readLoadOne): LoadSampler {
  const start = read();
  let peak = start;
  const sample = () => {
    const value = read();
    if (value !== null && (peak === null || value > peak)) peak = value;
  };
  const timer = setInterval(sample, 1000);
  let stopped = false;
  return {
    start,
    stop() {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
        sample();
      }
      return peak;
    },
  };
}

const defaultReaders: HostReaders = {
  memory: readMemory,
  pressureLevel: readPressureLevel,
  loadAverages: readLoadAverages,
  cores: () => availableParallelism(),
  cpuPercent: readCpuPercent,
  freeGigabytesOf,
};

/** Runs one reader: null when it throws or rejects, never a guess. */
async function attempt<Value>(reader: () => Value | Promise<Value>): Promise<Value | null> {
  try {
    return await reader();
  } catch {
    return null;
  }
}

/** The one reading path of the host: `ark test` admission, `ark chief state` and the hub all call it. */
export async function readHost(overrides: Partial<HostReaders> = {}): Promise<HostReading> {
  const readers = { ...defaultReaders, ...overrides };
  const memory = (await attempt(readers.memory)) ?? {
    freeMemoryPercent: null,
    swapUsedGigabytes: null,
    swapTotalGigabytes: null,
  };
  const pressureLevel = await attempt(readers.pressureLevel);
  const loads = await attempt(readers.loadAverages);
  return {
    ...memory,
    pressureLevel:
      pressureLevel === 1 || pressureLevel === 2 || pressureLevel === 4 ? pressureLevel : null,
    loadOne: loads?.[0] ?? null,
    load: loads?.[1] ?? null,
    loadFifteen: loads?.[2] ?? null,
    cores: await attempt(readers.cores),
    cpuPercent: await attempt(readers.cpuPercent),
    freeDiskGigabytes: await attempt(() => readers.freeGigabytesOf(arkHome())),
    freeRootGigabytes: await attempt(() => readers.freeGigabytesOf("/")),
  };
}

/** How a signal reads on the strip. `unchecked` is a signal that could not be read, and is never shown as normal. */
export type Level = "normal" | "amber" | "red" | "unchecked";

export type HostLevels = {
  cpu: Level;
  pressure: Level;
  swap: Level;
  disk: Level;
  load: Level;
};

/** `unchecked` for an unread value, else `red` past `red`, else `amber` past `amber`, else normal. Strict: a value at a limit is not past it. */
const above = (value: number | null, amber: number, red: number): Level =>
  value === null ? "unchecked" : value > red ? "red" : value > amber ? "amber" : "normal";

/** The levels of AC2: pressure 2 amber and 4 red; load over 10 and 12; free disk under 30 and 15 GB; swap over 2 and 6 GB. CPU % has no limit. */
export function hostLevels(reading: HostReading): HostLevels {
  return {
    cpu: reading.cpuPercent === null ? "unchecked" : "normal",
    pressure:
      reading.pressureLevel === null
        ? "unchecked"
        : reading.pressureLevel === 4
          ? "red"
          : reading.pressureLevel === 2
            ? "amber"
            : "normal",
    swap: above(reading.swapUsedGigabytes, 2, 6),
    // free disk is the one signal where less is worse: compare the negative
    disk:
      reading.freeRootGigabytes === null
        ? "unchecked"
        : above(-reading.freeRootGigabytes, -30, -15),
    load: above(reading.load, 10, 12),
  };
}

/**
 * The reasons memory holds a suite, in the order free memory, swap. Limits are inclusive: only a value below the
 * floor or above the ceiling holds. Empty when memory is fine; `unchecked` when a reading is missing.
 */
export function memoryReasons(
  reading: HostReading,
  minimumFreePercent: number,
  maximumSwapGigabytes: number,
): { reasons: string[]; unchecked: boolean } {
  const reasons: string[] = [];
  const { freeMemoryPercent, swapUsedGigabytes } = reading;
  if (freeMemoryPercent !== null && freeMemoryPercent < minimumFreePercent)
    reasons.push(`free ${freeMemoryPercent}% is below the ${minimumFreePercent}% floor`);
  if (swapUsedGigabytes !== null && swapUsedGigabytes > maximumSwapGigabytes)
    reasons.push(
      `swap ${swapUsedGigabytes.toFixed(1)} GB is above the ${maximumSwapGigabytes} GB ceiling`,
    );
  return { reasons, unchecked: freeMemoryPercent === null || swapUsedGigabytes === null };
}

/** Master Chief starts no run, and a running suite holds the next one, while CPU use is over this percent. */
export const maximumCpuPercent = 90;

/** The reason a CPU use over `maximumCpuPercent` holds, or null. Strict: 90 admits. A missing reading never holds. */
export function cpuReason(cpuPercent: number | null): string | null {
  if (cpuPercent === null || cpuPercent <= maximumCpuPercent) return null;
  return `CPU ${cpuPercent.toFixed(1)}% is above the ${maximumCpuPercent}% busy limit`;
}

/** Master Chief starts no run while free disk is under this many GB. */
export const minimumFreeDiskGigabytes = 10;

/**
 * Every reason `ark chief state` holds new runs, in the order free memory, swap, CPU, disk. CPU is over
 * `maximumCpuPercent`; disk is under `minimumFreeDiskGigabytes`. A missing reading never holds.
 */
export function holdReasons(
  reading: HostReading,
  limits: { minimumFreePercent: number; maximumSwapGigabytes: number },
): string[] {
  const reasons = memoryReasons(
    reading,
    limits.minimumFreePercent,
    limits.maximumSwapGigabytes,
  ).reasons;
  const { cpuPercent, freeDiskGigabytes } = reading;
  const cpu = cpuReason(cpuPercent);
  if (cpu !== null) reasons.push(cpu);
  if (freeDiskGigabytes !== null && freeDiskGigabytes < minimumFreeDiskGigabytes)
    reasons.push(
      `free disk ${freeDiskGigabytes} GB is below the ${minimumFreeDiskGigabytes} GB floor`,
    );
  return reasons;
}

/**
 * Bun test workers (`bun test --test-worker`) whose parent is pid 1, from one `ps`; null when `ps` fails, which is
 * unknown and not none. The working folder is not read, so `ark chief state` runs no `lsof`. Memory is RSS in MB.
 * `scripts/temp-cleaner.sh` uses the same command test and adds the working folder (which may be deleted) and an age before it stops one.
 */
export async function readOrphanedTestWorkers(): Promise<{
  count: number;
  megabytes: number;
} | null> {
  const output = await exec(["ps", "-axww", "-o", "pid=,ppid=,rss=,command="]);
  if (output === null) return null;
  let count = 0;
  let kilobytes = 0;
  for (const line of output.split("\n")) {
    const [, parent, rss, command] = /^\s*\d+\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line) ?? [];
    if (parent !== "1" || !/^(\S*\/)?bun test --test-worker( |$)/.test(command ?? "")) continue;
    count++;
    kilobytes += Number(rss);
  }
  return { count, megabytes: Math.round(kilobytes / 1024) };
}
