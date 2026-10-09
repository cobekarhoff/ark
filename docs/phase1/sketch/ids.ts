/**
 * ids.ts — branded identifiers. @layer core (pure; no node types).
 *
 * Brands make "a TicketId is not a RunId" a compile error. Constructors that
 * parse untrusted strings live at the boundary that receives them (CLI, API,
 * prepare.ts); inside core we only pass brands around.
 */

declare const tag: unique symbol;
export type Brand<T, B extends string> = T & { readonly [tag]: B };

export type TicketId = Brand<string, "TicketId">; // "PROJ-123" or "L-<ulid>" for local tickets
export type RunId = Brand<string, "RunId">; //       "r_" + id of the run.requested event (minted by the engine before decide)
export type EnvId = Brand<string, "EnvId">; //       agentic environment, e.g. "pilot-agentic-environment"
export type RepoId = Brand<string, "RepoId">;
export type StageId = Brand<string, "StageId">; //   a key of pipeline.stages
export type RoleId = Brand<string, "RoleId">;
export type SlotId = Brand<string, "SlotId">; //     "main" | "fan:0" | "fan:1" | "join" inside one agent stage visit
export type GateId = Brand<string, "GateId">; //     `${stage}#${visit}`
export type HarnessId = Brand<string, "HarnessId">; // minted only by prepare.ts after checking the HARNESSES registry
export type ModelId = Brand<string, "ModelId">;
export type EventId = Brand<string, "EventId">; //  inbound: ULID minted by the engine; decided: `${inbound.id}.${i}`; observation: `${key}:${line}`
export type StreamId = Brand<string, "StreamId">; // "ticket:<id>" | "world" (authoritative) | "obs:<id>" (observations)

export type GitSha = Brand<string, "GitSha">;
export type Sha256 = Brand<string, "Sha256">; //     "sha256:<hex>"
export type IsoTime = Brand<string, "IsoTime">;
export type AbsPath = Brand<string, "AbsPath">;
export type Glob = Brand<string, "Glob">; //         repo-relative path glob

/**
 * EffectKey — the idempotency key of one external action.
 *
 * Invariants:
 *  - Derived ONLY from state (ticket, run, stage, visit, slot, n). Never random,
 *    never wall-clock. decide() is therefore deterministic: same state + same
 *    inbound event => same keys.
 *  - Names the effect's physical footprint: `<run dir>/.ctl/<effectDirName(key)>/` (control files, never shown to the
 *    agent), `<run dir>/out/<effectDirName(key)>/` (the agent's output dir), the compose project, the branch+head for
 *    publish, the MR iid for waits.
 *    A handler can always answer "did this already happen?" by looking at the
 *    footprint for this key. That is what makes recovery = re-dispatch under the handler's recovery policy.
 *  - `n` increments on every retry (new attempt number), so a retry is a NEW
 *    effect with a NEW footprint, never a mutation of the old one.
 */
export type EffectKey = Brand<string, "EffectKey">;

export interface EffectKeyParts {
  readonly ticket: TicketId;
  readonly run: RunId;
  readonly stage: StageId | "prepare" | "repro";
  readonly visit: number;
  readonly slot: SlotId;
  readonly n: number;
}

/** The only constructor of EffectKey. */
export function effectKey(p: EffectKeyParts): EffectKey {
  throw new Error("not implemented");
}

/** Filesystem-safe, reversible directory name for a key. */
export function effectDirName(key: EffectKey): string {
  throw new Error("not implemented");
}
