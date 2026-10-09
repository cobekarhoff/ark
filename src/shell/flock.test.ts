import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import type { AbsPath } from "../core/ids.ts";
import { isHeld, tryLockExclusive } from "./flock.ts";
import { waitFor } from "./attempt-fixture.ts";
import { withTmp } from "./repo-fixture.ts";

const FLOCK = new URL("./flock.ts", import.meta.url).href;

/** A separate process that takes the lock through flock.ts and keeps it until killed. */
async function holderProcess(path: string) {
  const code = `const { tryLockExclusive } = await import(${JSON.stringify(FLOCK)}); const l = await tryLockExclusive(${JSON.stringify(path)}); console.log(l ? "held" : "busy"); setInterval(() => {}, 1000);`;
  const p = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  const first = await new Promise<string>((resolve) => p.stdout.once("data", (c: Uint8Array) => resolve(String(c).trim())));
  const exited = new Promise<void>((resolve) => p.once("exit", () => resolve()));
  return { p, first, exited };
}

test("service singleton: a second lock fails while the holder lives and succeeds after release", async () => {
  await withTmp(async (dir) => {
    const path = join(dir, "ark.lock") as AbsPath;
    const first = await tryLockExclusive(path);
    assert.notEqual(first, null);
    assert.ok((await stat(path)).isFile(), "the lock file is created on demand");
    assert.equal(await tryLockExclusive(path), null, "second exclusive lock must fail");
    assert.equal(await isHeld(path), true);
    await first!.release();
    assert.equal(await isHeld(path), false);
    const again = await tryLockExclusive(path);
    assert.notEqual(again, null);
    await again!.release();
  });
});

test("service singleton across processes: held while the holder lives, free after kill -9", async () => {
  await withTmp(async (dir) => {
    const path = join(dir, "ark.lock") as AbsPath;
    const h = await holderProcess(path);
    try {
      assert.equal(h.first, "held");
      assert.equal(await tryLockExclusive(path), null, "the live holder keeps the lock");
      assert.equal(await isHeld(path), true);
      h.p.kill("SIGKILL");
      await h.exited;
      let got: Awaited<ReturnType<typeof tryLockExclusive>> = null;
      await waitFor("the lock to be released after SIGKILL", async () => (got = await tryLockExclusive(path)) !== null);
      await got!.release();
    } finally {
      h.p.kill("SIGKILL");
    }
  });
});

test("a second process cannot take a lock the first process holds", async () => {
  await withTmp(async (dir) => {
    const path = join(dir, "ark.lock") as AbsPath;
    const mine = await tryLockExclusive(path);
    assert.notEqual(mine, null);
    const h = await holderProcess(path);
    try {
      assert.equal(h.first, "busy");
    } finally {
      h.p.kill("SIGKILL");
      await mine!.release();
    }
  });
});
