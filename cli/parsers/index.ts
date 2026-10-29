import { parseBehave } from "./behave.ts";
import { parseBun } from "./bun.ts";
import { parsePytest } from "./pytest.ts";

export type TestResult = { name: string; criteria: string[]; status: "passed" | "failed" | "skipped" };
export type Parser = (input: { report: string; stdout: string }) => TestResult[];

export const parsers: Record<string, Parser> = { bun: parseBun, pytest: parsePytest, behave: parseBehave };
