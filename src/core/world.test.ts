import test from "node:test";
import assert from "node:assert/strict";
import type { EffectKey, EnvId, EventId, IsoTime, StreamId, TicketId } from "./ids.ts";
import type { Resource } from "./effects.ts";
import type { AuthoritativeEvent, Draft } from "./events.ts";
import { acquire, emptyWorld, foldWorld, projectName } from "./world.ts";
import { A, RESOURCE, T1, ev, keyOf, manifestWith, sha } from "./fixtures.ts";

const k0 = keyOf(T1, "r_1", "verify", 1);
const k1 = keyOf("PROJ-2" as TicketId, "r_2", "verify", 1);
const requested = (key: EffectKey, slot: number) => ev(T1, "effect.requested", {
  request: { key, ticket: T1, lease: { resource: RESOURCE, slot }, timeoutMs: 1, spec: { kind: "forge.wait", for: "gitlab.merged", mr: { iid: 1, branch: "b" }, head: "h" as never, pollMs: 1 } },
});
const worldEvent = (type: "env.registered" | "resource.cleared", data: object): Draft<AuthoritativeEvent> =>
  ({ id: "w" as EventId, v: 1, ts: "2026-01-01T00:00:00Z" as IsoTime, stream: "world" as StreamId, type, data, authority: "authoritative", source: "human" }) as unknown as Draft<AuthoritativeEvent>;

test("acquire hands out the smallest free slot of a non-tainted resource", () => {
  let w = emptyWorld();
  assert.deepEqual(acquire(w, RESOURCE, 2), { ok: true, slot: 0 });
  w = foldWorld(w, requested(k0, 0));
  assert.deepEqual(acquire(w, RESOURCE, 2), { ok: true, slot: 1 });
  w = foldWorld(w, requested(k1, 1));
  assert.deepEqual(acquire(w, RESOURCE, 2), { ok: false, why: "capacity" });
  w = foldWorld(w, ev(T1, "effect.settled", { ticket: T1, key: k0, outcome: { tag: "cancelled" } }));
  assert.deepEqual(acquire(w, RESOURCE, 2), { ok: true, slot: 0 });
});

test("any settle frees the lease; an ambiguous one with a taint also blocks the resource until cleared", () => {
  let w = foldWorld(emptyWorld(), requested(k0, 0));
  w = foldWorld(w, ev(T1, "resource.tainted", { ticket: T1, resource: RESOURCE, key: k0, reason: "residue" }));
  w = foldWorld(w, ev(T1, "effect.settled", { ticket: T1, key: k0, outcome: { tag: "ambiguous", why: "tree will not die", taint: { resource: RESOURCE, reason: "residue" } } }));
  assert.deepEqual(w.leases[RESOURCE], {});
  assert.deepEqual(acquire(w, RESOURCE, 1), { ok: false, why: "tainted" });
  w = foldWorld(w, worldEvent("resource.cleared", { resource: RESOURCE, by: "engineer" }));
  assert.deepEqual(acquire(w, RESOURCE, 1), { ok: true, slot: 0 });
  // clearing a resource that is not tainted changes nothing
  assert.deepEqual(foldWorld(w, worldEvent("resource.cleared", { resource: "env:other" as Resource, by: "x" })), w);
});

test("the env registry and the compose project name", () => {
  const w = foldWorld(emptyWorld(), worldEvent("env.registered", { env: "app-env" as EnvId, path: "/envs/app", configHash: sha("c") }));
  assert.deepEqual(w.envs["app-env" as EnvId], { path: "/envs/app", configHash: sha("c") });
  assert.equal(projectName("app-env" as EnvId, 3), "ark-app-env-s3");
  assert.equal(manifestWith(2).verify.slots, 2);
  void A;
});
