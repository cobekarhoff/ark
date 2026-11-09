import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { TestResult } from "./parsers/index.ts";
import { projectDirectory } from "./paths.ts";

/**
 * Passed suite results, one folder per key under `test-cache/` of the project: `entry.json` holds the parsed
 * results, the suite output and the flaky files; `scratch/` is a copy of the evidence scratch folder (the
 * screenshots). Only a passed suite is stored, so a failure always runs again. A folder is pruned when its
 * last use is older than `pruneAfterMilliseconds`.
 */
export type CachedSuite = {
  results: TestResult[];
  /** The whole suite output, as written to `<suite>.log`. */
  output: string;
  /** The command log every case of the suite shares: the command, the output and `exit <code>`. */
  log: string;
  /** Test files that failed once and passed on retry. */
  flaky: string[];
};

const pruneAfterMilliseconds = 14 * 24 * 60 * 60 * 1000;

const cacheDirectory = (project: string) => join(projectDirectory(project), "test-cache");

/** The key of a result: a hash of everything the result depends on. */
export function cacheKey(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** The hash of the content of files, so a changed test file changes the key. */
export function hashFiles(files: { path: string; absolute: string }[]): string {
  const hash = createHash("sha256");
  for (const { path, absolute } of [...files].sort((a, b) => a.path.localeCompare(b.path)))
    hash.update(`${path}\0`).update(readFileSync(absolute)).update("\0");
  return hash.digest("hex");
}

export function hasCached(project: string, key: string): boolean {
  return existsSync(join(cacheDirectory(project), key, "entry.json"));
}

/** The stored suite, with its scratch folder copied to `scratch`; null when none is stored or it cannot be read. */
export function loadCached(project: string, key: string, scratch: string): CachedSuite | null {
  const folder = join(cacheDirectory(project), key);
  try {
    const entry = JSON.parse(readFileSync(join(folder, "entry.json"), "utf8")) as CachedSuite;
    if (existsSync(join(folder, "scratch")))
      cpSync(join(folder, "scratch"), scratch, { recursive: true });
    const now = new Date();
    // touch: the prune looks at the last use
    writeFileSync(join(folder, "used"), now.toISOString());
    return entry;
  } catch {
    return null;
  }
}

/** Stores a passed suite. The folder appears whole (a rename), so a reader never sees half an entry. */
export function storeCached(
  project: string,
  key: string,
  entry: CachedSuite,
  scratch: string,
): void {
  const directory = cacheDirectory(project);
  const prepared = join(directory, `${key}.${process.pid}.tmp`);
  rmSync(prepared, { recursive: true, force: true });
  mkdirSync(prepared, { recursive: true });
  writeFileSync(join(prepared, "entry.json"), JSON.stringify(entry));
  writeFileSync(join(prepared, "used"), new Date().toISOString());
  cpSync(scratch, join(prepared, "scratch"), { recursive: true });
  const target = join(directory, key);
  rmSync(target, { recursive: true, force: true });
  renameSync(prepared, target);
  prune(directory);
}

function prune(directory: string): void {
  for (const name of readdirSync(directory)) {
    const folder = join(directory, name);
    const used = existsSync(join(folder, "used")) ? join(folder, "used") : folder;
    if (Date.now() - statSync(used).mtimeMs > pruneAfterMilliseconds)
      rmSync(folder, { recursive: true, force: true });
  }
}
