import { parseBehave } from "./behave.ts";
import { parseBun } from "./bun.ts";
import { parsePytest } from "./pytest.ts";

export type TestResult = {
  name: string;
  /** Old AC ids the test carries (`<ticket>-AC<k>`). */
  criteria: string[];
  /** Test case ids `<KEY>-T<n>` the test carries. */
  cases: string[];
  status: "passed" | "failed" | "skipped";
  /** The test file, when the report names it, relative to the suite's repo. */
  file?: string;
  /** Seconds the test took, when the report gives them. Absent: the test is never slow. */
  duration_s?: number;
};
export type Parser = (input: { report: string; stdout: string }) => TestResult[];

export const parsers: Record<string, Parser> = {
  bun: parseBun,
  pytest: parsePytest,
  behave: parseBehave,
};

/** The `time` of the report root (`<testsuites>`, or the first `<testsuite>` when the root has none), in seconds; undefined when the report gives none. The suite time of a JUnit report. */
export function suiteSecondsOf(report: string): number | undefined {
  const time = report.match(/<testsuites?\b[^>]*?\btime="([^"]*)"/)?.[1];
  const seconds = time === undefined || time === "" ? NaN : Number(time);
  return Number.isFinite(seconds) ? seconds : undefined;
}
