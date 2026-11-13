import { now } from "../cli/clock.ts";
import { exec } from "../cli/exec.ts";
import { hostLevels, readHost } from "../cli/host.ts";
import { readProcessTable, type ProcessRow } from "../cli/process-table.ts";
import { readResources, updateResources } from "../cli/resources-file.ts";
import { readTestLock } from "../cli/test-lock.ts";
import type {
  Agent,
  HostView,
  ProcessKind,
  ProcessOwner,
  ResourceProcess,
  ResourcesHistory,
  ResourcesView,
} from "./types.ts";

/** ARK_LSOF names another `lsof` (tests). */
const lsofCommand = () => process.env.ARK_LSOF || "lsof";

const historyMilliseconds = 24 * 3600 * 1000;
/** A span longer than this between two samples of a run is a gap: the hub had no page open, or was not running. */
const gapMilliseconds = 30_000;
const stampMilliseconds = 60_000;
const otherLimit = 10;
const commandLimit = 200;
/** The route sends at most this many points of a signal: a longer history keeps every few-th point and the last. */
const historyPointLimit = 720;

export type ResourcesContext = {
  runs: { run: string; directory: string; closed: boolean }[];
  /** The Orca agents of each open run. */
  agents: Map<string, Agent[]>;
};

/** The `kind` of a process, read from the head of its command: the program, then its first words. */
export function kindOf(command: string): ProcessKind {
  const program = command.split(/\s+/)[0]!.split("/").at(-1)!;
  if (program === "git") return "git";
  if (program === "omp") return "omp";
  if (/playwright/i.test(command)) return "playwright";
  if (/chromium|chrome|headless_shell/i.test(command)) return "chromium";
  if (/(^|\/)bun\s+test(\s|$)/.test(command)) return "bun test";
  return "other";
}

const environmentStart = /^[A-Za-z_][A-Za-z0-9_]*=/;
const secretValue = /((?:token|secret|password|passwd|api[-_]?key|key)[\w-]*=)\S+/gi;

/**
 * `ps -E` prints the command line and the environment as one string. The command ends where the first
 * `NAME=value` word starts; everything after it is the environment and is dropped here, so no variable
 * but ORCA_TERMINAL_HANDLE leaves this function.
 * ponytail: an argument that looks like `NAME=value` cuts the command short; the kind and owner do not depend on the rest.
 */
export function splitProcessText(text: string): { command: string; handle: string | null } {
  const words = text.split(/\s+/).filter((word) => word !== "");
  const end = words.findIndex((word, index) => index > 0 && environmentStart.test(word));
  const handle = text.match(/(?:^|\s)ORCA_TERMINAL_HANDLE=(\S+)/)?.[1] ?? null;
  const command = (end === -1 ? words : words.slice(0, end))
    .join(" ")
    .replace(secretValue, "$1***")
    .slice(0, commandLimit);
  return { command, handle };
}

/** pid to working directory, from `lsof -d cwd`; null when `lsof` fails. */
async function readWorkingDirectories(): Promise<Map<number, string> | null> {
  const output = await exec([lsofCommand(), "-n", "-P", "-d", "cwd", "-Fpn"]);
  if (output === null) return null;
  const directories = new Map<number, string>();
  let pid: number | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== null) directories.set(pid, line.slice(1));
  }
  return directories;
}

const inside = (directory: string, folder: string) =>
  directory === folder || directory.startsWith(`${folder}/`);

/** Evenly keeps `limit` points of `points`, the last one included. */
function thin<Point>(points: Point[], limit: number): Point[] {
  if (points.length <= limit) return points;
  const stride = Math.ceil(points.length / limit);
  return points.filter((_, index) => index % stride === 0 || index === points.length - 1);
}

type Signal = keyof ResourcesHistory;
const signals: Signal[] = ["cpu", "pressure", "swap", "disk", "load"];

/**
 * The `resources` source: one `ps -E` and one `lsof -d cwd` for each sample, owners as `ProcessOwner` says, the
 * host reading with its levels, a 24-hour history of each host signal (in memory only), and the `agents` and
 * `gaps` of `results/resources.json` of each open run.
 */
type Measured = ResourceProcess & { cpu_seconds: number };

export function createResourcesReader() {
  const history = new Map<Signal, { ms: number; value: number }[]>(
    signals.map((signal) => [signal, []]),
  );
  /** pid to the CPU time and clock of the previous sample, for the CPU % of each process. */
  let previous = new Map<number, { cpuSeconds: number; at: number }>();
  /** Per open run: when it was last sampled, and what the file already holds for each agent. */
  const lastSampled = new Map<string, { at: number; directory: string }>();
  const written = new Map<string, Map<string, { peak_mb: number; cpu_s: number }>>();
  const stamped = new Map<string, number>();

  function recordHistory(at: number, host: HostView): void {
    const values: Record<Signal, number | null> = {
      cpu: host.cpu.percent,
      pressure: host.pressure.code,
      swap: host.swap.used_gb,
      disk: host.disk.free_gb,
      load: host.load.five,
    };
    for (const signal of signals)
      if (values[signal] !== null) history.get(signal)!.push({ ms: at, value: values[signal] });
    prune(at);
  }

  /** Drops points older than 24 hours; a point at exactly the cutoff stays. */
  function prune(at: number): void {
    const cutoff = at - historyMilliseconds;
    for (const [signal, points] of history) {
      const keep = points.findIndex((point) => point.ms >= cutoff);
      history.set(signal, keep === -1 ? [] : points.slice(keep));
    }
  }

  /** Adds the peaks of each agent to its run's file, and the gap since the last sample of the run. */
  function writeRuns(at: number, context: ResourcesContext, processes: Measured[]): void {
    for (const { run, directory, closed } of context.runs) {
      if (closed) continue;
      const file = readResources(directory);
      const before =
        lastSampled.get(run)?.at ?? (file?.sampled_until ? Date.parse(file.sampled_until) : null);
      lastSampled.set(run, { at, directory });
      const seen = new Map<string, { peak_mb: number; cpu_s: number }>();
      for (const agent of context.agents.get(run) ?? []) {
        if (agent.terminal === null || agent.role === "Master Chief") continue;
        const own = processes.filter(
          (found) => found.owner.kind === "agent" && found.owner.handle === agent.terminal,
        );
        if (own.length === 0) continue;
        // `cpu_s` is cumulative: the sum of the CPU time of the agent's living processes now.
        seen.set(agent.terminal, {
          peak_mb: own.reduce((sum, found) => sum + found.memory_mb, 0),
          cpu_s: Math.round(own.reduce((sum, found) => sum + found.cpu_seconds, 0) * 10) / 10,
        });
      }
      const gap = before !== null && at - before > gapMilliseconds;
      const known = written.get(run) ?? new Map<string, { peak_mb: number; cpu_s: number }>();
      const changed = [...seen].some(([handle, use]) => {
        const old = known.get(handle) ?? file?.agents?.[handle];
        return old === undefined || use.peak_mb > old.peak_mb || use.cpu_s > old.cpu_s;
      });
      if (!gap && !changed && at - (stamped.get(run) ?? 0) < stampMilliseconds) continue;
      updateResources(directory, (current) => {
        current.agents ??= {};
        for (const [handle, use] of seen) {
          const old = current.agents[handle];
          current.agents[handle] = {
            peak_mb: Math.max(old?.peak_mb ?? 0, use.peak_mb),
            cpu_s: Math.max(old?.cpu_s ?? 0, use.cpu_s),
          };
        }
        if (gap)
          current.gaps = [
            ...(current.gaps ?? []),
            { from: new Date(before).toISOString(), to: new Date(at).toISOString() },
          ];
        // A hub that dies without `flush` still leaves the time of a sample at most a minute old, so the next sample sees the gap.
        current.sampled_until = new Date(at).toISOString();
        stamped.set(run, at);
        written.set(run, new Map(Object.entries(current.agents)));
      });
    }
  }

  return {
    /** One sample. Null when `ps` fails: the slot then keeps its last value and shows it as stale. */
    async read(context: ResourcesContext): Promise<ResourcesView | null> {
      const at = now();
      const [table, directories, reading] = await Promise.all([
        readProcessTable(true),
        readWorkingDirectories(),
        readHost(),
      ]);
      if (table === null) return null;
      const levels = hostLevels(reading);
      const host: HostView = {
        cpu: { percent: reading.cpuPercent, cores: reading.cores, level: levels.cpu },
        pressure: {
          code: reading.pressureLevel,
          free_percent: reading.freeMemoryPercent,
          level: levels.pressure,
        },
        swap: {
          used_gb: reading.swapUsedGigabytes,
          total_gb: reading.swapTotalGigabytes,
          level: levels.swap,
        },
        disk: { free_gb: reading.freeRootGigabytes, level: levels.disk },
        load: {
          one: reading.loadOne,
          five: reading.load,
          fifteen: reading.loadFifteen,
          level: levels.load,
        },
      };
      recordHistory(at, host);

      const agentRuns = new Map<string, string>();
      for (const [run, agents] of context.agents)
        for (const agent of agents)
          if (agent.terminal !== null && !agentRuns.has(agent.terminal))
            agentRuns.set(agent.terminal, run);
      const lock = readTestLock(false);
      const holders = new Map(lock.running.map((ticket) => [ticket.pid, ticket.run]));
      const byPid = new Map(table.map((row) => [row.pid, row]));
      const admissionOf = (row: ProcessRow): string | undefined => {
        let current: ProcessRow | undefined = row;
        for (let depth = 0; current !== undefined && depth < 64; depth++) {
          const held = holders.get(current.pid) ?? holders.get(current.group);
          if (held !== undefined) return held;
          current = current.parent === current.pid ? undefined : byPid.get(current.parent);
        }
        return undefined;
      };

      const next = new Map<number, { cpuSeconds: number; at: number }>();
      const processes: Measured[] = [];
      for (const row of table) {
        next.set(row.pid, { cpuSeconds: row.cpuSeconds, at });
        const { command, handle } = splitProcessText(row.text);
        const cwd = directories?.get(row.pid);
        const folderOf = (closed: boolean) =>
          cwd === undefined
            ? undefined
            : context.runs.find((found) => found.closed === closed && inside(cwd, found.directory));
        let owner: ProcessOwner;
        const admitted = admissionOf(row);
        if (handle !== null && agentRuns.has(handle)) owner = { kind: "agent", handle };
        else if (folderOf(false)) owner = { kind: "run", run: folderOf(false)!.run };
        else if (admitted !== undefined) owner = { kind: "admission", run: admitted };
        else if (folderOf(true)) owner = { kind: "leftover", run: folderOf(true)!.run };
        else owner = { kind: "other" };
        const before = previous.get(row.pid);
        const span = before === undefined ? 0 : (at - before.at) / 1000;
        processes.push({
          pid: row.pid,
          kind: kindOf(command),
          cpu_percent:
            before === undefined || span <= 0 || row.cpuSeconds < before.cpuSeconds
              ? null
              : Math.round(((row.cpuSeconds - before.cpuSeconds) / span) * 1000) / 10,
          memory_mb: Math.round(row.rssKilobytes / 1024),
          age_seconds: row.ageSeconds,
          command,
          owner,
          cpu_seconds: row.cpuSeconds,
        });
      }
      previous = next;

      const owned = processes.filter((found) => found.owner.kind !== "other");
      const others = processes
        .filter((found) => found.owner.kind === "other")
        .sort((left, right) => right.memory_mb - left.memory_mb)
        .slice(0, otherLimit);
      writeRuns(at, context, owned);
      return {
        host,
        admission: {
          holders: lock.running.map((ticket) => ({
            run: ticket.run,
            cores: ticket.cores,
            held_seconds: Math.max(0, Math.round((at - Date.parse(ticket.started!)) / 1000)),
          })),
          waiting: lock.waiting.map((ticket) => ({
            run: ticket.run,
            cores: ticket.cores,
            waited_seconds: Math.max(0, Math.round((at - Date.parse(ticket.arrival)) / 1000)),
          })),
        },
        processes: [...owned, ...others].map(({ cpu_seconds: _cpuSeconds, ...found }) => found),
        degraded: directories === null,
      };
    },

    /** The history of each host signal, 24 hours back from now, thinned for the page. */
    history(): ResourcesHistory {
      prune(now());
      return Object.fromEntries(
        signals.map((signal) => [
          signal,
          thin(history.get(signal)!, historyPointLimit).map((point) => ({
            ts: new Date(point.ms).toISOString(),
            value: point.value,
          })),
        ]),
      ) as ResourcesHistory;
    },

    /** The hub pauses (no page) or stops: keeps the time of each run's last sample in its file, so the next sample records the gap. */
    flush(): void {
      for (const [, { at, directory }] of lastSampled)
        updateResources(directory, (current) => {
          current.sampled_until = new Date(at).toISOString();
        });
      lastSampled.clear();
      stamped.clear();
    },
  };
}
