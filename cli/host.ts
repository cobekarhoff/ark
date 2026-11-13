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
  cpuPercent: () => number | null;
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

/** Percent of CPU busy since the previous call of this process; null on the first call (there is no span yet). */
function readCpuPercent(): number | null {
  const ticks = cpuTicks();
  const before = previousTicks;
  previousTicks = ticks;
  if (before === null || ticks.total === before.total) return null;
  return Math.round(((ticks.busy - before.busy) / (ticks.total - before.total)) * 1000) / 10;
}

const defaultReaders: HostReaders = {
  memory: readMemory,
  pressureLevel: readPressureLevel,
  loadAverages: () => loadavg() as [number, number, number],
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

/** Master Chief starts no run while free disk is under this many GB. */
export const minimumFreeDiskGigabytes = 10;

/**
 * Every reason `ark chief state` holds new runs, in the order free memory, swap, load, disk. Load is over `cores`;
 * disk is under `minimumFreeDiskGigabytes`. A missing reading never holds.
 */
export function holdReasons(
  reading: HostReading,
  limits: { minimumFreePercent: number; maximumSwapGigabytes: number; cores: number },
): string[] {
  const reasons = memoryReasons(
    reading,
    limits.minimumFreePercent,
    limits.maximumSwapGigabytes,
  ).reasons;
  const { load, freeDiskGigabytes } = reading;
  if (load !== null && load > limits.cores)
    reasons.push(`load ${load.toFixed(1)} is above the ${limits.cores} cores`);
  if (freeDiskGigabytes !== null && freeDiskGigabytes < minimumFreeDiskGigabytes)
    reasons.push(
      `free disk ${freeDiskGigabytes} GB is below the ${minimumFreeDiskGigabytes} GB floor`,
    );
  return reasons;
}
