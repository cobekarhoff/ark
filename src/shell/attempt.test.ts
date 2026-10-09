import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { access, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import type { AbsPath, GitSha, RepoId } from "../core/ids.ts";
import type { AttemptSpec, Outcome } from "../core/effects.ts";
import { hashLocked } from "./guard.ts";
import { readArtifact } from "./admit.ts";
import { ctlDirOf, groupOf, inspect, outDirOf, runDirOf, spawnWrapper } from "./proc.ts";
import { probeAttempt } from "./attempt.ts";
import type { HandlerContext } from "./executor.ts";
import { attemptReq, isAlive, keyFor, readOnly, scriptedExecutor, waitFor, withFixture } from "./attempt-fixture.ts";
import type { Fixture, Observed } from "./attempt-fixture.ts";
import { must } from "./repo-fixture.ts";

const exists = (p: string) => access(p).then(() => true, () => false);
const lines = async (p: string) => (await readFile(p, "utf8").catch(() => "")).split("\n").filter((l) => l !== "");
const pidIn = async (p: string) => Number((await readFile(p, "utf8")).trim());
const CRASH_CHILD = join(import.meta.dirname, "executor.crash-child.ts");

/** Directories the handler uses for request `n` of fixture `f`. */
const dirsFor = (f: Fixture, n = 1) => {
  const key = keyFor(n);
  const runDir = runDirOf(f.runsRoot, key);
  return { key, runDir, ctl: ctlDirOf(runDir, key), out: outDirOf(runDir, key) };
};

/** Env for the scripted harness: a valid output, and handshake files under `<root>/h<n>` so tests can see it start. */
const knobs = (f: Fixture, extra: Record<string, string> = {}, n = 1) => ({
  OUT_SRC: f.goodOutput,
  LAUNCHES: join(f.root, `launches${n}`),
  STARTED: join(f.root, `started${n}`),
  ...extra,
});

/** Worktree back at base: clean, same head, no residue. */
async function assertPristine(f: Fixture, dir: AbsPath = f.repo) {
  assert.equal(await must(dir, ["status", "--porcelain"]), "");
  assert.equal(await must(dir, ["rev-parse", "HEAD"]), f.base);
  assert.equal(await readFile(join(dir, "src/a.txt"), "utf8"), "a\n");
}

const produced = (o: Outcome) => {
  assert.equal(o.tag, "produced", JSON.stringify(o));
  return o as Extract<Outcome, { tag: "produced" }>;
};

// ---------------------------------------------------------------- happy path

for (const format of ["claude-code", "omp"] as const) {
  test(`${format}: the scripted harness produces, the seal admits; control files stay in .ctl, agent output in out/`, async () => {
    await withFixture(async (f) => {
      const observed: Observed[] = [];
      const ex = scriptedExecutor(f.runsRoot, knobs(f, { PRE: "echo changed > src/a.txt" }), observed, format);
      const req = attemptReq(f);
      const out = produced(await ex.run(req, "first"));
      const d = dirsFor(f);

      assert.equal(out.artifact.kind, "ticket");
      assert.deepEqual(out.usage, { inputTokens: 3, outputTokens: 7, costUsd: 0.25, basis: "reported" });
      assert.equal(out.artifact.head, await must(f.repo, ["rev-parse", "HEAD"]));
      assert.notEqual(out.artifact.head, f.base, "the dirty tree was committed so headAfter names the work");
      assert.equal(await must(f.repo, ["log", "-1", "--format=%s"]), "ark: intake attempt 1");
      assert.equal(await must(f.repo, ["diff", "--name-only", f.base, "HEAD"]), "src/a.txt");
      await readArtifact(d.runDir, out.artifact); // stored content-addressed; throws if it does not re-hash

      assert.deepEqual((await readdir(d.out)).sort(), ["output.json"], "the agent's directory holds only its output");
      const ctl = await readdir(d.ctl);
      for (const name of ["claim", "exit", "transcript.jsonl", "gitfp", "emit-token"]) assert.ok(ctl.includes(name), `ctl/${name}`);
      assert.equal(ctl.includes("output.json"), false);
      assert.equal(await exists(join(d.ctl, "rejected.json")), false);

      const kinds = observed.map((o) => o.signal.kind);
      assert.ok(kinds.includes("tool_call") && kinds.includes("usage"), `observed ${kinds}`);
      assert.ok(observed.some((o) => o.signal.kind === "lifecycle" && o.signal.phase === "started"));
      assert.ok(observed.some((o) => o.signal.kind === "lifecycle" && o.signal.phase === "done"));
      assert.equal(new Set(observed.map((o) => o.ref)).size, observed.length, "refs are unique per signal");

      // adoption is a re-seal, not a second launch, and yields the same artifact
      const again = produced(await scriptedExecutor(f.runsRoot, knobs(f), [], format).run(req, "recovery"));
      assert.equal(again.artifact.hash, out.artifact.hash);
      assert.equal(again.artifact.head, out.artifact.head);
      assert.equal((await lines(join(f.root, "launches1"))).length, 1);
    });
  });
}

test("probeAttempt: absent before launch, done once a claim exists", async () => {
  await withFixture(async (f) => {
    const req = attemptReq(f);
    const ctx = { runsRoot: f.runsRoot } as HandlerContext;
    assert.equal(await probeAttempt(req, ctx), "absent");
    await scriptedExecutor(f.runsRoot, knobs(f)).run(req, "first");
    assert.equal(await probeAttempt(req, ctx), "done");
  });
});

// ---------------------------------------------------------------- the seal's refusals (and reset)

type Case = { readonly name: string; readonly pre: string; readonly cls: string; readonly noOutput?: boolean; readonly badOutput?: boolean; readonly spec?: (f: Fixture) => Promise<Partial<AttemptSpec>> };
const lockedSet = async (f: Fixture) => ({
  guard: { allowedPaths: ["**" as never], locked: [await hashLocked(f.repo, "app" as RepoId, f.base, ["locked"])], evidence: null },
});
const CASES: readonly Case[] = [
  { name: "missing output", pre: ":", cls: "missing_output", noOutput: true },
  { name: "schema reject", pre: ":", cls: "schema", badOutput: true },
  { name: "path outside allowed", pre: "echo x > other.txt", cls: "path_outside_allowed" },
  { name: "edited locked check", pre: "echo 'exit 1' > locked/check.sh", cls: "locked_check_modified", spec: lockedSet },
  { name: "deleted locked check", pre: "rm locked/check.sh", cls: "locked_check_modified", spec: lockedSet },
  { name: "file added under a locked root", pre: "echo x > locked/new.sh", cls: "locked_root_added", spec: lockedSet },
  { name: "hook added in .git/config", pre: "printf '[core]\\n\\thooksPath = /tmp\\n' >> .git/config", cls: "git_tampered" },
  { name: ".gitattributes added", pre: "echo '* filter=x' > src/.gitattributes", cls: "git_tampered" },
  { name: "history rewritten", pre: "git checkout -q --orphan alt && git -c user.name=a -c user.email=a@a commit -q -m other", cls: "head_rewritten" },
  { name: "evidence digest differs", pre: ":", cls: "evidence_modified", spec: async () => ({ guard: { allowedPaths: ["src/**" as never], locked: [], evidence: { dir: "evidence/1", sumsDigest: `sha256:${"0".repeat(64)}` as never } } }) },
];

test("the seal rejects each tamper class, resets the worktree, and a re-seal returns the same rejection", async () => {
  await Promise.all(CASES.map((c) => withFixture(async (f) => {
    const env = knobs(f, { PRE: c.pre });
    if (c.noOutput) delete (env as Record<string, string>).OUT_SRC;
    if (c.badOutput) {
      await writeFile(join(f.root, "bad.json"), JSON.stringify({ nope: 1 }));
      (env as Record<string, string>).OUT_SRC = join(f.root, "bad.json");
    }
    const d = dirsFor(f);
    if (c.cls === "evidence_modified") await mkdir(join(d.runDir, "evidence/1"), { recursive: true });
    const req = attemptReq(f, c.spec ? await c.spec(f) : {});
    const out = await scriptedExecutor(f.runsRoot, env).run(req, "first");
    assert.equal(out.tag, "rejected", `${c.name}: ${JSON.stringify(out)}`);
    assert.equal((out as Extract<Outcome, { tag: "rejected" }>).reason.class, c.cls, c.name);
    assert.deepEqual((out as Extract<Outcome, { tag: "rejected" }>).usage, { inputTokens: 3, outputTokens: 7, costUsd: 0.25, basis: "reported" });
    assert.ok(await exists(join(d.ctl, "rejected.json")), c.name);
    assert.equal(await must(f.repo, ["rev-parse", "HEAD"]), f.base, `${c.name}: head reset`);
    assert.equal(await must(f.repo, ["status", "--porcelain"]), "", `${c.name}: no residue`);
    assert.equal(await exists(join(f.repo, "other.txt")), false);
    assert.equal(await readFile(join(f.repo, "locked/check.sh"), "utf8"), "exit 0\n");

    const again = await scriptedExecutor(f.runsRoot, knobs(f), []).run(req, "recovery");
    assert.deepEqual(again, out, `${c.name}: re-seal`);
    assert.equal((await lines(join(f.root, "launches1"))).length, 1, `${c.name}: no relaunch`);
  })));
});

test("a nonzero exit is crashed (usage kept) and the worktree is reset", async () => {
  await withFixture(async (f) => {
    const out = await scriptedExecutor(f.runsRoot, knobs(f, { PRE: "echo x > src/a.txt", EXIT: "3" })).run(attemptReq(f), "first");
    assert.equal(out.tag, "crashed");
    assert.match((out as Extract<Outcome, { tag: "crashed" }>).detail, /status 3/);
    await assertPristine(f);
  });
});

// ---------------------------------------------------------------- forged control files

test("forged outcome/exit files in .ctl change nothing: the seal re-derives from output and git", async () => {
  await withFixture(async (f) => {
    const d = dirsFor(f);
    const forge = `echo '{"tag":"produced"}' > ${d.ctl}/outcome; echo 0 > ${d.ctl}/exit`;
    const ex = scriptedExecutor(f.runsRoot, knobs(f, { PRE: forge, WAIT_FOR: join(f.root, "never") }));
    // 1. no output at all, forged success: still refused
    const noOutput = await ex.run(attemptReq(f, { timeoutMs: 500 }), "first");
    assert.equal(noOutput.tag, "timed_out", JSON.stringify(noOutput));
    assert.equal(await groupOf(d.ctl), null, "a forged exit did not stop the live harness; timeout reaped it");
    await assertPristine(f);
  });
  await withFixture(async (f) => {
    // 2. valid-looking output but an out-of-scope edit, forged success on top
    const d = dirsFor(f);
    const forge = `echo '{"tag":"produced"}' > ${d.ctl}/outcome; echo 0 > ${d.ctl}/exit; echo x > other.txt`;
    const out = await scriptedExecutor(f.runsRoot, knobs(f, { PRE: forge })).run(attemptReq(f), "first");
    assert.equal(out.tag, "rejected", JSON.stringify(out));
    assert.equal((out as Extract<Outcome, { tag: "rejected" }>).reason.class, "path_outside_allowed");
    // and adoption of the finished attempt is a re-seal that still refuses
    const again = await scriptedExecutor(f.runsRoot, knobs(f)).run(attemptReq(f), "recovery");
    assert.equal(again.tag, "rejected");
  });
  await withFixture(async (f) => {
    // 3. a garbage exit file is not a status
    const d = dirsFor(f);
    const out = await scriptedExecutor(f.runsRoot, knobs(f, { PRE: `echo zzz > ${d.ctl}/exit; sleep 0.3` })).run(attemptReq(f), "first");
    assert.equal(out.tag, "produced", JSON.stringify(out));
  });
});

// ---------------------------------------------------------------- reaping

test("a backgrounded child of the harness is killed before the seal", async () => {
  await withFixture(async (f) => {
    const bgPid = join(f.root, "bg.pid");
    const out = await scriptedExecutor(f.runsRoot, knobs(f, { PRE: `sleep 30 & echo $! > ${bgPid}` })).run(attemptReq(f), "first");
    produced(out);
    const bg = await pidIn(bgPid);
    await waitFor("the backgrounded child to die", () => !isAlive(bg), 3_000);
    assert.equal(await groupOf(dirsFor(f).ctl), null);
  });
});

// ---------------------------------------------------------------- deadline and cancel

for (const how of ["deadline", "cancel"] as const) {
  test(`${how}: no process group survives and the worktree is reset`, async () => {
    await withFixture(async (f) => {
      const bgPid = join(f.root, "bg.pid");
      const env = knobs(f, { PRE: `echo x > src/a.txt; sleep 30 & echo $! > ${bgPid}`, WAIT_FOR: join(f.root, "never") });
      const ex = scriptedExecutor(f.runsRoot, env);
      const req = attemptReq(f, { timeoutMs: how === "deadline" ? 600 : null });
      const run = ex.run(req, "first");
      if (how === "cancel") {
        await waitFor("harness start", () => exists(join(f.root, "started1")));
        await waitFor("background child", () => exists(bgPid));
        await ex.cancel(req.key);
      }
      const out = await run;
      assert.deepEqual(out, { tag: how === "deadline" ? "timed_out" : "cancelled" });
      assert.equal(await groupOf(dirsFor(f).ctl), null);
      await waitFor("the harness tree to die", async () => !isAlive(await pidIn(bgPid)) && !isAlive(await pidIn(join(f.root, "started1"))), 3_000);
      await assertPristine(f);
    });
  });
}

// ---------------------------------------------------------------- read-only worktrees

test("read-only attempts run in a private worktree that is removed after the outcome, siblings cannot contaminate each other", async () => {
  await withFixture(async (f) => {
    const ex = (extra: Record<string, string>, n: number) => scriptedExecutor(f.runsRoot, knobs(f, extra, n));
    const a = attemptReq(f, { n: 1, guard: readOnly });
    const b = attemptReq(f, { n: 2, guard: readOnly });
    const [outA, outB] = await Promise.all([
      ex({ PRE: "echo dirty > touched.txt", WAIT_FOR: join(f.root, "go") }, 1).run(a, "first"),
      ex({ WAIT_FOR: join(f.root, "go") }, 2).run(b, "first"),
      waitFor("both harnesses", async () => (await exists(join(f.root, "started1"))) && (await exists(join(f.root, "started2")))).then(() => writeFile(join(f.root, "go"), "")),
    ]);
    assert.equal(outA.tag, "rejected");
    assert.equal((outA as Extract<Outcome, { tag: "rejected" }>).reason.class, "path_outside_allowed");
    produced(outB);

    for (const n of [1, 2]) {
      const wt = join(dirsFor(f, n).ctl, "wt");
      assert.equal(await readFile(join(f.root, `started${n}.pwd`), "utf8").then((s) => s.trim()), wt, "the harness ran in the private worktree");
      assert.equal(await exists(wt), false, `worktree ${n} removed`);
    }
    assert.equal((await must(f.repo, ["worktree", "list", "--porcelain"])).split("\n").filter((l) => l.startsWith("worktree ")).length, 1, "only the ticket worktree remains registered");
    await assertPristine(f); // the ticket worktree was never touched
  });
});

// ---------------------------------------------------------------- ark dies, harness lives / dies

async function launchArk(f: Fixture, env: Record<string, string>, req = attemptReq(f)): Promise<ChildProcess> {
  await writeFile(join(f.root, "child.json"), JSON.stringify({ runsRoot: f.runsRoot, env, req }));
  const child = spawn(process.execPath, [CRASH_CHILD, join(f.root, "child.json")], { stdio: ["ignore", "pipe", "inherit"] });
  await waitFor("the scripted harness to be ready", () => exists(join(f.root, "ready")));
  return child;
}

test("kill the ark process while the harness runs: a new executor attaches (lock held => alive) and completes", async () => {
  await withFixture(async (f) => {
    const go = join(f.root, "go");
    const env = knobs(f, { PRE: `echo changed > src/a.txt; touch ${join(f.root, "ready")}`, WAIT_FOR: go });
    const ark = await launchArk(f, env);
    const harnessPid = await pidIn(join(f.root, "started1"));
    ark.kill("SIGKILL");
    await new Promise((r) => ark.once("exit", r));

    assert.ok(isAlive(harnessPid), "the harness outlives the service");
    const d = dirsFor(f);
    assert.equal(await inspect(d.ctl), "alive");

    const observed: Observed[] = [];
    const second = scriptedExecutor(f.runsRoot, env, observed);
    const run = second.run(attemptReq(f), "recovery");
    await waitFor("the new executor to replay the transcript", () => observed.length > 0);
    assert.equal(observed[0]!.ref, "0", "the tail restarted from line 0 (observation refs dedupe)");
    await writeFile(go, "");
    const out = produced(await run);
    assert.equal((await lines(join(f.root, "launches1"))).length, 1, "attached, never relaunched: one writer");
    assert.equal(await must(f.repo, ["show", `${out.artifact.head as GitSha}:src/a.txt`]), "changed");
    assert.equal(await groupOf(d.ctl), null);
  });
});

test("kill the harness group while ark is down: recovery observes interrupted and the worktree is reset", async () => {
  await withFixture(async (f) => {
    const env = knobs(f, { PRE: `echo changed > src/a.txt; touch ${join(f.root, "ready")}`, WAIT_FOR: join(f.root, "never") });
    const ark = await launchArk(f, env);
    const d = dirsFor(f);
    const pgid = (await groupOf(d.ctl))!;
    ark.kill("SIGKILL");
    await new Promise((r) => ark.once("exit", r));
    process.kill(-pgid, "SIGKILL");
    await waitFor("the lock to be released", async () => (await groupOf(d.ctl)) === null);
    assert.equal(await readFile(join(f.repo, "src/a.txt"), "utf8"), "changed\n", "partial work is on disk before recovery");

    const ex = scriptedExecutor(f.runsRoot, env);
    assert.deepEqual(await ex.run(attemptReq(f), "recovery"), { tag: "interrupted" });
    await assertPristine(f);
    assert.ok(await exists(join(d.ctl, "abandoned")));
    assert.deepEqual(await ex.run(attemptReq(f), "recovery"), { tag: "interrupted" }, "idempotent");
    assert.equal((await lines(join(f.root, "launches1"))).length, 1);
  });
});

test("spawn race through the handler: a claim with no wrapper is interrupted, and the late wrapper never starts the harness", async () => {
  await withFixture(async (f) => {
    const d = dirsFor(f);
    const env = knobs(f);
    await mkdir(d.ctl, { recursive: true });
    await writeFile(join(d.ctl, "claim"), "", { flag: "wx" }); // launch() died right here
    const ex = scriptedExecutor(f.runsRoot, env);
    assert.deepEqual(await ex.run(attemptReq(f), "recovery"), { tag: "interrupted" });
    await assert.rejects(spawnWrapper({ ctlDir: d.ctl, argv: ["/bin/sh", "-c", `touch ${join(f.root, "late")}`], env: {}, cwd: f.repo }), /abandoned/);
    assert.equal(await exists(join(f.root, "late")), false);
    assert.equal(await exists(join(f.root, "launches1")), false);
  });
});
