import { writeFileSync } from "node:fs";
import { join } from "node:path";

// No other imports: test/tmpdir-preload.ts and the Playwright helpers (Node) load this file.

/** The file scripts/temp-cleaner.sh reads: the decimal pid of the process that owns a temp root, and a newline. */
export const ownerFileName = "ark-owner.pid";

/** Marks `root` as owned by this process, so the cleaner keeps it while the process lives. Returns `root`. */
export function writeOwnerFile(root: string): string {
  writeFileSync(join(root, ownerFileName), `${process.pid}\n`);
  return root;
}
