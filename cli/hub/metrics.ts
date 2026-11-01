import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveState, readEvents } from "../events.ts";
import { listProjects, runsDirectory } from "../paths.ts";

export type Unavailable<T> = T | "unavailable";

const dayMilliseconds = 86_400_000;

/** Weeks run Monday 00:00 UTC to the next Monday. A run belongs to the week it closed in. */
export function weekStart(time: number): number {
  const day = Math.floor(time / dayMilliseconds) * dayMilliseconds;
  // 1970-01-01 was a Thursday, so day 0 is 3 days after a Monday.
  return day - ((((day / dayMilliseconds + 3) % 7) + 7) % 7) * dayMilliseconds;
}

const median = (values: number[]): Unavailable<number> => {
  if (values.length === 0) return "unavailable";
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const numberAt = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export type RunMetrics = {
  run: string;
  project: string;
  outcome: string;
  closed_at: string;
  cost_usd: number | null;
  wall_seconds: number | null;
  gate_wait_seconds: number | null;
  override_rate: number | null;
  design_rounds: number | null;
};

export type MetricsAnswer = {
  week: { start: string; end: string };
  runs: RunMetrics[];
  unreadable: { run: string; project: string; error: string }[];
  runs_by_outcome: Record<string, number>;
  cost_by_day: { day: string; usd: Unavailable<number>; includes_unknown: boolean }[];
  median_wall_seconds: Unavailable<number>;
  median_gate_wait_seconds: Unavailable<number>;
  override_rate: { value: Unavailable<number>; runs_with_value: number };
  design_rounds: { value: Unavailable<number>; runs_with_value: number };
};

/**
 * The Metrics API for one week: `week` is any date inside it (`YYYY-MM-DD`), default this week.
 * `project` limits the runs to one project.
 * Values come from each closed run's `metrics.json`. A value the file does not hold is `unavailable`, never 0.
 */
export function readMetrics(
  week: string | null,
  project: string | null = null,
  now = Date.now(),
): MetricsAnswer {
  const requested = week === null ? now : Date.parse(week);
  if (Number.isNaN(requested)) throw new Error("week must be a date such as 2026-11-02");
  const start = weekStart(requested);
  const end = start + 7 * dayMilliseconds;

  const runs: RunMetrics[] = [];
  const unreadable: { run: string; project: string; error: string }[] = [];
  for (const name of listProjects()) {
    if (project !== null && name !== project) continue;
    const root = runsDirectory(name);
    if (!existsSync(root)) continue;
    for (const run of readdirSync(root).sort()) {
      const directory = join(root, run);
      const metricsFile = join(directory, "metrics.json");
      if (!existsSync(metricsFile)) continue;
      const events = readEvents(directory);
      const closed = events.findLast((event) => event.type === "run.closed");
      if (!closed) continue;
      const time = Date.parse(closed.time);
      if (time < start || time >= end) continue;
      try {
        const metrics = JSON.parse(readFileSync(metricsFile, "utf8"));
        runs.push({
          run,
          project: name,
          outcome: deriveState(events).outcome ?? "unknown",
          closed_at: closed.time,
          cost_usd: numberAt(metrics.cost?.total_usd),
          wall_seconds: numberAt(metrics.time?.wall_seconds),
          gate_wait_seconds: numberAt(metrics.time?.gate_wait_seconds),
          override_rate: numberAt(metrics.override_rate),
          design_rounds: numberAt(metrics.design_rounds),
        });
      } catch (err) {
        unreadable.push({ run, project: name, error: (err as Error).message });
      }
    }
  }

  const outcomes: Record<string, number> = {};
  for (const run of runs) outcomes[run.outcome] = (outcomes[run.outcome] ?? 0) + 1;

  const days = new Map<string, { usd: number; includes_unknown: boolean; known: number }>();
  for (const run of runs) {
    const day = run.closed_at.slice(0, 10);
    const entry = days.get(day) ?? { usd: 0, includes_unknown: false, known: 0 };
    if (run.cost_usd === null) entry.includes_unknown = true;
    else {
      entry.usd += run.cost_usd;
      entry.known += 1;
    }
    days.set(day, entry);
  }

  const known = (pick: (run: RunMetrics) => number | null) =>
    runs.flatMap((run) => pick(run) ?? []);
  const overrides = known((run) => run.override_rate);
  const rounds = known((run) => run.design_rounds);

  return {
    week: {
      start: new Date(start).toISOString().slice(0, 10),
      end: new Date(end - dayMilliseconds).toISOString().slice(0, 10),
    },
    runs,
    unreadable,
    runs_by_outcome: outcomes,
    // A day whose runs have no known cost shows `unavailable`; a mix shows the known sum and says some cost is missing.
    cost_by_day: [...days]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([day, entry]) => ({
        day,
        usd: entry.known === 0 ? ("unavailable" as const) : entry.usd,
        includes_unknown: entry.includes_unknown,
      })),
    median_wall_seconds: median(known((run) => run.wall_seconds)),
    median_gate_wait_seconds: median(known((run) => run.gate_wait_seconds)),
    override_rate: {
      value: overrides.length
        ? overrides.reduce((sum, value) => sum + value, 0) / overrides.length
        : ("unavailable" as const),
      runs_with_value: overrides.length,
    },
    design_rounds: {
      value: rounds.length
        ? rounds.reduce((sum, value) => sum + value, 0)
        : ("unavailable" as const),
      runs_with_value: rounds.length,
    },
  };
}
