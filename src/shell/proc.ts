/**
 * proc.ts — detached, lock-guarded process trees: the ONE launch/liveness/reap mechanism. @layer shell.
 *
 * `attempt` (agent harnesses) and `verify` (the verification worker) are both "start a process tree that must survive
 * the service, and be able to tell afterwards whether anything of it is still alive". They share this module.
 *
 * On-disk layout of one effect (the only place it is spelled out):
 *   <run dir>   = <runsRoot>/<ticket>/<run>
 *   ctl dir     = <run dir>/.ctl/<effectDirName(key)>/   control files; NOT told to the agent, nothing in it is
 *                                                        trusted toward acceptance (attempt.ts re-seals)
 *   out dir     = <run dir>/out/<effectDirName(key)>/    the only path an agent is told
 *
 * Control files:
 *   claim      created O_EXCL by launch() BEFORE the wrapper is spawned. The Node launcher takes an exclusive flock on
 *              it before checking `abandoned`, records its pid (also the process-group id), then passes the descriptor
 *              to the wrapper and its descendants. The kernel releases it when the last process holding it exits.
 *   abandoned  written by a recoverer (inspect/reap) while it holds the lock, before it declares the tree dead; a
 *              wrapper that obtains the lock and finds it exits without launching. This closes the only race: a wrapper
 *              spawned but not yet locked when the service dies cannot start the harness after a successor decided it is dead.
 *   exit       written by the wrapper when the child exits (tmp + mv, so it appears whole).
 *   transcript.jsonl  the child's stdout.   stderr.log  its stderr.
 *
 * States (inspect), decided from the files and ONE non-blocking lock attempt:
 *   absent   no claim: never launched.
 *   alive    lock busy: some process of the tree exists.
 *   exited   lock free and `exit` present: the tree finished; its results can be collected.
 *   dead     lock free, no `exit`: died without reporting (kill -9, reboot) or never started (`abandoned` is written).
 * There is no "unknown": a kernel lock cannot be stale and a pid cannot be reused into it.
 */
import { Buffer } from "node:buffer";
import { execFile, spawn } from "node:child_process";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import type { AbsPath, EffectKey } from "../core/ids.ts";
import { effectDirName, effectKeyParts } from "../core/ids.ts";
import { isHeld, lockThenSpawn, tryLockExclusive } from "./flock.ts";

export type ProcState = "absent" | "alive" | "exited" | "dead";

export interface LaunchSpec {
  readonly ctlDir: AbsPath;
  readonly argv: readonly string[];
  /** Added to this process's environment. */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: AbsPath;
}

export const runDirOf = (runsRoot: AbsPath, key: EffectKey): AbsPath => {
  const { ticket, run } = effectKeyParts(key);
  return join(runsRoot, ticket, run) as AbsPath;
};
export const ctlDirOf = (runDir: AbsPath, key: EffectKey): AbsPath => join(runDir, ".ctl", effectDirName(key)) as AbsPath;
export const outDirOf = (runDir: AbsPath, key: EffectKey): AbsPath => join(runDir, "out", effectDirName(key)) as AbsPath;

const claimOf = (ctlDir: AbsPath): AbsPath => join(ctlDir, "claim") as AbsPath;
const abandonedOf = (ctlDir: AbsPath): AbsPath => join(ctlDir, "abandoned") as AbsPath;
const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

/**
 * Runs inside the wrapper process group: `$1` is the ctl dir, the rest is the harness argv. stdout and stderr go to
 * files, stdin is empty; the exit status lands in `exit` whole (tmp + mv).
 */
const RUN = String.raw`ctl=$1; shift
"$@" >"$ctl/transcript.jsonl" 2>"$ctl/stderr.log" </dev/null
echo $? >"$ctl/exit.tmp" && mv "$ctl/exit.tmp" "$ctl/exit"`;

/** Create `claim` (O_EXCL; throws if it exists), spawn the wrapper detached (own session), return once it holds the lock. */
export async function launch(spec: LaunchSpec): Promise<void> {
  await mkdir(spec.ctlDir, { recursive: true });
  await writeFile(claimOf(spec.ctlDir), "", { flag: "wx" });
  await spawnWrapper(spec);
}

/**
 * The second half of launch(), exported only so a test can interleave a recoverer between "claim exists" and "wrapper
 * holds the lock" (the spawn race). Resolves once the wrapper has locked the claim and recorded its pid; rejects if
 * the wrapper exited without doing so (lost the lock, abandoned marker present).
 */
export async function spawnWrapper(spec: LaunchSpec): Promise<void> {
  const [bin, ...args] = lockThenSpawn(claimOf(spec.ctlDir), abandonedOf(spec.ctlDir), ["/bin/sh", "-c", RUN, "ark-wrap", spec.ctlDir, ...spec.argv]);
  const child = spawn(bin!, args, { cwd: spec.cwd, env: { ...process.env, ...spec.env }, detached: true, stdio: "ignore" });
  child.unref();
  let exited: number | null | undefined;
  child.once("exit", (code) => (exited = code ?? -1));
  child.once("error", () => (exited = -1));
  const claim = claimOf(spec.ctlDir);
  const deadline = Date.now() + 10_000;
  for (;;) {
    if ((await readFile(claim, "utf8")).trim() !== "") return;
    if (exited !== undefined) {
      if ((await readFile(claim, "utf8")).trim() !== "") return; // fast harness: pid was written, then it finished
      throw new Error(exited === 76 ? "wrapper exited: effect was abandoned" : `wrapper exited (${exited}) before taking the claim lock`);
    }
    if (Date.now() > deadline) throw new Error("wrapper did not take the claim lock within 10s");
    await sleep(5);
  }
}

export async function inspect(ctlDir: AbsPath): Promise<ProcState> {
  const claim = claimOf(ctlDir);
  if (!(await exists(claim))) return "absent";
  const lock = await tryLockExclusive(claim);
  if (lock === null) return "alive";
  try {
    if (await exists(join(ctlDir, "exit"))) return "exited";
    await writeFile(abandonedOf(ctlDir), "", { flag: "a" }); // while the lock is ours: a late wrapper finds this and exits
    return "dead";
  } finally {
    await lock.release();
  }
}

/** Pid of the wrapper (== process group) recorded in `claim`; null while the wrapper has not written it yet. */
async function recordedPid(ctlDir: AbsPath): Promise<number | null> {
  const n = Number((await readFile(claimOf(ctlDir), "utf8").catch(() => "")).trim());
  return Number.isInteger(n) && n > 1 ? n : null; // never 0/1: kill(-1) would signal every process we may signal
}

/** The live process group of an effect's tree, or null if nothing holds its claim. Pure read: never writes `abandoned`. */
export async function groupOf(ctlDir: AbsPath): Promise<number | null> {
  const claim = claimOf(ctlDir);
  if (!(await exists(claim)) || !(await isHeld(claim))) return null;
  return recordedPid(ctlDir);
}

const GRACE_MS = 5_000;

/**
 * SIGKILL the whole process group named in `claim`, then confirm the lock was released within a grace period.
 * "clean": nothing of the tree is alive. "stuck": the lock is still held (a descendant called setsid and escaped the
 * group): the caller reports `ambiguous`/taints, because a writer may still exist. When the lock is already free it
 * also writes `abandoned`, so a wrapper that is spawned but not yet locked cannot start afterwards.
 * ponytail: a descendant that closed the inherited lock fd yet stays in the group is neither seen nor killed when the
 * wrapper is already gone; only a lock holder triggers the group kill (a stale pgid could be someone else's).
 */
export async function reap(ctlDir: AbsPath): Promise<"clean" | "stuck"> {
  const claim = claimOf(ctlDir);
  if (!(await exists(claim))) return "clean";
  const free = await tryLockExclusive(claim);
  if (free !== null) {
    try {
      await writeFile(abandonedOf(ctlDir), "", { flag: "a" });
    } finally {
      await free.release();
    }
    return "clean";
  }
  const deadline = Date.now() + GRACE_MS;
  while (Date.now() < deadline) {
    const pid = await recordedPid(ctlDir); // null only in the instant between locking and writing the pid
    if (pid !== null) {
      try {
        process.kill(-pid, "SIGKILL"); // every pass: a dying process may have forked once more
      } catch {
        // ESRCH: the group is already gone
      }
    }
    if (!(await isHeld(claim))) return "clean";
    await sleep(20);
  }
  return "stuck";
}

/** Exit code from `exit`, or null if absent or not a plain integer (the file is agent-reachable; garbage is not a status). */
export async function exitCode(ctlDir: AbsPath): Promise<number | null> {
  const t = (await readFile(join(ctlDir, "exit"), "utf8").catch(() => "")).trim();
  return /^\d{1,3}$/.test(t) ? Number(t) : null;
}

/** True when the recorded wrapper leader is gone (including a zombie); the lock may still be held by descendants. */
export async function wrapperFinished(ctlDir: AbsPath): Promise<boolean> {
  const pid = await recordedPid(ctlDir);
  if (pid === null) return false;
  const { promise, resolve } = Promise.withResolvers<boolean>();
  execFile("ps", ["-o", "pgid=,stat=", "-p", String(pid)], (error, stdout) => {
    if (error !== null || stdout.trim() === "") return resolve(true);
    const [pgid, state] = stdout.trim().split(/\s+/);
    resolve(pgid !== String(pid) || state?.startsWith("Z") === true);
  });
  return promise;
}

/**
 * Tail `transcript.jsonl` from line 0 (observation refs are line indexes, so re-reading is idempotent). Resolves after
 * `signal` aborts, once everything written so far, including an unterminated last line, has been delivered.
 */
export async function tail(ctlDir: AbsPath, onLine: (line: string, index: number) => void, signal: AbortSignal): Promise<void> {
  const file = join(ctlDir, "transcript.jsonl");
  let pos = 0;
  let pending = "";
  let index = 0;
  const drain = async (final: boolean): Promise<void> => {
    const fh = await open(file, "r").catch(() => null);
    if (fh === null) return;
    try {
      const { size } = await fh.stat();
      if (size > pos) {
        const buf = Buffer.alloc(size - pos);
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        pos += bytesRead;
        pending += buf.toString("utf8", 0, bytesRead); // ponytail: a multibyte char split across reads is mangled; JSONL from the harnesses escapes non-ASCII
      }
    } finally {
      await fh.close();
    }
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    if (final && pending !== "") lines.push(pending), (pending = "");
    for (const l of lines) {
      if (l !== "") onLine(l, index);
      index++;
    }
  };
  while (!signal.aborted) {
    await drain(false);
    await sleep(50, undefined, { signal }).catch(() => {});
  }
  await drain(true);
}
