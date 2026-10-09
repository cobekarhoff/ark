/**
 * api.ts — the service's client surface (CLI + dashboard). @layer shell.
 *
 * Seven methods. Clients never open the SQLite file, never touch the run dir for state,
 * never write events. The dashboard is a client like the CLI: it reads TicketView and
 * artifacts, and writes only by `submit`.
 *
 * Transport: HTTP/JSON over a unix socket (~/.ark/ark.sock). The SERVICE SINGLETON is the exclusive flock on
 * ~/.ark/ark.lock taken by `serve` before anything else (cli.ts); binding this socket happens last, under that lock
 * (a stale socket file is unlinked safely because we hold the lock). The ledger epoch fence is a backstop.
 *
 * Who may speak. Under decision 44 agents run as the engineer's user and can reach this socket. Two rules:
 *   - HUMAN COMMANDS (`submit`) are refused when the connecting process is inside a live attempt or verify tree:
 *     the transport reads the peer pid (macOS LOCAL_PEERPID; Node needs a small native/helper shim for it, see
 *     RATIONALE risks) and asks `Executor.isAgentProcess(pid)`. A builder cannot approve a gate, raise the repair
 *     cap, or clear a taint.
 *   - `emit` requires the per-attempt token (`ARK_EMIT_TOKEN`) minted by the attempt handler, valid for its own key
 *     only. It can append observations and nothing else.
 * Neither is a sandbox: a determined same-user process can still start a new process tree outside the attempt. The
 * rules close the casual and the accidental path (a backgrounded OMP job running `ark gate decide`), which is the
 * realistic one, and are disclosed as such in the manifest ("unsandboxed").
 */
import type { AbsPath, EnvId, EffectKey, TicketId } from "./ids";
import type { HumanCommand, Receipt } from "./engine";
import type { TicketView } from "./state";
import type { Signal } from "./effects";

export interface ArkApi {
  /** `ark env add <path>` */
  envAdd(path: AbsPath): Promise<{ readonly env: EnvId }>;

  /**
   * `ark ticket new`    -> {type:"ticket.created"}    (carries TicketInput.base: `--base repo=rev ...`)
   * `ark run`           -> {type:"run.requested"}
   * `ark gate decide`   -> {type:"gate.decided"}      (pins = view.gate.pins, echoed verbatim; a different echo is refused)
   * `ark resume`        -> {type:"human.resolved"}
   * `ark verify --check`-> {type:"verify.requested"}  (non-flow verify through the same handler and slot lease;
   *                                                    the result appears in view().repros)
   * `ark env unblock`   -> {type:"resource.cleared"}
   * Dashboard buttons call the same method with the same payloads.
   */
  submit(cmd: HumanCommand): Promise<Receipt>;

  list(): Promise<readonly TicketView[]>;
  view(ticket: TicketId): Promise<TicketView | null>;

  /** Rendered Markdown view of a recorded artifact (derived from canonical JSON by hash; re-hashed on read). */
  artifact(ticket: TicketId, hash: string, as: "json" | "md"): Promise<string>;

  /** Evidence files for the viewer (logs, HAR). Path is relative to the run's evidence dir; traversal refused. */
  evidence(ticket: TicketId, rel: string): Promise<string>;

  /** `ark emit`: an observation from inside a role attempt. Never a transition. Requires the attempt's token. */
  emit(key: EffectKey, token: string, signal: Signal): Promise<void>;
}

/** Called per connection with the peer's pid; true = the peer is inside a live agent/verify tree (Executor.isAgentProcess). */
export type AgentPeerCheck = (pid: number) => Promise<boolean>;

export function serve(api: ArkApi, socket: AbsPath, isAgentPeer: AgentPeerCheck): Promise<{ close(): Promise<void> }> {
  throw new Error("not implemented");
}

export function connect(socket: AbsPath): ArkApi {
  throw new Error("not implemented");
}
