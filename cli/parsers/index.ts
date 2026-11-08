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
  /** The test file, when the report names it (the `bun` parser does). */
  file?: string;
};
export type Parser = (input: { report: string; stdout: string }) => TestResult[];

export const parsers: Record<string, Parser> = {
  bun: parseBun,
  pytest: parsePytest,
  behave: parseBehave,
};
