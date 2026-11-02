import { afterAll } from "bun:test";
import { mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One root per bun test process. os.tmpdir() and child processes use it.
// afterAll, not process "exit": exit hooks do not fire in a bun test preload.
// A killed process (SIGKILL, crash) skips afterAll and leaves its root.
const originalTmpdir = realpathSync(tmpdir());
const tempRoot = mkdtempSync(join(originalTmpdir, "bun-test-"));
process.env.TMPDIR = tempRoot;

// The Chrome pid named by a profile's SingletonLock, or undefined once Chrome
// has exited and removed the lock.
function chromePid(profile: string): string | undefined {
  try {
    return readlinkSync(join(profile, "SingletonLock")).split("-").pop();
  } catch {
    return undefined;
  }
}

// Kill Chrome and wait for it to go, or it rewrites its profile after removal.
function stopChrome(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone (ESRCH) or not ours (EPERM): nothing to stop
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    Bun.sleepSync(20);
  }
}

// Bun.WebView (chrome backend) reads TMPDIR natively at startup, so its
// .bun-chrome profile still lands in the original tmpdir. Remove the profiles
// whose Chrome is a child of this process or has exited, which is the usual
// case once the views close. A live Chrome of another suite keeps its profile.
// ponytail: a profile another suite is still launching (no lock yet) can be
// removed too; the window is milliseconds.
function removeOwnChromeProfiles(): void {
  for (const entry of readdirSync(originalTmpdir)) {
    if (!entry.endsWith(".bun-chrome")) continue;
    const profile = join(originalTmpdir, entry);
    const pid = chromePid(profile);
    const parentPid =
      pid && Bun.spawnSync(["ps", "-o", "ppid=", "-p", pid]).stdout.toString().trim();
    if (parentPid === `${process.pid}`) stopChrome(Number(pid));
    if (!parentPid || parentPid === `${process.pid}`)
      rmSync(profile, { recursive: true, force: true });
  }
}

// Removing the Chrome profiles and the root after a full run outlasts bun's 5s default hook timeout.
const cleanupTimeoutMilliseconds = 60_000;

afterAll(() => {
  try {
    removeOwnChromeProfiles();
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}, cleanupTimeoutMilliseconds);
