/**
 * attempt-fixture.ts — a real temp git repo, a run directory and a scripted harness for the attempt/executor/proc tests.
 * TEST-ONLY (not imported by production code). The harness is the shell script fake-harness.sh run as a real subprocess
 * through a `scripted` entry in a test-only table; the adapter's parseLine/usage are the production ones.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import type { AbsPath, GitSha, Glob, HarnessId, ModelId, RepoId, RoleId, SlotId, TicketId, RunId, StageId } from "../core/ids.ts";
import { effectKey } from "../core/ids.ts";
import type { AttemptSpec, EffectRequest, Signal } from "../core/effects.ts";
import { HARNESSES } from "../core/harness.ts";
import type { HarnessAdapter } from "../core/harness.ts";
import { makeAttemptHandler } from "./attempt.ts";
import { createExecutor } from "./executor.ts";
import type { Executor, HandlerTable } from "./executor.ts";
import { reap } from "./proc.ts";
import { commit, newRepo, put, withTmp } from "./repo-fixture.ts";

export const HARNESS_SCRIPT = join(import.meta.dirname, "fake-harness.sh");

/** The scripted harness: fake-harness.sh in `format`, configured by `env`. */
export const scripted = (format: "claude-code" | "omp", env: Readonly<Record<string, string>>): HarnessAdapter => ({
  id: "scripted" as HarnessId,
  invocation: () => ({ argv: [HARNESS_SCRIPT], env: { FORMAT: format, ...env }, configFingerprint: "scripted" }),
  parseLine: HARNESSES[format]!.parseLine,
  usage: HARNESSES[format]!.usage,
});

export interface Fixture {
  readonly root: AbsPath;
  readonly runsRoot: AbsPath;
  readonly repo: AbsPath;
  readonly base: GitSha;
  /** A valid `ticket` artifact document, to be copied into out/ by the harness (OUT_SRC). */
  readonly goodOutput: string;
}

const ticketDoc = JSON.stringify({
  schema: "ticket.v1", ticket: "T-1", run: "r_1", attempt: 1, produced_by: { role: "intake", manifest_hash: "sha256:m" }, inputs: [],
  body: { title: "t", intent: "i" },
});

/** Run `fn` against a fresh repo (src/a.txt, locked/check.sh) and run dir; every process tree left in it is reaped afterwards. */
export async function withFixture<T>(fn: (f: Fixture) => Promise<T>): Promise<T> {
  return withTmp(async (root) => {
    const repo = await newRepo(root);
    await put(repo, "src/a.txt", "a\n");
    await put(repo, "locked/check.sh", "exit 0\n");
    const base = await commit(repo, {}, "base");
    const runsRoot = join(root, "runs") as AbsPath;
    await put(root, "good.json", ticketDoc);
    try {
      return await fn({ root, runsRoot, repo, base, goodOutput: join(root, "good.json") });
    } finally {
      await reapAll(runsRoot);
    }
  });
}

/** Every ctl dir under runsRoot, so a failed test cannot leave harness trees behind. */
async function reapAll(runsRoot: AbsPath): Promise<void> {
  for (const t of await readdir(runsRoot).catch(() => [])) {
    for (const r of await readdir(join(runsRoot, t)).catch(() => [])) {
      for (const k of await readdir(join(runsRoot, t, r, ".ctl")).catch(() => [])) await reap(join(runsRoot, t, r, ".ctl", k) as AbsPath);
    }
  }
}

export const keyFor = (n = 1) =>
  effectKey({ ticket: "T-1" as TicketId, run: "r_1" as RunId, stage: "intake" as StageId, visit: 1, slot: "main" as SlotId, n });

export function attemptReq(f: Fixture, over: { readonly n?: number; readonly timeoutMs?: number | null } & Partial<AttemptSpec> = {}): EffectRequest<AttemptSpec> {
  const { n = 1, timeoutMs = null, ...spec } = over;
  return {
    key: keyFor(n), ticket: "T-1" as TicketId, lease: null, timeoutMs,
    spec: {
      kind: "attempt", role: "intake" as RoleId, slot: "main" as SlotId, n, harness: "scripted" as HarnessId, model: "m" as ModelId,
      repo: "app" as RepoId, workdir: f.repo, baseHead: f.base, skills: [], inputs: [], fanInputs: [], feedback: null, out: "ticket",
      guard: { allowedPaths: ["src/**" as Glob], locked: [], evidence: null },
      ...spec,
    },
  };
}

/** A read-only role: nothing may change. */
export const readOnly: AttemptSpec["guard"] = { allowedPaths: [], locked: [], evidence: null };

const unsupported = { run: () => Promise.reject(new Error("unsupported in this test")), recover: "rerun" } as const;

export interface Observed {
  readonly key: string;
  readonly signal: Signal;
  readonly ref: string;
}

/** An executor whose only real handler is `attempt`, over the scripted harness configured by `env`. */
export function scriptedExecutor(runsRoot: AbsPath, env: Readonly<Record<string, string>>, observed: Observed[] = [], format: "claude-code" | "omp" = "claude-code"): Executor {
  const table: HandlerTable = {
    "run.prepare": unsupported, verify: unsupported, publish: unsupported, "forge.wait": unsupported,
    attempt: makeAttemptHandler({ scripted: scripted(format, env) }),
  };
  return createExecutor(table, { runsRoot, observe: (key, signal, ref) => observed.push({ key, signal, ref }) });
}

export async function waitFor(what: string, cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
