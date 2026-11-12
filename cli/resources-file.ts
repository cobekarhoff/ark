import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readProcessTable } from "./process-table.ts";

/** What one side of a suite used: peak memory of its process group, CPU seconds, wall time, and the wait for admission. */
export type SuiteUse = { peak_mb: number; cpu_s: number; wall_s: number; wait_s: number };
/** A cached suite starts no process, so it has no figures. */
export type SideUse = SuiteUse | { cached: true };

/**
 * `results/resources.json` of a run. `ark test` owns `suites`; the hub owns `agents` and `gaps`. Each writer changes
 * its own keys only (see `updateResources`).
 */
export type ResourcesFile = {
  suites?: Record<string, { head?: SideUse; base?: SideUse }>;
  /** By Orca terminal handle: the largest memory and the largest cumulative CPU time seen. */
  agents?: Record<string, { peak_mb: number; cpu_s: number }>;
  /** Spans of an open run with no hub sample. */
  gaps?: { from: string; to: string }[];
  /** The hub's last sample time, written when it pauses or stops, so the next sample can record the gap. */
  sampled_until?: string;
};

const resourcesPath = (runDirectory: string) => join(runDirectory, "results", "resources.json");

/** The file, or null when it is missing or not JSON. */
export function readResources(runDirectory: string): ResourcesFile | null {
  try {
    const value: unknown = JSON.parse(readFileSync(resourcesPath(runDirectory), "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as ResourcesFile)
      : null;
  } catch {
    return null;
  }
}

/**
 * Reads the file, lets `change` edit it, and replaces it by temp file and rename, so a reader never sees half a file.
 * The writers are `ark test` and the hub, each of its own keys: the read just before the write keeps the other's keys.
 * ponytail: no lock, so two writes within the same few milliseconds can lose one update; add a lock file if that shows.
 */
export function updateResources(runDirectory: string, change: (file: ResourcesFile) => void): void {
  const file = readResources(runDirectory) ?? {};
  change(file);
  mkdirSync(join(runDirectory, "results"), { recursive: true });
  const temporary = `${resourcesPath(runDirectory)}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(file)}\n`);
  renameSync(temporary, resourcesPath(runDirectory));
}

const megabyte = 1024 * 1024;
const sampleMilliseconds = 1000;

/**
 * Samples the process group `group` (the child spawned `detached`, so its pid is the group id) every second.
 * `stop` takes the usage the kernel counted for the finished child, which includes the descendants it reaped and so
 * covers a process that ended between two samples; the figures are the larger of the samples and that count.
 */
export function sampleGroup(group: number) {
  let peakBytes = 0;
  let cpuSeconds = 0;
  let stopped = false;
  const sample = async () => {
    const rows = await readProcessTable(false);
    if (rows === null) return;
    const members = rows.filter((row) => row.group === group);
    peakBytes = Math.max(
      peakBytes,
      members.reduce((sum, row) => sum + row.rssKilobytes * 1024, 0),
    );
    cpuSeconds = Math.max(
      cpuSeconds,
      members.reduce((sum, row) => sum + row.cpuSeconds, 0),
    );
  };
  const stopSignal = Promise.withResolvers<void>();
  const loop = (async () => {
    while (!stopped) {
      await sample();
      await Promise.race([Bun.sleep(sampleMilliseconds), stopSignal.promise]);
    }
  })();
  return {
    async stop(usage: { cpuMicroseconds: number; maxBytes: number } | null) {
      stopped = true;
      stopSignal.resolve();
      await loop;
      return {
        peak_mb: Math.round(Math.max(peakBytes, usage?.maxBytes ?? 0) / megabyte),
        cpu_s: Math.round(Math.max(cpuSeconds, (usage?.cpuMicroseconds ?? 0) / 1e6) * 10) / 10,
      };
    },
  };
}
