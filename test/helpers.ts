import { afterAll, beforeAll } from "bun:test";
import type { Subprocess } from "bun";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendEvent, deriveState, readEvents } from "../cli/events.ts";
import { fakeToolScripts, writeFakeToolState, type FakeToolOptions } from "./hub-fixtures.ts";

const repositoryRoot = join(import.meta.dir, "..");

export function tempArkHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ark-home-"));
  process.env.ARK_HOME = home;
  return home;
}

/** Writes `$ARK_HOME/projects/<name>/ark.yml`. JSON is valid YAML, so the config is written as JSON. */
export function writeProject(name: string, config: Record<string, unknown>): string {
  const directory = join(process.env.ARK_HOME as string, "projects", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "ark.yml"), JSON.stringify(config, null, 2));
  return directory;
}

export function writeTicket(
  project: string,
  id: string,
  criteria: { id: string; text: string; manual?: boolean }[],
  title = `Ticket ${id}`,
): string {
  const file = join(process.env.ARK_HOME as string, "projects", project, "tickets", `${id}.md`);
  mkdirSync(dirname(file), { recursive: true });
  const frontmatter = [
    "---",
    `id: ${id}`,
    `title: ${JSON.stringify(title)}`,
    "status: ready",
    ...(criteria.length === 0 ? ["acceptance_criteria: []"] : ["acceptance_criteria:"]),
  ];
  for (const criterion of criteria)
    frontmatter.push(
      `  - id: ${criterion.id}`,
      `    text: ${JSON.stringify(criterion.text)}`,
      ...(criterion.manual ? ["    manual: true"] : []),
    );
  writeFileSync(file, `${frontmatter.join("\n")}\n---\n## Why\n\nTest ticket.\n`);
  return file;
}

function git(directory: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: directory });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
}

export function tempGitRepo(files: Record<string, string> = { "README.md": "# test\n" }): string {
  const directory = mkdtempSync(join(tmpdir(), "ark-repo-"));
  git(directory, "init", "-q", "-b", "main");
  git(directory, "config", "user.name", "Ark Test");
  git(directory, "config", "user.email", "ark@example.com");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, name)), { recursive: true });
    writeFileSync(join(directory, name), content);
  }
  git(directory, "add", "-A");
  git(directory, "commit", "-q", "-m", "initial");
  return directory;
}

export function ark(...args: string[]): { code: number; out: string; err: string } {
  const result = Bun.spawnSync(["bun", join(repositoryRoot, "cli", "ark.ts"), ...args], {
    env: process.env,
  });
  return {
    code: result.exitCode ?? 1,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
  };
}

/** Writes an executable `<name>` with the given shell script and puts it first on PATH. Callers restore PATH. */
export function writeFakeCommand(name: string, script: string): string {
  const directory = mkdtempSync(join(tmpdir(), `ark-${name}-`));
  const file = join(directory, name);
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
  process.env.PATH = `${directory}:${process.env.PATH}`;
  return directory;
}

/** A fresh state folder for the fake `orca`, `gh`, `omp` and `plannotator`; puts the four on PATH. */
export function installFakeTools(options: FakeToolOptions): string {
  const state = mkdtempSync(join(tmpdir(), "ark-fake-tools-"));
  writeFakeToolState(state, options);
  const scripts = fakeToolScripts(state);
  writeFakeCommand("orca", scripts.orca);
  writeFakeCommand("gh", scripts.gh);
  writeFakeCommand("omp", scripts.omp);
  writeFakeCommand("plannotator", scripts.plannotator);
  return state;
}

export type StartedHub = {
  process: Subprocess<"ignore", "pipe", "pipe">;
  baseUrl: string;
};

/** Starts `bun hub/main.ts --port 0` and resolves once it prints its address. The caller stops it with `stopHub`. */
export async function startHub(): Promise<StartedHub> {
  const hub = Bun.spawn(["bun", join(repositoryRoot, "hub", "main.ts"), "--port", "0"], {
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let output = "";
  for await (const chunk of hub.stdout) {
    output += new TextDecoder().decode(chunk);
    const port = output.match(/127\.0\.0\.1:(\d+)/)?.[1];
    if (port) return { process: hub, baseUrl: `http://127.0.0.1:${port}` };
  }
  throw new Error(`the hub exited before serving: ${output}`);
}

export async function stopHub(hub: { kill(): void; exited: Promise<number> }): Promise<void> {
  hub.kill();
  await hub.exited;
}

/**
 * Records an evaluation the way ark evaluation record does. A clear evaluation that leaves the run
 * in planning also records a one-card strategy, so the run can pass ark plan check.
 */
export function recordEvaluation(
  runDirectory: string,
  blockers: string[] = [],
  risks: string[] = [],
): void {
  appendEvent(runDirectory, "evaluation.recorded", { blockers, risks, surfaces: ["none"] });
  if (deriveState(readEvents(runDirectory)).phase !== "planning") return;
  appendEvent(runDirectory, "strategy.recorded", {
    count: 1,
    recommended: "S1",
    cards: ["S1"],
    reason: "the only approach fits",
    card_text: { S1: "### S1 Only" },
  });
}

/** Freezes the hub clock for the calling test file: keeps a caller's ARK_NOW, else sets a fixed mid-week instant, and restores the variable afterwards. `ark ui` subprocesses inherit it. */
export function useFrozenClock(): void {
  let previous: string | undefined;
  beforeAll(() => {
    previous = process.env.ARK_NOW;
    if ((previous ?? "") === "") process.env.ARK_NOW = "2026-11-04T12:00:00Z";
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.ARK_NOW;
    else process.env.ARK_NOW = previous;
  });
}

/** The frozen hub clock (ARK_NOW, the variable cli/clock.ts reads), in epoch milliseconds. */
export function testNow(): number {
  return Date.parse(process.env.ARK_NOW as string);
}

/** ISO instant `millisecondsAgo` before the frozen clock. */
export function isoAgo(millisecondsAgo: number): string {
  return new Date(testNow() - millisecondsAgo).toISOString();
}

/** Dated `YYYY/MM/DD` folder segments of the frozen clock's UTC day, as Codex lays out its sessions. */
export function codexDay(): [string, string, string] {
  const [year, month, day] = new Date(testNow()).toISOString().slice(0, 10).split("-");
  return [year, month, day];
}
