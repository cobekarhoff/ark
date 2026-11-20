import type { CaseEntry } from "./test-case.ts";
import type { TestResult } from "./parsers/index.ts";

export type TimeLimits = {
  name: string;
  time_budget_s?: number;
  slow_test_s?: number;
  on_over?: "warn" | "fail";
};

const seconds = (value: number): string => `${Number(value.toFixed(2))} s`;
const marker = (word: string): string => word.padEnd(11);

/** The slow reason of a test: the reason of every case id it carries, or undefined when it has no id or an id has none. A retired entry gives none. */
function excuseOf(result: TestResult, entries: Map<string, CaseEntry>): string | undefined {
  if (result.cases.length === 0) return undefined;
  const reasons: string[] = [];
  for (const id of result.cases) {
    const entry = entries.get(id);
    if (entry === undefined || entry.status !== "active" || entry.slow_reason === undefined)
      return undefined;
    reasons.push(entry.slow_reason);
  }
  return result.cases.length === 1
    ? reasons[0]
    : result.cases.map((id, index) => `${id}: ${reasons[index]}`).join("; ");
}

/**
 * The time verdict of one head suite, made from the results after cache replay and file retry and from the limits
 * of the current ark.yml; nothing of it is stored. Null when the suite sets no key.
 * A quick run runs part of a suite: it lists slow tests, never judges the suite time, and never fails.
 * A test with no `duration_s` is never slow. `failed` is set only by `on_over: fail` with a suite over its budget
 * or a slow test that no slow reason excuses.
 */
export function timeVerdict(input: {
  suite: TimeLimits;
  results: TestResult[];
  suiteSeconds: number | undefined;
  reused: boolean;
  quick: boolean;
  entries: CaseEntry[];
}): { lines: string[]; failed: boolean } | null {
  const { suite, results, suiteSeconds, reused, quick } = input;
  const { time_budget_s: budget, slow_test_s: limit } = suite;
  if (budget === undefined && limit === undefined && suite.on_over === undefined) return null;
  const mode = !quick && suite.on_over === "fail" ? "failure" : "warning";
  const lines: string[] = [];
  let failed = false;

  const missing = [
    ...(!quick && budget !== undefined && suiteSeconds === undefined ? ["suite time"] : []),
    ...(limit !== undefined &&
    results.length > 0 &&
    results.every((result) => result.duration_s === undefined)
      ? ["test times"]
      : []),
  ];
  if (!quick && suiteSeconds !== undefined)
    lines.push(`${marker("time")}suite ${suite.name}  ${seconds(suiteSeconds)}`);
  if (missing.length > 0)
    lines.push(
      `${marker("time")}suite ${suite.name}  no ${missing.join(" and ")} in the ${reused ? "reused result" : "report"}: not judged`,
    );

  if (limit !== undefined) {
    const entries = new Map(input.entries.map((entry) => [entry.id, entry]));
    const slow = results
      .filter((result) => result.duration_s !== undefined && result.duration_s > limit)
      .sort((a, b) => b.duration_s! - a.duration_s! || a.name.localeCompare(b.name));
    for (const result of slow) {
      const excuse = excuseOf(result, entries);
      const what = `${result.file === undefined ? "" : `${result.file}  `}${result.name}  ${seconds(result.duration_s!)}  over slow_test_s ${limit}`;
      if (excuse !== undefined)
        lines.push(`${marker("slow")}${suite.name}  ${what}  reason: ${excuse}`);
      else {
        lines.push(`${marker(mode)}slow test  ${suite.name}  ${what}  (no slow_reason)`);
        failed ||= mode === "failure";
      }
    }
  }
  if (!quick && budget !== undefined && suiteSeconds !== undefined && suiteSeconds > budget) {
    lines.push(
      `${marker(mode)}suite ${suite.name}  ${seconds(suiteSeconds)}  over time_budget_s ${budget}`,
    );
    failed ||= mode === "failure";
  }
  return { lines, failed };
}
