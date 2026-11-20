// Fixtures for the companion tests (ARK-480): a temporary ARK_HOME with one project, the fake orca and
// gh of test/fake-companion-tools.ts, the test clock, and run folders written event by event.
import { afterEach, beforeEach, expect } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { now } from "../cli/clock.ts";
import { ark, tempArkHome, tempGitRepo, writeProject } from "./helpers.ts";
import { runDirectoryOf, writeRun } from "./hub-fixtures.ts";
import {
  installFakeCompanionTools,
  removeFakeCompanionTools,
  type FakeCompanionTools,
} from "./fake-companion-tools.ts";

export const project = "p";

export type CompanionEntry = {
  name: string;
  instructions: string;
  harness: string;
  model: string;
  on: string[];
};

/** A valid entry whose instructions file is `companions/<name>.md`. */
export const entry = (name: string, on: string[]): CompanionEntry => ({
  name,
  instructions: `companions/${name}.md`,
  harness: "omp",
  model: "test-model",
  on,
});

/** The text of the instructions file of `name`: a sync puts it in the spec of the worker. */
export const briefOf = (name: string): string => `BRIEF-OF-${name.toUpperCase()}`;

export type Scenario = {
  workspace: string;
  /** `$ARK_HOME/projects/p`. */
  folder: string;
  fake: FakeCompanionTools;
  /** Rewrites ark.yml with these companions (no `companions` key for undefined) and writes their instructions files. */
  save: (companions: CompanionEntry[] | undefined) => void;
  /** Rewrites ark.yml with `companions` exactly as given (any shape) and writes no instructions file. */
  raw: (companions: unknown) => void;
};

/** A fresh ARK_HOME, project `p` with a git workspace, and the fake orca and gh. Call it inside a test. */
export function scenario(companions: CompanionEntry[] | undefined): Scenario {
  tempArkHome();
  const workspace = tempGitRepo();
  const fake = installFakeCompanionTools({ project, workspace });
  const base = {
    workspace,
    ticket_source: "local",
    suites: [{ name: "unit", level: "unit", repo: ".", command: "true {report}", parser: "bun" }],
    roles: {
      implementer: { harness: "omp", model: "test-model" },
      validator: { harness: "omp", model: "test-model" },
      evaluator: { harness: "omp", model: "test-model" },
      reviewer: { harness: "omp", model: "test-model" },
    },
  };
  const folder = join(process.env.ARK_HOME as string, "projects", project);
  const save = (list: CompanionEntry[] | undefined) => {
    writeProject(project, list === undefined ? base : { ...base, companions: list });
    for (const listed of list ?? []) {
      mkdirSync(join(folder, dirname(listed.instructions)), { recursive: true });
      writeFileSync(join(folder, listed.instructions), `${briefOf(listed.name)}\n`);
    }
  };
  const raw = (value: unknown) => writeProject(project, { ...base, companions: value });
  save(companions);
  return { workspace, folder, fake, save, raw };
}

let savedClock: string | undefined;
const startOfTest = "2026-11-14T12:00:00.000Z";

/** Freezes the test clock (ARK_NOW, read by cli/clock.ts) for each test of the calling file, and removes the fakes afterwards. */
export function useCompanionTestEnvironment(): void {
  beforeEach(() => {
    savedClock = process.env.ARK_NOW;
    process.env.ARK_NOW = startOfTest;
  });
  afterEach(() => {
    removeFakeCompanionTools();
    if (savedClock === undefined) delete process.env.ARK_NOW;
    else process.env.ARK_NOW = savedClock;
  });
}

/** Moves the test clock forward. */
export function advance(seconds: number): void {
  process.env.ARK_NOW = new Date(now() + seconds * 1000).toISOString();
}

export const isoNow = (): string => new Date(now()).toISOString();

/** `ark <args> --project p`. */
export const arkP = (...args: string[]) => ark(...args, "--project", project);

/** The run id of ticket ARK-`number`. */
export const runId = (number: number): string => `2026-11-14-ARK-${number}-1`;

type Row = [type: string, data: Record<string, unknown>];

/** Appends one event to the run's log with the next seq and the test clock's time. */
export function appendRaw(run: string, type: string, data: Record<string, unknown>): void {
  const directory = runDirectoryOf(project, run);
  const file = join(directory, "events.ndjson");
  mkdirSync(directory, { recursive: true });
  const seq = existsSync(file)
    ? readFileSync(file, "utf8").split("\n").filter(Boolean).length + 1
    : 1;
  appendFileSync(file, `${JSON.stringify({ seq, time: isoNow(), type, data })}\n`);
}

/** `run.started` data of a run that opens the criteria gate at once, as every run does since ARK-311. */
export const startedData = (run: string): Record<string, unknown> => ({
  run,
  project,
  ticket: { id: run.slice(11, -2), title: `Ticket of ${run}` },
  criteria: [],
  round_budget: 3,
  criteria_gate: true,
});

/** The log of a run that started and closed `merged`. */
export const mergedRows = (run: string): Row[] => [
  ["run.started", startedData(run)],
  ["run.closed", { outcome: "merged" }],
];

/** Writes a run folder whose log holds `rows`, each with the test clock's time. */
export function rawRun(run: string, rows: Row[]): void {
  for (const [type, data] of rows) appendRaw(run, type, data);
}

/** The refusal of a command: exit 1, nothing on stdout, and exactly one `ark: ` line on stderr that holds each fragment. */
export function expectRefusal(
  result: { code: number; out: string; err: string },
  ...fragments: string[]
): void {
  expect(result.err.trim().split("\n")).toHaveLength(1);
  expect(result.err).toMatch(/^ark: /);
  for (const fragment of fragments) expect(result.err).toContain(fragment);
  expect(result.code).toBe(1);
  expect(result.out).toBe("");
}

/** The text of one `## ` section of `ark chief state`, up to the next section. */
export function sectionOf(output: string, heading: string): string {
  const part = output.split(/^## /m).find((candidate) => candidate.startsWith(heading));
  expect(part, `no section ${heading}`).toBeDefined();
  return part!;
}

/** The dispatch id `companions/<name>/worker.json` records. */
export const dispatchOf = (folder: string, name: string): string =>
  JSON.parse(readFileSync(join(folder, "companions", name, "worker.json"), "utf8")).dispatch;

export const readCursor = (folder: string, name: string) =>
  JSON.parse(readFileSync(join(folder, "companions", name, "cursor.json"), "utf8")) as {
    updated: string;
    runs: Record<string, { seq: number; time: string }>;
    ci: string[];
  };
export const pullRequest = "https://github.com/example/app/pull/7";

/** An open run in `merge_requests_open` whose MR is `pullRequest`, with its worktree at `workspace`. */
export function openMergeRequestRun(run: string, workspace: string): void {
  writeRun({
    project,
    run,
    ticket: { id: run.slice(11, -2), title: `Ticket of ${run}` },
    phase: "merge_requests_open",
    mergeRequests: [{ repo: ".", url: pullRequest, number: 7 }],
    worktrees: [{ repo: ".", path: workspace, branch: "ark/test" }],
  });
}
