import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import type { AbsPath, EffectKey } from "../core/ids.ts";
import type { EffectKind, EffectRequest, Outcome } from "../core/effects.ts";
import { createExecutor } from "./executor.ts";
import type { Handler, HandlerTable, Probe } from "./executor.ts";
import { attemptReq, keyFor, scriptedExecutor, waitFor, withFixture } from "./attempt-fixture.ts";
import { ctlDirOf, runDirOf } from "./proc.ts";

const exists = (p: string) => access(p).then(() => true, () => false);

/** A table whose attempt handler is the system under test; every other kind is unsupported. */
function tableWith(attempt: Handler<"attempt">): HandlerTable {
  const unsupported = { run: () => Promise.reject(new Error("unsupported")), recover: "rerun" } as const;
  return { "run.prepare": unsupported, verify: unsupported, publish: unsupported, "forge.wait": unsupported, attempt };
}
const ctx = { runsRoot: "/nonexistent" as AbsPath, observe: () => {} };

test("concurrent run() calls for one key share one handler invocation", async () => {
  await withFixture(async (f) => {
    let calls = 0;
    const done: Outcome = { tag: "interrupted" };
    const ex = createExecutor(tableWith({ run: async () => (calls++, await new Promise((r) => setTimeout(r, 50)), done), recover: "rerun" }), ctx);
    const r = attemptReq(f);
    const [a, b] = await Promise.all([ex.run(r, "first"), ex.run(r, "first")]);
    assert.equal(calls, 1);
    assert.deepEqual([a, b], [done, done]);
    await ex.run(r, "first");
    assert.equal(calls, 2, "a finished key is not remembered; adoption is the handler's job");
  });
});

test("a throwing handler becomes crashed; run() never rejects", async () => {
  await withFixture(async (f) => {
    const ex = createExecutor(tableWith({ run: async () => { throw new Error("boom"); }, recover: "rerun" }), ctx);
    assert.deepEqual(await ex.run(attemptReq(f), "first"), { tag: "crashed", detail: "boom", usage: null });
  });
});

test("recovery applies the declared policy: probe unknown => ambiguous without run; done/absent/rerun => run; first mode never probes", async () => {
  await withFixture(async (f) => {
    const r = attemptReq(f);
    const ran: EffectKind[] = [];
    const probed: Probe[] = [];
    const handler = (probe: Probe | "rerun" | "throws"): Handler<"attempt"> => ({
      run: async () => (ran.push("attempt"), { tag: "cancelled" }),
      recover: probe === "rerun" ? "rerun" : async () => { if (probe === "throws") throw new Error("cannot stat"); probed.push(probe); return probe; },
    });
    const ambiguous = await createExecutor(tableWith(handler("unknown")), ctx).run(r, "recovery");
    assert.equal(ambiguous.tag, "ambiguous");
    assert.deepEqual(ran, [], "unknown never reaches run");
    assert.equal((await createExecutor(tableWith(handler("throws")), ctx).run(r, "recovery")).tag, "ambiguous");
    assert.deepEqual(ran, []);
    for (const p of ["done", "absent", "rerun"] as const) await createExecutor(tableWith(handler(p)), ctx).run(r, "recovery");
    assert.equal(ran.length, 3);
    probed.length = 0;
    await createExecutor(tableWith(handler("done")), ctx).run(r, "first");
    assert.deepEqual(probed, [], "first dispatch does not consult the probe");
  });
});

test("cancel aborts the handler's signal, waits for it, and the run resolves cancelled whatever the handler returned", async () => {
  await withFixture(async (f) => {
    let sawAbort = false;
    const ex = createExecutor(tableWith({
      run: async (_r, c) => {
        await new Promise<void>((resolve) => c.signal.addEventListener("abort", () => resolve()));
        sawAbort = true;
        return { tag: "interrupted" };
      },
      recover: "rerun",
    }), ctx);
    const r = attemptReq(f);
    const run = ex.run(r, "first");
    await ex.cancel(r.key);
    assert.ok(sawAbort);
    assert.deepEqual(await run, { tag: "cancelled" });
    await ex.cancel(r.key); // no-op once finished
  });
});

test("emit token: valid only for its key, its token, and a live tree; isAgentProcess sees the harness group only", async () => {
  await withFixture(async (f) => {
    const go = join(f.root, "go");
    const env = { OUT_SRC: f.goodOutput, STARTED: join(f.root, "started1"), WAIT_FOR: go };
    const ex = scriptedExecutor(f.runsRoot, env);
    const r: EffectRequest = attemptReq(f);
    const key = r.key;
    const ctl = ctlDirOf(runDirOf(f.runsRoot, key), key);
    assert.equal(await ex.emitTokenValid(key, "x"), false, "unknown key");
    const run = ex.run(r, "first");
    await waitFor("harness start", () => exists(join(f.root, "started1")));
    const token = (await readFile(join(ctl, "emit-token"), "utf8")).trim();
    assert.equal(await ex.emitTokenValid(key, token), true);
    assert.equal(await ex.emitTokenValid(key, token.replace(/.$/, (c) => (c === "0" ? "1" : "0"))), false, "wrong token");
    assert.equal(await ex.emitTokenValid(key, ""), false);
    assert.equal(await ex.emitTokenValid(keyFor(2) as EffectKey, token), false, "another key");
    assert.equal(await ex.emitTokenValid("../../etc/x/y/1/z/1" as EffectKey, token), false, "a forged key never reaches the filesystem");

    const harnessPid = Number((await readFile(join(f.root, "started1"), "utf8")).trim());
    assert.equal(await ex.isAgentProcess(harnessPid), true);
    assert.equal(await ex.isAgentProcess(process.pid), false);
    assert.equal(await ex.isAgentProcess(2 ** 22 + 12345), false);

    await writeFile(go, "");
    assert.equal((await run).tag, "produced");
    assert.equal(await ex.emitTokenValid(key, token), false, "no longer running");
    assert.equal(await ex.isAgentProcess(harnessPid), false);
  });
});
