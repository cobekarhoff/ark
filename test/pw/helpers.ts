// Node-safe helpers for the Playwright specs. No bun:test, no Bun.* globals: Playwright runs under Node.
import { test, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendEvent, deriveState, readEvents } from "../../cli/events.ts";
import { casePattern } from "../../cli/parsers/case.ts";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { fakeToolScripts, writeFakeToolState, type FakeToolOptions } from "../hub-fixtures.ts";

export const repositoryRoot = join(import.meta.dirname, "..", "..");

const tempDirectories: string[] = [];
const hubs: ChildProcess[] = [];
const servers: Server[] = [];
let savedEnvironment: Record<string, string | undefined> | undefined;

/** Creates a temp directory that `useCleanup` removes after the file's tests. */
export function tempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

/** A fresh ARK_HOME for the calling process. */
export function tempArkHome(): string {
  const home = tempDirectory("ark-home-");
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
  criteria: { id: string; text: string }[],
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
    frontmatter.push(`  - id: ${criterion.id}`, `    text: ${JSON.stringify(criterion.text)}`);
  writeFileSync(file, `${frontmatter.join("\n")}\n---\n## Why\n\nTest ticket.\n`);
  return file;
}

/** Records an evaluation as `ark evaluation record` does, plus a one-card strategy when the run is still planning. */
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

/** Dated `YYYY/MM/DD` folder segments of the frozen clock's UTC day, as Codex lays out its sessions. */
export function codexDay(): [string, string, string] {
  const [year, month, day] = new Date(testNow()).toISOString().slice(0, 10).split("-");
  return [year, month, day];
}

/** The temp git repo `tempGitRepo` makes in test/helpers.ts: one commit on main. */
export function tempGitRepo(): string {
  const directory = tempDirectory("ark-repo-");
  writeFileSync(join(directory, "README.md"), "# test\n");
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.name", "Ark Test"],
    ["config", "user.email", "ark@example.com"],
    ["add", "-A"],
    ["commit", "-q", "-m", "initial"],
  ]) {
    const result = spawnSync("git", args, { cwd: directory });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${String(result.stderr)}`);
  }
  return directory;
}

/** Runs `ark <args>` with the current environment. */
export function ark(...args: string[]): { code: number; out: string; err: string } {
  const result = spawnSync("bun", [join(repositoryRoot, "cli", "ark.ts"), ...args], {
    env: process.env,
    encoding: "utf8",
  });
  return { code: result.status ?? 1, out: result.stdout, err: result.stderr };
}

/** Writes an executable `<name>` with the given shell script and puts it first on PATH. Returns its directory. */
export function writeFakeCommand(name: string, script: string): string {
  const directory = tempDirectory(`ark-${name}-`);
  const file = join(directory, name);
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
  process.env.PATH = `${directory}:${process.env.PATH}`;
  return directory;
}

/** Writes an executable `orca` with the given shell script and puts it first on PATH. Returns its directory. */
export const writeFakeOrca = (script: string): string => writeFakeCommand("orca", script);

/** A fresh scratch folder for the fake `orca`, `gh`, `omp` and `plannotator`; puts the four on PATH. */
export function installFakeTools(options: FakeToolOptions): string {
  const state = tempDirectory("ark-fake-tools-");
  writeFakeToolState(state, options);
  const scripts = fakeToolScripts(state);
  writeFakeCommand("orca", scripts.orca);
  writeFakeCommand("gh", scripts.gh);
  writeFakeCommand("omp", scripts.omp);
  writeFakeCommand("plannotator", scripts.plannotator);
  return state;
}

export type StartedHub = { process: ChildProcess; baseUrl: string };

/** Starts `bun hub/main.ts --port 0` and resolves once it prints its address. `useCleanup` kills it. */
export async function startHub(): Promise<StartedHub> {
  const hub = spawn("bun", [join(repositoryRoot, "hub", "main.ts"), "--port", "0"], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  hubs.push(hub);
  let output = "";
  for await (const chunk of hub.stdout!) {
    output += chunk;
    const port = output.match(/127\.0\.0\.1:(\d+)/)?.[1];
    if (port) return { process: hub, baseUrl: `http://127.0.0.1:${port}` };
  }
  throw new Error(`the hub exited before serving: ${output}`);
}

/** Stops one hub started by `startHub`. */
export async function stopHub(hub: ChildProcess): Promise<void> {
  if (hub.exitCode !== null || hub.signalCode !== null) return;
  hub.kill();
  await once(hub, "exit");
}

/** An HTTP server on a free port, closed by `useCleanup`. */
export async function serve(
  handler: Parameters<typeof createServer>[1] & {},
): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("no server address");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

/**
 * Registers hooks for the calling file: freezes the hub clock (keeps a caller's ARK_NOW), and after
 * the tests stops every hub, closes every server, removes every temp directory and restores the
 * environment, so a scratch TMPDIR is empty afterwards (ARK-243-AC6).
 */
export function useCleanup(): void {
  test.beforeAll(() => {
    savedEnvironment = { ...process.env };
    if ((process.env.ARK_NOW ?? "") === "") process.env.ARK_NOW = "2026-11-04T12:00:00Z";
  });
  test.afterAll(async () => {
    await Promise.all(hubs.splice(0).map(stopHub));
    await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
    for (const directory of tempDirectories.splice(0))
      rmSync(directory, { recursive: true, force: true });
    for (const key of Object.keys(process.env))
      if (!(key in savedEnvironment!)) delete process.env[key];
    Object.assign(process.env, savedEnvironment);
  });
}

/** The frozen hub clock (ARK_NOW) in epoch milliseconds. */
export function testNow(): number {
  return Date.parse(process.env.ARK_NOW as string);
}

/** ISO instant `millisecondsAgo` before the frozen clock. */
export function isoAgo(millisecondsAgo: number): string {
  return new Date(testNow() - millisecondsAgo).toISOString();
}

/**
 * Takes the screenshot of one named step of a UI test: `<ARK_EVIDENCE_DIR>/<key>/screenshots/<name>.png`, where
 * `<key>` is the first test case id in the test's title path, else the sanitized title (that folder is dropped by
 * `ark test`). Call it before the assertion of the step, so a failing assertion still leaves the picture.
 * It writes nothing when `ARK_EVIDENCE_DIR` is not set. `screenshot: "only-on-failure"` in the config is separate.
 */
export async function checkpoint(page: Page, name: string): Promise<void> {
  const evidenceDirectory = process.env.ARK_EVIDENCE_DIR;
  if (!evidenceDirectory) return;
  const { title, titlePath } = test.info();
  const key = titlePath.join(" ").match(casePattern)?.[0] ?? title.replace(/[^\w.-]+/g, "_");
  await page.screenshot({ path: join(evidenceDirectory, key, "screenshots", `${name}.png`) });
}
