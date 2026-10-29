import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseBehave } from "../cli/parsers/behave";
import { parsePytest } from "../cli/parsers/pytest";

// Real output: `pytest -o junit_family=xunit1 --junitxml=...` and `behave --format json -o ...`
// run on throwaway projects (pytest 8, behave 1.3.3).
const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures/parsers", name), "utf8");

test("ARK-158-AC5 pytest maps ac markers to per-test results", () => {
  const results = parsePytest({ report: fixture("pytest-report.xml"), stdout: "" });
  expect(results).toEqual([
    { name: "test_sample::test_passes", criteria: ["CLARA-12-AC1"], status: "passed" },
    { name: "test_sample::test_fails", criteria: ["CLARA-12-AC2", "CLARA-12-AC3"], status: "failed" },
    { name: "test_sample::test_skipped", criteria: [], status: "skipped" },
    { name: "test_sample::test_untagged", criteria: [], status: "passed" },
  ]);
});

test("ARK-158-AC5 behave maps feature and scenario tags to per-scenario results", () => {
  const results = parseBehave({ report: fixture("behave-report.json"), stdout: "" });
  expect(results).toEqual([
    { name: "Other: Untagged", criteria: [], status: "passed" },
    { name: "Sample: Passes", criteria: ["CLARA-12-AC1"], status: "passed" },
    { name: "Sample: Fails", criteria: ["CLARA-12-AC1", "CLARA-12-AC2"], status: "failed" },
    { name: "Sample: Skipped", criteria: ["CLARA-12-AC1", "CLARA-12-AC3"], status: "skipped" },
    { name: "Sample: Outline 1 -- @1.1", criteria: ["CLARA-12-AC1", "CLARA-12-AC5"], status: "passed" },
  ]);
});

test("ARK-158-AC5 an empty report is an error, not zero results", () => {
  expect(() => parsePytest({ report: "", stdout: "" })).toThrow("pytest report has no test cases");
  expect(() => parseBehave({ report: "", stdout: "" })).toThrow("behave report is empty");
});
