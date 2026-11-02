import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Playwright's transform cache lives in os.tmpdir() and is read before the config loads, so the
// config cannot move it. Remove it so a scratch TMPDIR is empty after the suite (ARK-243-AC6).
export default function globalTeardown(): void {
  const cache =
    process.env.PWTEST_CACHE_DIR ??
    join(tmpdir(), `playwright-transform-cache-${process.getuid?.() ?? ""}`);
  rmSync(cache, { recursive: true, force: true });
}
