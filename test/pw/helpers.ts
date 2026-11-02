// Node-safe helpers for the Playwright specs. No bun:test, no Bun.* globals: Playwright runs under Node.
import { test } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

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

/** Writes an executable `orca` with the given shell script and puts it first on PATH. Returns its directory. */
export function writeFakeOrca(script: string): string {
  const directory = tempDirectory("ark-orca-");
  const file = join(directory, "orca");
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
  process.env.PATH = `${directory}:${process.env.PATH}`;
  return directory;
}

/** Starts `ark ui --port 0` and resolves once it prints its address. `useCleanup` kills it. */
export async function startHub(): Promise<{ process: ChildProcess; baseUrl: string }> {
  const hub = spawn("bun", [join(repositoryRoot, "cli", "ark.ts"), "ui", "--port", "0"], {
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
  throw new Error(`ark ui exited before serving: ${output}`);
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
