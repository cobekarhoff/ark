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

/** Number of logged calls whose line contains `text`. */
export function logged(text: string): number {
  if (!existsSync(logFile)) return 0;
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter((line) => line.includes(text)).length;
}

/**
 * FAKE_RACE_MR (JSON of a FakeMergeRequest): an MR another writer opens right after the first probe of the branch.
 * The first probe answers "none"; later probes see it.
 */
export function raceAfterFirstProbe(probeText: string, state: FakeMergeRequest[]): boolean {
  if (!process.env.FAKE_RACE_MR || logged(probeText) !== 1) return false;
  writeState([...state, JSON.parse(process.env.FAKE_RACE_MR)]);
  return true;
}

/** Appends the call to the log, with `body` when the call writes one. */
export function record(tool: string, argv: string[], body?: string) {
  appendFileSync(logFile, JSON.stringify({ tool, cwd: process.cwd(), argv, body }) + "\n");
}

export const option = (argv: string[], name: string) =>
  argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
