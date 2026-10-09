/**
 * repo-fixture.ts — real temp git repos for the shell tests. TEST-ONLY (not imported by production code).
 * Every git call goes through git.ts, so the fixtures exercise the same hardened wrapper the service uses.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AbsPath, GitSha } from "../core/ids.ts";
import { git } from "./git.ts";

/** Run `fn` with a fresh temp directory (symlinks resolved), removed afterwards. */
export async function withTmp<T>(fn: (dir: AbsPath) => Promise<T>): Promise<T> {
  const dir = (await realpath(await mkdtemp(join(tmpdir(), "ark-unit3-")))) as AbsPath;
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** git that must succeed; returns trimmed stdout. */
export async function must(dir: AbsPath, args: readonly string[]): Promise<string> {
  const r = await git(dir, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

export async function put(dir: string, rel: string, content: string, mode?: number): Promise<void> {
  await mkdir(dirname(join(dir, rel)), { recursive: true });
  await writeFile(join(dir, rel), content, mode === undefined ? undefined : { mode });
}

export async function initRepo(dir: AbsPath): Promise<void> {
  await must(dir, ["init", "-q", "-b", "main"]);
}

/** Write `files` (a null value deletes the path), stage everything, commit; returns the new head. */
export async function commit(dir: AbsPath, files: Readonly<Record<string, string | null>>, msg = "c"): Promise<GitSha> {
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) await rm(join(dir, rel), { force: true });
    else await put(dir, rel, content);
  }
  await must(dir, ["add", "-A"]);
  await must(dir, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", msg]);
  return (await must(dir, ["rev-parse", "HEAD"])) as GitSha;
}

/** Assert that `p` rejects with a message matching `re`. */
export async function rejects(p: Promise<unknown>, re: RegExp): Promise<void> {
  let err: unknown = null;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  if (!(err instanceof Error) || !re.test(err.message)) throw new Error(`expected rejection matching ${re}, got ${err}`);
}

/** A fresh empty repo at `<root>/repo` (so siblings of the repo in `root` are outside it). */
export async function newRepo(root: AbsPath): Promise<AbsPath> {
  const dir = join(root, "repo") as AbsPath;
  await mkdir(dir);
  await initRepo(dir);
  return dir;
}
