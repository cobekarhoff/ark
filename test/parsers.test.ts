import { expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseBun } from "../cli/parsers/bun";
import { parseBehave } from "../cli/parsers/behave";
import { parsePytest } from "../cli/parsers/pytest";
import type { TestResult } from "../cli/parsers/index";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

// Real output: `pytest -o junit_family=xunit1 --junitxml=...` and `behave --format json -o ...`
// run on throwaway projects (pytest 8, behave 1.3.3).
const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "fixtures/parsers", name), "utf8");

// The file of each result is asserted in its own test below.
const bare = (results: TestResult[]) => results.map(({ file: _file, ...rest }) => rest);

test("ARK-158-AC5 pytest maps ac markers to per-test results", () => {
  const results = parsePytest({ report: fixture("pytest-report.xml"), stdout: "" });
  expect(bare(results)).toEqual([
    { name: "test_sample::test_passes", criteria: ["CLARA-12-AC1"], cases: [], status: "passed" },
    {
      name: "test_sample::test_fails",
      criteria: ["CLARA-12-AC2", "CLARA-12-AC3"],
      cases: [],
      status: "failed",
    },
    { name: "test_sample::test_skipped", criteria: [], cases: [], status: "skipped" },
    { name: "test_sample::test_untagged", criteria: [], cases: [], status: "passed" },
  ]);
});

test("ARK-158-AC5 behave maps feature and scenario tags to per-scenario results", () => {
  const results = parseBehave({ report: fixture("behave-report.json"), stdout: "" });
  expect(bare(results)).toEqual([
    { name: "Other: Untagged", criteria: [], cases: [], status: "passed" },
    { name: "Sample: Passes", criteria: ["CLARA-12-AC1"], cases: [], status: "passed" },
    {
      name: "Sample: Fails",
      criteria: ["CLARA-12-AC1", "CLARA-12-AC2"],
      cases: [],
      status: "failed",
    },
    {
      name: "Sample: Skipped",
      criteria: ["CLARA-12-AC1", "CLARA-12-AC3"],
      cases: [],
      status: "skipped",
    },
    {
      name: "Sample: Outline 1 -- @1.1",
      criteria: ["CLARA-12-AC1", "CLARA-12-AC5"],
      cases: [],
      status: "passed",
    },
  ]);
});

test("ARK-158-AC5 an empty report is an error, not zero results", () => {
  expect(() => parsePytest({ report: "", stdout: "" })).toThrow("pytest report has no test cases");
  expect(() => parseBehave({ report: "", stdout: "" })).toThrow("behave report is empty");
});

// ARK-311-AC1: all three reports are real, one per runner, captured from the same five cases: case id,
// old AC id, both, neither, and the slash form `ARK-9/AC1`. Bun source (`a.test.ts`, run with
// `bun test --reporter=junit --reporter-outfile=bun-report.xml`): five `test("<title>", () => {})` calls titled
// `ARK-T12 case only`, `CLARA-12-AC1 old only`, `ARK-T13 CLARA-12-AC2 both`, `neither`, `ARK-9/AC1 slash`.
// pytest and behave sources are in fixtures/parsers/suites/, run through `uv run --with pytest --with behave`:
//   pytest -o junit_family=xunit1 --junitxml=pytest-cases-report.xml
//   behave --format json -o behave-cases-report.json
test("ARK-311-AC1 bun reads case ids and old AC ids from the JUnit title into cases and criteria", () => {
  expect(parseBun({ report: fixture("bun-report.xml"), stdout: "" })).toEqual([
    {
      name: "ARK-T12 case only",
      criteria: [],
      cases: ["ARK-T12"],
      status: "passed",
      file: "a.test.ts",
    },
    {
      name: "CLARA-12-AC1 old only",
      criteria: ["CLARA-12-AC1"],
      cases: [],
      status: "passed",
      file: "a.test.ts",
    },
    {
      name: "ARK-T13 CLARA-12-AC2 both",
      criteria: ["CLARA-12-AC2"],
      cases: ["ARK-T13"],
      status: "passed",
      file: "a.test.ts",
    },
    { name: "neither", criteria: [], cases: [], status: "passed", file: "a.test.ts" },
    {
      name: "ARK-9/AC1 slash",
      criteria: ["ARK-9/AC1"],
      cases: [],
      status: "passed",
      file: "a.test.ts",
    },
  ]);
});

test("ARK-311-AC1 pytest reads case properties into cases and ac properties into criteria", () => {
  expect(bare(parsePytest({ report: fixture("pytest-cases-report.xml"), stdout: "" }))).toEqual([
    { name: "test_cases::test_case_only", criteria: [], cases: ["ARK-T12"], status: "passed" },
    {
      name: "test_cases::test_ac_only",
      criteria: ["CLARA-12-AC1"],
      cases: [],
      status: "passed",
    },
    {
      name: "test_cases::test_both",
      criteria: ["CLARA-12-AC2"],
      cases: ["ARK-T13", "ARK-T14"],
      status: "passed",
    },
    { name: "test_cases::test_neither", criteria: [], cases: [], status: "passed" },
    { name: "test_cases::test_slash", criteria: ["ARK-9/AC1"], cases: [], status: "passed" },
  ]);
});

test("ARK-311-AC1 behave reads @ARK-T12 and @case:ARK-T12 tags into cases and AC tags into criteria", () => {
  expect(bare(parseBehave({ report: fixture("behave-cases-report.json"), stdout: "" }))).toEqual([
    { name: "Cases: Case only", criteria: [], cases: ["ARK-T12"], status: "passed" },
    { name: "Cases: Case with prefix", criteria: [], cases: ["ARK-T15"], status: "passed" },
    { name: "Cases: Old only", criteria: ["CLARA-12-AC1"], cases: [], status: "passed" },
    {
      name: "Cases: Both",
      criteria: ["CLARA-12-AC2"],
      cases: ["ARK-T13"],
      status: "passed",
    },
    { name: "Cases: Neither", criteria: [], cases: [], status: "passed" },
    { name: "Cases: Slash", criteria: ["ARK-9/AC1"], cases: [], status: "passed" },
  ]);
});

test("pytest and behave results carry the repo-relative file of each test", () => {
  const files = (results: TestResult[]) => [...new Set(results.map((result) => result.file))];
  expect(files(parsePytest({ report: fixture("pytest-cases-report.xml"), stdout: "" }))).toEqual([
    "test_cases.py",
  ]);
  expect(files(parseBehave({ report: fixture("behave-cases-report.json"), stdout: "" }))).toEqual([
    "features/cases.feature",
  ]);
});
