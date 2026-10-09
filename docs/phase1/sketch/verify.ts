/**
 * verify.ts — the `verify` handler: trusted verification runner. @layer shell.
 *
 * ONE handler, ONE path. The flow stage (`ark.verify`) and defect repro (`ark verify --check <id>`) are
 * the same effect kind with the same lease; repro is `spec.repro != null` (one check, evidence/repro-<n>/,
 * outcome never advances a ticket). There is no ledger-free second entry point.
 *
 * Secrets (private-registry token, credential files) are read here from the service env and are
 * never put in a request, an event, an artifact, or an agent's environment.
 *
 * PROCESS MODEL. The cycle (materialize, up, seed, health, checks, down) runs as ONE worker process tree under the
 * same detached, lock-guarded wrapper as agent attempts (proc.ts): `ark internal verify-worker` with the spec as
 * input. The service launches it, waits for `exit`, then admits the bundle. So a service crash leaves a tree that
 * recovery can find (claim lock) and kill, instead of orphaned `docker compose up --build` children racing the
 * successor's teardown.
 *
 * FOOTPRINT   <run dir>/evidence/<n>/{verification.json, environment.json, checks/…, logs/…, SHA256SUMS}
 *             written first as evidence/<n>.partial/ then renamed whole.
 *             Compose project `ark-<env>-s<slot>` (spec.project): named by LEASE SLOT, not by run.
 *
 * RECOVERY POLICY: "rerun". Safe by construction because step -1 and 0 remove whatever any predecessor of this
 * SLOT (any run, any crash) left behind, and because verification's contract is "fresh environment".
 *
 * RUN
 *  -1. proc.inspect(ctl): alive/dead tree of a predecessor of THIS effect -> proc.reap first; "stuck" (a descendant
 *      escaped the process group) -> outcome ambiguous WITH taint {env:<id>}.
 *   0. `docker compose -p <spec.project> down -v --remove-orphans` (idempotent). If this fails: the environment
 *      may hold residue we cannot see -> outcome produced(env_failure, reason "slot teardown failed") WITH
 *      taint {resource: env:<id>, reason}. Every later verify for the env waits until `resource.cleared`.
 *   1. rm -rf evidence/<n>.partial; if evidence/<n>/ exists and guard.evidenceDigest verifies -> adopt it (admit, return)
 *   2. materialize the FULL revision vector into a clean dir (no worktree metadata): `git archive <sha>` for the
 *      env repo (spec.vector.env) and for every repo in spec.vector.repos (S4 needed seven). Primary at the ticket head.
 *      guard.inspectMaterialized(each spec.locks) != [] — the bytes about to be executed, not git objects ->
 *      outcome env_failure, reason "locked inputs differ", skip env entirely
 *   3. env.up (run-scoped image tag forced, --build, loopback ports), env.seed, env.health   (S3 recipe)
 *   4. each check (all of spec.checks, or only spec.repro.check) with its timeout; capture stdout/stderr/exit/HAR/db
 *      queries; a failing check reruns ONCE from a fresh environment (fail+fail = fail, fail+pass = flaky)
 *   5. env.down ALWAYS (finally), same project. A failed teardown here is the same taint as step 0.
 *   6. redact (auth headers, tokens, cookies, secret patterns) BEFORE anything is written to evidence/
 *   7. write verification.json + environment.json (vector shas, image digests, task hashes, isolation: none,
 *      lock roots, recipe.limitations ∪ every check's limitations) + SHA256SUMS; rename;
 *      admit(verification) with facts.sumsDigest = evidenceDigest(evidence/<n>)
 *
 * Verdict -> artifact outcome: pass | fail | flaky | env_failure (QE interprets `fail`; flaky and env_failure
 * go to needs_human by the pipeline). Anything thrown -> env_failure with the error in the bundle.
 */
import type { AbsPath } from "./ids";
import type { EffectRequest, Outcome, VerifySpec } from "./effects";
import type { Handler, HandlerContext } from "./executor";

export declare const verifyHandler: Handler<"verify">;

export function runVerify(req: EffectRequest<VerifySpec>, ctx: HandlerContext): Promise<Outcome> {
  throw new Error("not implemented");
}

/** The worker process body (steps 1-7). Runs under proc.ts's wrapper; writes the bundle, exits 0/1 by whether a bundle was written. */
export function verifyWorker(spec: VerifySpec, runDir: AbsPath): Promise<void> {
  throw new Error("not implemented");
}

/** Pure text redaction applied to every captured byte stream. */
export function redact(text: string): string {
  throw new Error("not implemented");
}
