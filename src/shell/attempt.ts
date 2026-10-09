/**
 * attempt.ts — the `attempt` effect handler and the SEAL. @layer shell. (The harness adapters are pure and live in
 * core/harness.ts; the handler takes the table the composition root passes it.)
 *
 * THE SEAL is the single boundary for everything that can reject an agent attempt:
 * output present, git control surface untouched, schema valid and admissible (admit), diff paths within
 * allowedPaths, locked checks byte-identical with nothing added under their roots, evidence untouched, head
 * descends from baseHead. decide() never re-checks any of it; it only sees "produced" or "rejected".
 *
 * Two directories per effect, both outside the worktree (layout: proc.ts):
 *   out dir  `<run dir>/out/<key-dir>/`   output.json — the ONLY path the agent is told. Untrusted input to the seal.
 *   ctl dir  `<run dir>/.ctl/<key-dir>/`  proc.ts control files (claim, abandoned, exit, transcript.jsonl), the
 *                                         git fingerprint taken before launch (`gitfp`), `rejected.json`, the emit token.
 *                                         Not told to the agent. Not protected from it either; see proc.ts.
 *
 * THE RULE: no file in either directory is ever believed toward ACCEPTANCE. There is no stored "produced" outcome to
 * adopt. Every adoption re-runs the seal, which is a pure function of (output.json, git objects, the spec's Guard).
 * The one marker that is believed, `rejected.json`, can only push toward rejection (forging it costs the forger a retry).
 *
 * RECOVERY POLICY: probe. `claim` present -> "done", else "absent". All the cases are decided inside run by proc.inspect:
 *   absent -> fresh start
 *   alive  -> ATTACH: tail transcript from line 0 (observation refs dedupe), wait for `exit` or the deadline
 *   exited -> seal()
 *   dead   -> reap (confirm clean, else outcome ambiguous), reset the worktree, outcome {tag:"interrupted"}; decide
 *             retries from baseHead
 *
 * WORKDIR     write attempts run in the ticket worktree (one writer stage at a time: parsePipeline forbids writing
 *             fan-outs). Read-only attempts (guard.allowedPaths empty) run in a PRIVATE detached worktree `<ctl dir>/wt`
 *             at baseHead, so concurrent siblings can never contaminate each other's seal. That worktree is REMOVED once
 *             run() has returned an outcome (or thrown), on every path including crash recovery.
 */
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AbsPath, GitSha } from "../core/ids.ts";
import type { AdmitInputs } from "../core/contracts.ts";
import type { AttemptSpec, EffectRequest, Outcome, Rejection } from "../core/effects.ts";
import type { HarnessAdapter } from "../core/harness.ts";
import { admit, readArtifact } from "./admit.ts";
import type { AdmitContext } from "./admit.ts";
import type { Handler, HandlerContext, Probe } from "./executor.ts";
import { git, gitFingerprint } from "./git.ts";
import { changedPaths, descendsFrom, evidenceDigest, hashLocked, inspectLocks, pathsOutside } from "./guard.ts";
import type { LockViolation } from "./guard.ts";
import { ctlDirOf, exitCode, inspect, launch, outDirOf, reap, runDirOf, tail, wrapperFinished } from "./proc.ts";

const POLL_MS = 50;
const LIVENESS_EVERY = 5; // polls between lock checks; the `exit` file is checked on every poll
const STUCK = "the process tree did not die after SIGKILL: a descendant left the process group, a writer may still exist";

/** Where one attempt lives. `wt` is the tree the harness ran in (and the seal inspects). */
export interface AttemptDirs {
  readonly runDir: AbsPath;
  readonly ctl: AbsPath;
  readonly out: AbsPath;
  readonly wt: AbsPath;
  readonly readOnly: boolean;
}

function dirsOf(runsRoot: AbsPath, req: EffectRequest<AttemptSpec>): AttemptDirs {
  const runDir = runDirOf(runsRoot, req.key);
  const ctl = ctlDirOf(runDir, req.key);
  const readOnly = req.spec.guard.allowedPaths.length === 0;
  return { runDir, ctl, out: outDirOf(runDir, req.key), wt: readOnly ? (join(ctl, "wt") as AbsPath) : req.spec.workdir, readOnly };
}

// ---------------------------------------------------------------- git helpers

async function ok(dir: AbsPath, args: readonly string[]): Promise<string> {
  const r = await git(dir, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** Every attempt starts from, and every failure returns to, baseHead with no untracked residue. */
async function resetTo(wt: AbsPath, base: GitSha): Promise<void> {
  await ok(wt, ["reset", "--hard", "-q", base]);
  await ok(wt, ["clean", "-fdq"]);
}

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

async function ensureWorktree(d: AttemptDirs, spec: AttemptSpec): Promise<void> {
  if (!d.readOnly || (await exists(join(d.wt, ".git")))) return;
  await rm(d.wt, { recursive: true, force: true }); // a half-made directory from a crash
  await ok(spec.workdir, ["worktree", "prune"]);
  await ok(spec.workdir, ["worktree", "add", "-q", "--detach", d.wt, spec.baseHead]);
}

async function removeWorktree(d: AttemptDirs, spec: AttemptSpec): Promise<void> {
  if (!d.readOnly) return;
  await git(spec.workdir, ["worktree", "remove", "--force", d.wt]);
  await rm(d.wt, { recursive: true, force: true });
  await git(spec.workdir, ["worktree", "prune"]);
}

/** Paths the working tree differs in from HEAD, tracked or not, listed WITHOUT staging anything (staging could run filters). */
async function dirtyPaths(wt: AbsPath): Promise<readonly string[]> {
  const tracked = await ok(wt, ["diff", "--no-renames", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "HEAD", "--"]).catch(() => "");
  const untracked = await ok(wt, ["ls-files", "-z", "--others", "--exclude-standard"]);
  return [...tracked.split("\0"), ...untracked.split("\0")].filter((p) => p !== "");
}

const isGitattributes = (p: string): boolean => basename(p) === ".gitattributes";

// ---------------------------------------------------------------- prompt

/**
 * ponytail: the role's own instructions and skills come from the run manifest, which prepare.ts (unit 5) produces; until
 * then the prompt carries only what the spec itself holds: the task, the output path, scope, feedback, input artifacts.
 */
async function promptFor(req: EffectRequest<AttemptSpec>, d: AttemptDirs): Promise<string> {
  const s = req.spec;
  const render = async (title: string, a: AttemptSpec["inputs"][number]): Promise<string> => `## ${title}: ${a.kind}\n${await readArtifact(d.runDir, a)}`;
  return [
    `You are the ${s.role} for ticket ${req.ticket}.`,
    `Produce one "${s.out}" artifact as JSON conforming to schemas/${s.out}.v1.json and write it to ${d.out}/output.json.`,
    s.guard.allowedPaths.length > 0 ? `You may change only files matching: ${s.guard.allowedPaths.join(", ")}.` : "This is a read-only role: change no files.",
    ...(s.feedback === null ? [] : [`Your previous attempt was refused:\n${s.feedback}`]),
    ...(await Promise.all(s.inputs.map((a) => render("input", a)))),
    ...(await Promise.all(s.fanInputs.map((a) => render("fan-out input", a)))),
  ].join("\n\n");
}

// ---------------------------------------------------------------- handler

export function makeAttemptHandler(harnesses: Readonly<Record<string, HarnessAdapter>>): Handler<"attempt"> {
  return {
    recover: probeAttempt,
    run: (req, ctx) => runAttempt(harnesses, req, ctx),
  };
}

export async function probeAttempt(req: EffectRequest<AttemptSpec>, ctx: HandlerContext): Promise<Probe> {
  return (await exists(join(dirsOf(ctx.runsRoot, req).ctl, "claim"))) ? "done" : "absent";
}

export async function runAttempt(harnesses: Readonly<Record<string, HarnessAdapter>>, req: EffectRequest<AttemptSpec>, ctx: HandlerContext): Promise<Outcome> {
  const adapter = harnesses[req.spec.harness];
  if (adapter === undefined) throw new Error(`unknown harness ${req.spec.harness}`);
  const d = dirsOf(ctx.runsRoot, req);
  try {
    await ensureWorktree(d, req.spec);
    const state = await inspect(d.ctl);
    if (state === "dead") return await stop(req, d, "interrupted");
    if (state === "exited") return await seal(req, d, adapter);
    if (state === "absent") await start(adapter, req, d);
    switch (await wait(adapter, req, ctx, d)) {
      case "exit": return await seal(req, d, adapter);
      case "dead": return await stop(req, d, "interrupted");
      case "timeout": return await stop(req, d, "timed_out");
      case "cancel": return await stop(req, d, "cancelled");
    }
  } catch (e) {
    await reap(d.ctl).catch(() => {}); // never leave a tree behind a failed handler
    throw e;
  } finally {
    await removeWorktree(d, req.spec);
  }
}

/** Fresh start: clean tree at baseHead, fingerprint, emit token, then the detached wrapper. */
async function start(adapter: HarnessAdapter, req: EffectRequest<AttemptSpec>, d: AttemptDirs): Promise<void> {
  const s = req.spec;
  await mkdir(d.ctl, { recursive: true });
  await mkdir(d.out, { recursive: true });
  await resetTo(d.wt, s.baseHead);
  await writeFile(join(d.ctl, "gitfp"), await gitFingerprint(d.wt));
  const token = randomBytes(24).toString("hex");
  await writeFile(join(d.ctl, "emit-token"), token, { mode: 0o600 });
  const inv = adapter.invocation({ prompt: await promptFor(req, d), model: s.model, workdir: d.wt });
  await launch({ ctlDir: d.ctl, argv: inv.argv, env: { ...inv.env, ARK_EFFECT_KEY: req.key, ARK_EMIT_TOKEN: token, ARK_OUT: d.out }, cwd: d.wt });
}

/** Tail the transcript into observations until the tree finishes, dies, runs out of time, or is cancelled. */
async function wait(adapter: HarnessAdapter, req: EffectRequest<AttemptSpec>, ctx: HandlerContext, d: AttemptDirs): Promise<"exit" | "dead" | "timeout" | "cancel"> {
  const stopTail = new AbortController();
  const tailing = tail(d.ctl, (line, i) => adapter.parseLine(line).forEach((sig, j) => ctx.observe(req.key, sig, j === 0 ? `${i}` : `${i}.${j}`)), stopTail.signal);
  try {
    const startedAt = (await stat(join(d.ctl, "claim"))).mtimeMs; // the wrapper rewrote it when it took the lock: the durable start marker
    for (let n = 1; ; n++) {
      if (ctx.signal.aborted) return "cancel";
      // `exit` is writable, so it only prompts a process check; confirm the wrapper leader ended before sealing.
      if (n % LIVENESS_EVERY === 0) {
        const state = await inspect(d.ctl); // writes `abandoned` iff dead
        if (state === "exited") return "exit";
        if (state === "dead") return "dead";
        if (await wrapperFinished(d.ctl)) return (await exitCode(d.ctl)) === null ? "dead" : "exit";
      }
      if (req.timeoutMs !== null && Date.now() - startedAt >= req.timeoutMs) return "timeout";
      await sleep(POLL_MS, undefined, { signal: ctx.signal }).catch(() => {});
    }
  } finally {
    stopTail.abort();
    await tailing; // deliver the last lines before the outcome
  }
}

/** Reap the tree, return the worktree to baseHead, report `tag`. A tree that will not die is `ambiguous`, not a guess. */
async function stop(req: EffectRequest<AttemptSpec>, d: AttemptDirs, tag: "interrupted" | "timed_out" | "cancelled"): Promise<Outcome> {
  if ((await reap(d.ctl)) === "stuck") return { tag: "ambiguous", why: STUCK };
  await resetTo(d.wt, req.spec.baseHead);
  return { tag };
}

// ---------------------------------------------------------------- the seal

const REJECTION_CLASSES: Record<Rejection["class"], true> = {
  missing_output: true, schema: true, locked_check_modified: true, locked_root_added: true, path_outside_allowed: true,
  head_rewritten: true, git_tampered: true, evidence_modified: true, declared_file_missing: true,
};

/** `rejected.json` is agent-reachable: take it only if it parses as a Rejection, and use it only toward rejection. */
async function readRejection(ctl: AbsPath): Promise<Rejection | null> {
  try {
    const v = JSON.parse(await readFile(join(ctl, "rejected.json"), "utf8")) as { class?: unknown; details?: unknown };
    if (typeof v.class !== "string" || !Object.hasOwn(REJECTION_CLASSES, v.class) || !Array.isArray(v.details) || !v.details.every((x) => typeof x === "string")) return null;
    return { class: v.class as Rejection["class"], details: v.details as string[] };
  } catch {
    return null;
  }
}

const describe = (v: LockViolation): string => `${v.kind}: ${v.repo}:${v.path}`; // used for both lock rejections

/**
 * Runs once per finished process, and AGAIN on every adoption (it is idempotent: committing a clean tree is a
 * no-op, every other step reads git objects). Order matters (cheapest, most diagnostic first):
 *   0. reap the tree FIRST. Whatever still lives in it (OMP backgrounds jobs, S1) is killed before anything is read,
 *      so nothing can write, commit, or call `ark` after the seal. "stuck" -> ambiguous.
 *      A `rejected.json` marker short-circuits to that rejection (re-resetting the tree: a crash may have hit between).
 *   1. exit != 0                          -> crashed (no artifact considered)
 *   2. out/output.json                    -> else rejected(missing_output)
 *   3. git control surface: gitFingerprint != the pre-launch one, or ANY `.gitattributes` among the dirty paths
 *                                         -> rejected(git_tampered). Then commit the dirty tree as "ark: <role> attempt <n>"
 *   4. baseHead is an ancestor of headAfter  -> else rejected(head_rewritten)
 *   5. diff --no-renames baseHead..headAfter within guard.allowedPaths -> else rejected(path_outside_allowed)
 *   6. guard.locked: changed/missing -> rejected(locked_check_modified); added -> rejected(locked_root_added)
 *   7. guard.evidence: digest recomputed, every listed file verified -> else rejected(evidence_modified)
 *   8. admit(): schema + admissible; unmeasurable pinned root -> declared_file_missing, anything else -> schema
 *   9. produced. NOTHING is written that a later adoption would trust.
 * ANY rejection writes `rejected.json` and resets the worktree to baseHead BEFORE returning, so a retry is a clean start.
 */
export async function seal(req: EffectRequest<AttemptSpec>, d: AttemptDirs, adapter: HarnessAdapter): Promise<Outcome> {
  const s = req.spec;
  if ((await reap(d.ctl)) === "stuck") return { tag: "ambiguous", why: STUCK };
  const transcript = (await readFile(join(d.ctl, "transcript.jsonl"), "utf8").catch(() => "")).split("\n").filter((l) => l !== "");
  const usage = adapter.usage(transcript);

  const rejected = async (reason: Rejection): Promise<Outcome> => {
    const tmp = join(d.ctl, `rejected.json.tmp-${randomBytes(4).toString("hex")}`);
    await writeFile(tmp, JSON.stringify(reason));
    await rename(tmp, join(d.ctl, "rejected.json"));
    await resetTo(d.wt, s.baseHead);
    return { tag: "rejected", reason, usage };
  };

  const marker = await readRejection(d.ctl);
  if (marker !== null) {
    await resetTo(d.wt, s.baseHead);
    return { tag: "rejected", reason: marker, usage };
  }

  const code = await exitCode(d.ctl);
  if (code !== 0) {
    const stderr = (await readFile(join(d.ctl, "stderr.log"), "utf8").catch(() => "")).slice(-500).trim();
    await resetTo(d.wt, s.baseHead);
    return { tag: "crashed", detail: `${code === null ? "no readable exit status" : `harness exited with status ${code}`}${stderr === "" ? "" : `: ${stderr}`}`, usage };
  }

  const raw = await readFile(join(d.out, "output.json"), "utf8").catch(() => null);
  if (raw === null) return rejected({ class: "missing_output", details: ["out/output.json was not written"] });

  if ((await gitFingerprint(d.wt)) !== (await readFile(join(d.ctl, "gitfp"), "utf8"))) {
    return rejected({ class: "git_tampered", details: ["git config, hooks or attributes changed during the attempt"] });
  }
  const attrs = (await dirtyPaths(d.wt)).filter(isGitattributes);
  if (attrs.length > 0) return rejected({ class: "git_tampered", details: attrs.map((p) => `.gitattributes changed: ${p}`) });
  await ok(d.wt, ["add", "-A"]);
  if ((await git(d.wt, ["diff", "--cached", "--quiet"])).code === 1) {
    await ok(d.wt, ["-c", "user.name=ark", "-c", "user.email=ark@localhost", "commit", "-q", "--no-verify", "--no-gpg-sign", "-m", `ark: ${s.role} attempt ${s.n}`]);
  }
  const head = (await ok(d.wt, ["rev-parse", "HEAD"])) as GitSha;

  if (!(await descendsFrom(d.wt, s.baseHead, head))) return rejected({ class: "head_rewritten", details: [`${s.baseHead} is not an ancestor of the resulting head`] });

  const changed = await changedPaths(d.wt, s.baseHead, head);
  const outside = pathsOutside(changed, s.guard.allowedPaths);
  if (outside.length > 0) return rejected({ class: "path_outside_allowed", details: outside.map((p) => `outside allowed paths: ${p}`) });
  const attrsInDiff = changed.filter(isGitattributes);
  if (attrsInDiff.length > 0) return rejected({ class: "git_tampered", details: attrsInDiff.map((p) => `.gitattributes changed: ${p}`) });

  const violations = (await Promise.all(s.guard.locked.map((l) => inspectLocks(d.wt, head, l)))).flat();
  const modified = violations.filter((v) => v.kind !== "added");
  if (modified.length > 0) return rejected({ class: "locked_check_modified", details: modified.map(describe) });
  if (violations.length > 0) return rejected({ class: "locked_root_added", details: violations.map(describe) });

  if (s.guard.evidence !== null) {
    const digest = await evidenceDigest(join(d.runDir, s.guard.evidence.dir) as AbsPath);
    if (digest !== s.guard.evidence.sumsDigest) return rejected({ class: "evidence_modified", details: [`${s.guard.evidence.dir} no longer matches the recorded digest`] });
  }

  const ctx: AdmitContext = {
    head,
    artifacts: Object.fromEntries(s.inputs.map((a) => [a.kind, a])) as AdmitInputs["artifacts"],
    fan: s.fanInputs,
    evidenceExists: (rel) => {
      try {
        const st = statSync(join(d.runDir, rel));
        return st.isFile() && st.size > 0;
      } catch {
        return false;
      }
    },
    // ponytail: only the attempt's primary repo is measured; a root in another repo fails as declared_file_missing until multi-repo worktrees exist (unit 5)
    pin: async (roots) => {
      const other = roots.find((r) => r.repo !== s.repo);
      if (other !== undefined) throw new Error(`${other.repo}:${other.root} is not in the primary repo ${s.repo}`);
      return [await hashLocked(d.wt, s.repo, head, roots.map((r) => r.root))];
    },
  };
  const admitted = await admit(d.runDir, s.out, raw, ctx);
  if (!admitted.ok) {
    const unmeasured = admitted.problems.every((p) => p.startsWith("declared_file_missing"));
    return rejected({ class: unmeasured ? "declared_file_missing" : "schema", details: admitted.problems });
  }
  return { tag: "produced", artifact: admitted.artifact, usage };
}
