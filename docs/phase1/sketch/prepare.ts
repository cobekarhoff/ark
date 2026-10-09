/**
 * prepare.ts — environment config loading and the `run.prepare` handler. @layer shell.
 *
 * The ONLY module that reads an agentic environment's `ark/` directory. Everything
 * product-specific ends here: pipeline, roles, risk rules, tasks are parsed into
 * domain types (Pipeline, RoleBinding, VerifyRecipe) and from then on the rest of ark
 * sees only those. Ark holds no product knowledge.
 */
import type { AbsPath, EnvId, GitSha, HarnessId } from "./ids";
import type { Pipeline, RunManifest } from "./pipeline";
import type { Handler } from "./executor";

/** Parsed `ark/environment.yaml` + roles + pipeline. Validated once; never re-read mid-run. */
export interface EnvironmentConfig {
  readonly id: EnvId;
  readonly path: AbsPath;
  /** The commit whose `ark/` was loaded. Becomes manifest.env.configCommit. NOT the tree verify materializes. */
  readonly configCommit: GitSha;
  readonly configHash: string;
  readonly pipeline: Pipeline;
  /** Everything of the manifest that does not depend on the run: roles, verify recipe (tasks, slots, limitations). */
  readonly manifestTemplate: Omit<RunManifest, "env" | "base" | "repos" | "arkVersion">;
}

export type EnvConfigProblem = { readonly where: string; readonly message: string };

/**
 * Used by `ark env add` (Engine.registerEnv, injected as EngineOptions.loadEnvironment) AND by run.prepare, so
 * "registered" and "runnable" mean the same.
 * Checks: schemas; every role's harness is in the production HARNESSES (mints HarnessId); every role's output kind
 * is in CATALOG; `parsePipeline(doc, roles)` (which needs the roles for the write-scope rules); repo paths exist
 * and are clean git checkouts; every environment-mounted repo resolves to a sha.
 */
export function loadEnvironment(path: AbsPath): Promise<EnvironmentConfig | readonly EnvConfigProblem[]> {
  throw new Error("not implemented");
}

/** Validation hook for the harness id minted from role manifests. */
export function asHarnessId(raw: string): HarnessId | null {
  throw new Error("not implemented");
}

/**
 * FOOTPRINT   <run dir>/manifest.json, <env>/.ark/worktrees/<ticket>/<run>/<repo> + branch `ark/<ticket>/<run-short>`
 * RECOVERY POLICY: probe. (No agent of this run exists yet, so manifest.json cannot have been written by one.)
 *   manifest.json present                      -> "done" (run() returns it; config drift after a crash must not
 *                                                 alter a run that already started)
 *   worktree exists at a sha != base sha       -> "unknown"
 *   otherwise                                  -> "absent"
 * RUN         loadEnvironment(path) (problems -> crashed, decide raises prepare_failed; `ark resume` re-requests this effect);
 *             resolve the base revision vector from TicketInput.base (`git rev-parse`, so `<sha>~1` works; absent =>
 *             current HEAD of each mounted repo; env sha defaults to the config commit but is its own field);
 *             `git worktree add` iff the worktree is absent; write ticket.json / ticket.md; write manifest.json atomically;
 *             disclosures include "unsandboxed" (decision 44) and "same-model QE" when builder and QE bindings share a model.
 *             Outcome {prepared, manifest, pipeline, head: primary base sha}.
 */
export declare const prepareHandler: Handler<"run.prepare">;
