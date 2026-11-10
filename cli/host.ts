import { readFileSync, statfsSync } from "node:fs";
import { loadavg } from "node:os";
import { exec } from "./exec.ts";
import { arkHome } from "./paths.ts";

export const defaultMinimumFreeMemoryPercent = 20;
export const defaultMaximumSwapGigabytes = 8;

/** One reading of the host. A value that cannot be read is null, never a guess. */
export type HostReading = {
  /** Whole percent of memory that is free. */
  freeMemoryPercent: number | null;
  /** Gigabytes with one decimal. */
  swapUsedGigabytes: number | null;
  swapTotalGigabytes: number | null;
  /** The 5-minute load average. */
  load: number | null;
  /** Gigabytes with no decimal. */
  freeDiskGigabytes: number | null;
};

const oneDecimal = (value: number) => Math.round(value * 10) / 10;

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
      swapUsedGigabytes: swap ? oneDecimal(Number(swap[2]) / 1024) : null,
      swapTotalGigabytes: swap ? oneDecimal(Number(swap[1]) / 1024) : null,
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
        swapTotal === null || swapFree === null
          ? null
          : oneDecimal((swapTotal - swapFree) / 1024 ** 2),
      swapTotalGigabytes: swapTotal === null ? null : oneDecimal(swapTotal / 1024 ** 2),
    };
  } catch {
    return unread;
  }
}

/** The one reading path of the host: `ark test` admission and `ark chief state` both call it. */
export async function readHost(): Promise<HostReading> {
  let freeDiskGigabytes: number | null = null;
  try {
    const disk = statfsSync(arkHome());
    freeDiskGigabytes = Math.floor((disk.bavail * disk.bsize) / 1e9);
  } catch {
    // unreadable: stays null
  }
  return { ...(await readMemory()), load: loadavg()[1] ?? null, freeDiskGigabytes };
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
    reasons.push(`swap ${swapUsedGigabytes} GB is above the ${maximumSwapGigabytes} GB ceiling`);
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
