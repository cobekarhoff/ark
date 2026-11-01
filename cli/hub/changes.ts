import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { arkHome } from "../paths.ts";
import { execJson } from "./exec.ts";

/**
 * The hub's own history, `$ARK_HOME/hub/history.ndjson`. Orca, gh and Plannotator report only
 * the present, so the hub writes down what it sees. One JSON object on each line:
 *
 * - `collector.started`: the hub began collecting. Nothing is known before the first one.
 * - `collector.tick`: the hub was still collecting at this time. One each minute.
 * - `state.changed`: `key` (`agent:<run>:<terminal>`, `chief:<project>` or `ci:<MR url>`) now has
 *   `state` and, for agents, `activity`. A refresh that finds no change writes no line.
 *
 * Time with no collector is not history. From the last line before a crash to the next
 * `collector.started`, state is "unavailable". The hub never invents a past state.
 */
export type HistoryEvent = {
  time: string;
  type: "collector.started" | "collector.tick" | "state.changed";
  key?: string;
  state?: string;
  activity?: string;
};

export type Observed = { state: string; activity?: string };
export type Interval = { from: string; to: string };

export const tickMilliseconds = 60_000;
/** A collector that wrote nothing for this long is down; one that did is still collecting now. */
const staleAfterMilliseconds = tickMilliseconds * 2;

const historyFile = () => join(arkHome(), "hub", "history.ndjson");

/** Every history line in order. Lines that do not parse (a half-written last line) are skipped. */
export function readHistory(): HistoryEvent[] {
  const file = historyFile();
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as HistoryEvent];
      } catch {
        return [];
      }
    });
}

/**
 * The spans the collector was running: from each `collector.started` to the last line before the
 * next one. The last span runs to `now` while the collector is fresh, and to its last line after.
 */
export function collectedIntervals(events: HistoryEvent[], now: string): Interval[] {
  const intervals: Interval[] = [];
  let current: Interval | null = null;
  for (const event of events) {
    if (event.type === "collector.started") {
      if (current) intervals.push(current);
      current = { from: event.time, to: event.time };
    } else if (current) {
      current.to = event.time;
    }
  }
  if (current) {
    const fresh = Date.parse(now) - Date.parse(current.to) <= staleAfterMilliseconds;
    intervals.push(fresh ? { from: current.from, to: now } : current);
  }
  return intervals;
}

/**
 * What the collector saw for `key` at `at`: "unavailable" before collection or inside a gap, null
 * when the collector ran and saw no such thing (or saw it gone), else its state. Only lines inside
 * the same span count, because every start sees each key again.
 */
export function stateAt(
  events: HistoryEvent[],
  key: string,
  at: string,
  now: string,
): Observed | "unavailable" | null {
  const time = Date.parse(at);
  const span = collectedIntervals(events, now).find(
    (interval) => Date.parse(interval.from) <= time && time <= Date.parse(interval.to),
  );
  if (!span) return "unavailable";
  const last = events.findLast(
    (event) =>
      event.type === "state.changed" &&
      event.key === key &&
      Date.parse(event.time) >= Date.parse(span.from) &&
      Date.parse(event.time) <= time,
  );
  if (!last || last.state === "gone") return null;
  return { state: last.state!, activity: last.activity };
}

/** `gh pr checks` exits 1 for a failing check and 8 for a pending one, and still prints the checks. */
const ghChecksExitCodes = [0, 1, 8];

/** The CI state of each MR, "unknown" when gh fails or is slow. Never "failing" or "passing" by guess. */
export async function readCi(urls: string[]): Promise<Map<string, Observed>> {
  const states = await Promise.all(
    urls.map(async (url): Promise<[string, Observed]> => {
      const checks = await execJson<{ bucket?: string }[]>(
        ["gh", "pr", "checks", url, "--json", "bucket"],
        undefined,
        ghChecksExitCodes,
      );
      const buckets = new Set((checks ?? []).map((check) => check.bucket));
      const state = !checks
        ? "unknown"
        : buckets.has("fail")
          ? "failing"
          : buckets.has("pending")
            ? "pending"
            : buckets.size > 0
              ? "passing"
              : "none";
      return [`ci:${url}`, { state }];
    }),
  );
  return new Map(states);
}

/**
 * Appends changes to the history log. The hub's refresh loop calls `record` with what its readers
 * saw. The first call writes `collector.started` and every state, then only changes. A key that
 * disappears is written as "gone"; a key whose reader failed (its prefix is in `failedPrefixes`)
 * is written as "unknown".
 */
export function createCollector() {
  const known = new Map<string, Observed>();
  let lastTick = 0;
  let started = false;

  return {
    record(observed: Map<string, Observed>, failedPrefixes: string[], now = new Date()): void {
      const time = now.toISOString();
      const lines: HistoryEvent[] = [];
      if (!started) {
        started = true;
        lines.push({ time, type: "collector.started" });
        lastTick = now.getTime();
      } else if (now.getTime() - lastTick >= tickMilliseconds) {
        lines.push({ time, type: "collector.tick" });
        lastTick = now.getTime();
      }

      const next = new Map(observed);
      for (const key of known.keys()) {
        if (next.has(key)) continue;
        const failed = failedPrefixes.some((prefix) => key.startsWith(prefix));
        next.set(key, { state: failed ? "unknown" : "gone" });
      }
      for (const [key, value] of next) {
        const before = known.get(key);
        if (before?.state === value.state && before.activity === value.activity) continue;
        if (!before && value.state === "gone") continue;
        lines.push({
          time,
          type: "state.changed",
          key,
          state: value.state,
          activity: value.activity,
        });
        if (value.state === "gone") known.delete(key);
        else known.set(key, value);
      }

      if (lines.length === 0) return;
      mkdirSync(join(arkHome(), "hub"), { recursive: true });
      appendFileSync(historyFile(), lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
    },
  };
}
