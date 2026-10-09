/**
 * usage.ts — the call sites the sketch was derived from. Type-checks against the sketch;
 * bodies are not run. These ARE the spec: RATIONALE.md "Usage" quotes them. Deleted at implementation.
 */
import type { AbsPath, EffectKey, RepoId, TicketId } from "./ids";
import type { AnyRecorded } from "./contracts";
import type { Draft, Inbound } from "./events";
import { decide, effectsOf } from "./decide";
import { replay } from "./state";
import type { TicketState } from "./state";
import type { World } from "./world";
import type { ArkApi } from "./api";
import type { HarnessAdapter } from "./attempt";
import type { Handler } from "./executor";

declare function expect<T>(v: T): { toEqual(x: unknown): void };
declare const world: World;
declare const atTwoRepairs: TicketState; // replay(fixtureEvents): two repairs counted, a review attempt in flight; carries its Pipeline
declare const reviewBlockers: AnyRecorded; // a recorded review artifact with outcome "blockers"
declare const settled: (key: EffectKey, outcome: Extract<Inbound, { type: "effect.settled" }>["data"]["outcome"]) => Draft<Inbound>;

// 1. A transition rule is a pure function call. No mocks, no database, no clock, no processes, no pipeline argument.
export function repairCapEscalates(): void {
  const key = Object.keys(atTwoRepairs.run!.inflight)[0] as EffectKey;
  const d = decide(atTwoRepairs, settled(key, { tag: "produced", artifact: reviewBlockers, usage: null }), world);
  expect(d.events.map((e) => e.type)).toEqual(["artifact.recorded", "repair.counted", "needs_human.raised"]);
  expect(effectsOf(d)).toEqual([]); // third failed round: no fourth Build is requested
}

// 2. A taint is durable before anything else, and blocks other tickets through World.
export function failedTeardownTaints(): void {
  const key = Object.keys(atTwoRepairs.run!.inflight)[0] as EffectKey;
  const d = decide(atTwoRepairs, settled(key, {
    tag: "produced", artifact: reviewBlockers, usage: null,
    taint: { resource: "env:pilot", reason: "docker compose down failed for ark-pilot-s0" },
  }), world);
  expect(d.events[0]!.type).toEqual("resource.tainted");
}

// 3. State is a fold; the dashboard, the CLI and recovery all call the same function.
export function stateAfterCrash(events: Parameters<typeof replay>[1]): TicketState {
  return replay("PROJ-123" as TicketId, events);
}

// 4. Operator flow = ArkApi calls (the CLI is a table over these).
export async function replayPilotTicket(api: ArkApi, envPath: AbsPath): Promise<void> {
  const { env } = await api.envAdd(envPath); //                                          ark env add
  const t = "PROJ-123" as TicketId;
  // ark ticket new --base env=<sha> --base app=<sha>~1 --base lib=<sha> ... (seven repos, S4)
  const base = { env: "e1f2a3b", repos: { app: "c4d5e6f~1", lib: "a7b8c9d" } as Record<string, string> as Record<RepoId, string> };
  await api.submit({ type: "ticket.created", data: { ticket: t, env, input: { title: "Validate referenced artifacts on record registration", intent: "...", acceptanceHints: [], base } } });
  await api.submit({ type: "run.requested", data: { ticket: t } }); //                  ark run
  const v = (await api.view(t))!;
  if (v.gate) {
    // `ark gate decide` echoes view.gate.pins verbatim; it never reassembles them.
    await api.submit({ type: "gate.decided", data: { ticket: t, gate: v.gate.gate, decision: "approve", pins: v.gate.pins, decider: "engineer", comment: "" } });
  }
  // defect repro goes through the service, same handler, same slot lease:
  await api.submit({ type: "verify.requested", data: { ticket: t, check: "acc-missing-artifact-422" } });
  // after a failed teardown the engineer cleans up, then:
  await api.submit({ type: "resource.cleared", data: { resource: "env:pilot", by: "engineer" } });
}

// 5. A new harness is one pure object.
export const ompAdapter: Pick<HarnessAdapter, "parseLine"> = {
  parseLine: (line) => (line.includes('"tool_execution_start"') ? [{ kind: "tool_call", name: "?" }] : []),
};

// 6. A new effect kind cannot omit its recovery policy: this literal fails to compile without `recover`.
export const exampleHandler: Handler<"forge.wait"> = {
  run: async () => ({ tag: "cancelled" }),
  recover: "rerun",
};
