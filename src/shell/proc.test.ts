import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AbsPath } from "../core/ids.ts";
import { exitCode, groupOf, inspect, launch, reap, spawnWrapper, tail } from "./proc.ts";
import type { LaunchSpec } from "./proc.ts";
import { isAlive, waitFor } from "./attempt-fixture.ts";
import { rejects, withTmp } from "./repo-fixture.ts";

const exists = (p: string) => access(p).then(() => true, () => false);
const spec = (dir: AbsPath, script: string): LaunchSpec => ({ ctlDir: join(dir, "ctl") as AbsPath, argv: ["sh", "-c", script], env: {}, cwd: dir });
const pidIn = async (file: string) => Number((await readFile(file, "utf8")).trim());

test("states: absent -> alive -> (reaped) dead; a finished tree is exited with its status", async () => {
  await withTmp(async (dir) => {
    const s = spec(dir, "sleep 30");
    assert.equal(await inspect(s.ctlDir), "absent");
    await launch(s);
    assert.equal(await inspect(s.ctlDir), "alive");
    assert.notEqual(await groupOf(s.ctlDir), null);
    assert.equal(await reap(s.ctlDir), "clean");
    assert.equal(await inspect(s.ctlDir), "dead", "lock free and no exit: died without reporting");
    assert.equal(await groupOf(s.ctlDir), null);

    const done = { ...spec(dir, "exit 3"), ctlDir: join(dir, "ctl2") as AbsPath };
    await launch(done);
    await waitFor("exit file", async () => (await exitCode(done.ctlDir)) !== null);
    assert.equal(await exitCode(done.ctlDir), 3);
    await waitFor("lock release", async () => (await inspect(done.ctlDir)) === "exited");
  });
});

test("launch refuses a second claim for the same effect", async () => {
  await withTmp(async (dir) => {
    const s = spec(dir, "sleep 30");
    await launch(s);
    await rejects(launch(s), /EEXIST/);
    await reap(s.ctlDir);
  });
});

test("spawn race: a wrapper spawned after the claim was declared dead loses to `abandoned` and never starts the child", async () => {
  await withTmp(async (dir) => {
    const marker = join(dir, "ran");
    const s = spec(dir, `touch ${marker}`);
    // what launch() did before the service died: claim created, wrapper not yet holding the lock
    await mkdir(s.ctlDir, { recursive: true });
    await writeFile(join(s.ctlDir, "claim"), "", { flag: "wx" });
    assert.equal(await inspect(s.ctlDir), "dead");
    assert.ok(await exists(join(s.ctlDir, "abandoned")), "the recoverer must leave the marker");
    await rejects(spawnWrapper(s), /abandoned/); // the late wrapper
    await sleep(200);
    assert.equal(await exists(marker), false, "the child must never have started");
    assert.equal(await exists(join(s.ctlDir, "exit")), false);
    assert.equal(await inspect(s.ctlDir), "dead");
  });
});

test("reap writes the abandoned marker when nothing holds the claim, so a verify successor closes the same race", async () => {
  await withTmp(async (dir) => {
    const s = spec(dir, "true");
    await mkdir(s.ctlDir, { recursive: true });
    await writeFile(join(s.ctlDir, "claim"), "", { flag: "wx" });
    assert.equal(await reap(s.ctlDir), "clean");
    assert.ok(await exists(join(s.ctlDir, "abandoned")));
    await rejects(spawnWrapper(s), /abandoned/);
  });
});

test("reap kills the whole process group, including backgrounded descendants", async () => {
  await withTmp(async (dir) => {
    const pidFile = join(dir, "bg.pid");
    const s = spec(dir, `sleep 30 & echo $! > ${pidFile}; sleep 30`);
    await launch(s);
    await waitFor("background pid", () => exists(pidFile));
    const bg = await pidIn(pidFile);
    assert.ok(isAlive(bg));
    assert.equal(await reap(s.ctlDir), "clean");
    await waitFor("the background child to die", () => !isAlive(bg), 3_000);
  });
});

test("a descendant that outlives the wrapper keeps the tree alive until reaped", async () => {
  await withTmp(async (dir) => {
    const pidFile = join(dir, "bg.pid");
    const s = spec(dir, `sleep 30 & echo $! > ${pidFile}`);
    await launch(s);
    await waitFor("exit file", async () => (await exitCode(s.ctlDir)) === 0);
    await waitFor("background pid", () => exists(pidFile));
    const bg = await pidIn(pidFile);
    assert.equal(await inspect(s.ctlDir), "alive", "the child still holds the inherited lock");
    assert.equal(await reap(s.ctlDir), "clean");
    assert.equal(await inspect(s.ctlDir), "exited");
    await waitFor("the background child to die", () => !isAlive(bg), 3_000);
  });
});

test("tail delivers every line from index 0, is repeatable, and delivers an unterminated last line on abort", async () => {
  await withTmp(async (dir) => {
    const ctl = dir as AbsPath;
    await writeFile(join(ctl, "transcript.jsonl"), "one\n\ntwo\npart");
    const run = async () => {
      const got: [string, number][] = [];
      const stop = new AbortController();
      const t = tail(ctl, (l, i) => got.push([l, i]), stop.signal);
      await sleep(120);
      stop.abort();
      await t;
      return got;
    };
    const expected = [["one", 0], ["two", 2], ["part", 3]];
    assert.deepEqual(await run(), expected);
    assert.deepEqual(await run(), expected, "re-reading from line 0 yields the same indexes");
  });
});
