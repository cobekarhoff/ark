import { afterAll, setDefaultTimeout } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ARK-292: one suite-wide default so slow CLI spawns do not hit bun's 5s limit.
setDefaultTimeout(30_000);

// One root per bun test process. os.tmpdir() and child processes use it.
// afterAll, not process "exit": exit hooks do not fire in a bun test preload.
// A killed process (SIGKILL, crash) skips afterAll and leaves its root.
const tempRoot = mkdtempSync(join(realpathSync(tmpdir()), "bun-test-"));
process.env.TMPDIR = tempRoot;

// Removing the root after a full run can outlast bun's 5s default hook timeout.
const cleanupTimeoutMilliseconds = 60_000;

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
}, cleanupTimeoutMilliseconds);
