// Shared by the fake `gh` and `glab`: one call log (FAKE_LOG) and the open MRs of the fake host (FAKE_LOG + ".state").
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

export type FakeMergeRequest = {
  number: number;
  url: string;
  head: string;
  repo: string;
  body: string;
};

const logFile = process.env.FAKE_LOG!;
const stateFile = `${logFile}.state`;

export const owner = process.env.FAKE_TOKEN_OWNER ?? "cobekarhoff";
export const repo = basename(process.cwd());

export function readState(): FakeMergeRequest[] {
  return existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : [];
}

export function writeState(state: FakeMergeRequest[]) {
  writeFileSync(stateFile, JSON.stringify(state));
}

export function creates(): number {
  if (!existsSync(logFile)) return 0;
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter((line) => line.includes('"create"')).length;
}

/** Appends the call to the log, with `body` when the call writes one. */
export function record(tool: string, argv: string[], body?: string) {
  appendFileSync(logFile, JSON.stringify({ tool, cwd: process.cwd(), argv, body }) + "\n");
}

export const option = (argv: string[], name: string) =>
  argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
