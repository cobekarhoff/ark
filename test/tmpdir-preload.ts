import { afterAll, setDefaultTimeout } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeOwnerFile } from "../cli/owner-file.ts";

// ARK-292: default for the first file only; bun resets it per file, so each test file also calls setDefaultTimeout(30_000).
setDefaultTimeout(30_000);

// One root per bun test process. os.tmpdir() and child processes use it.
// afterAll, not process "exit": exit hooks do not fire in a bun test preload.
// A killed process (SIGKILL, crash) skips afterAll and leaves its root.
const tempRoot = writeOwnerFile(mkdtempSync(join(realpathSync(tmpdir()), "bun-test-")));
process.env.TMPDIR = tempRoot;

// ARK-390: a real orca, gh, glab, omp, plannotator, launchctl or portless must never run in a test.
// The shims come first on PATH; a test's own fake (writeFakeCommand) goes in front of them and wins.
const shimDirectory = join(tempRoot, "refusing-shims");
mkdirSync(shimDirectory);
for (const tool of ["orca", "gh", "glab", "omp", "plannotator", "launchctl", "portless"]) {
  const file = join(shimDirectory, tool);
  writeFileSync(
    file,
    `#!/bin/sh\necho "bun test refuses the real ${tool}: install a fake first" >&2\nexit 127\n`,
  );
  chmodSync(file, 0o755);
}
process.env.PATH = `${shimDirectory}:${process.env.PATH}`;

// Removing the root after a full run can outlast bun's 5s default hook timeout.
const cleanupTimeoutMilliseconds = 60_000;

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
}, cleanupTimeoutMilliseconds);

// Bun resolves a bare command of a spawn with no `env` against the PATH of process start, so the shims and a test's own
// fake would be skipped. Default `env` to the live process.env.
for (const name of ["spawn", "spawnSync"] as const) {
  const original = Bun[name] as (...args: unknown[]) => unknown;
  (Bun as Record<string, unknown>)[name] = (first: unknown, second?: Record<string, unknown>) => {
    if (Array.isArray(first)) return original(first, { env: process.env, ...second });
    return original({ env: process.env, ...(first as Record<string, unknown>) });
  };
}
