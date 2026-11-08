import type { StepWindow } from "../cli/usage/owners.ts";
import type { RoleTimes } from "./types.ts";

/** Nearest-rank percentile of a sorted list. */
const percentile = (sorted: number[], fraction: number): number =>
  sorted[Math.ceil(sorted.length * fraction) - 1];

const medianOf = (sorted: number[]): number => {
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * Median and p90 of the seconds a step took, by role, from the finished steps (`step.started` to
 * `step.finished`) of the given closed runs. A step still open has no time yet.
 */
export function roleTimesOf(closedRuns: StepWindow[][]): RoleTimes {
  const seconds = new Map<string, number[]>();
  for (const windows of closedRuns)
    for (const window of windows) {
      if (window.end === null) continue;
      const list = seconds.get(window.role) ?? [];
      list.push((window.end - window.start) / 1000);
      seconds.set(window.role, list);
    }
  return Object.fromEntries(
    [...seconds].map(([role, list]) => {
      list.sort((left, right) => left - right);
      return [role, { median: medianOf(list), p90: percentile(list, 0.9), count: list.length }];
    }),
  );
}

const minutes = (seconds: number): number => Math.round(seconds / 60);

/** `implementer 6 min · typical 3 · slow above 18`. No closed run of the role: no comparison, and never an ETA. */
export function stepTimeText(
  role: string,
  elapsedSeconds: number,
  times: RoleTimes[string] | undefined,
): string {
  const elapsed = `${role} ${minutes(elapsedSeconds)} min`;
  return times
    ? `${elapsed} · typical ${minutes(times.median)} · slow above ${minutes(times.p90)}`
    : elapsed;
}
