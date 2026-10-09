/**
 * world.ts — cross-ticket state, folded from the same ledger. @layer core.
 *
 *   World === every authoritative event, in global seq order, reduced by foldWorld
 *
 * Why a second fold: some facts span tickets. A failed teardown of the pilot environment blocks verify for
 * EVERY ticket; two tickets compete for one verification slot; the registry says which environments exist.
 * A per-ticket TicketState cannot know any of that, and a side table would be a second owner. World is the
 * single owner of exactly these three things, derived (never stored) by the engine incrementally:
 *
 *   envs     : env.registered
 *   tainted  : resource.tainted (any ticket stream) minus resource.cleared (world stream)
 *   leases   : effect.requested with a lease, minus the matching effect.settled
 *
 * Pure, total, deterministic, same rules as state.ts#fold. decide() receives `world` as a read-only
 * argument and keeps a private accumulator copy that it advances as it emits (decide.ts header); it can never
 * change the real World except by emitting events that the engine then folds after commit.
 *
 * Lease uniqueness across tickets holds because the engine runs ONE global serial apply queue (engine.ts):
 * decide -> commit -> foldWorld is atomic with respect to every other ticket. It is a property of the engine's
 * queue, not of "no await happens to sit between two lines".
 */
import type { EffectKey, EnvId, Sha256 } from "./ids.ts";
import type { Resource } from "./effects.ts";
import type { Draft, AuthoritativeEvent } from "./events.ts";

export interface World {
  readonly envs: Readonly<Record<EnvId, { readonly path: string; readonly configHash: Sha256 }>>;
  /** resource -> why it is blocked. Present = every new lease on it is refused. */
  readonly tainted: Readonly<Record<Resource, { readonly reason: string; readonly key: EffectKey }>>;
  /**
   * resource -> slot -> holder. THE slot lease table. The inverse (key -> lease) is `leaseOf`, derived by scan:
   * at most a handful of entries in Phase 1, and one map means nothing to keep in sync.
   */
  readonly leases: Readonly<Record<Resource, Readonly<Record<number, EffectKey>>>>;
}

export function emptyWorld(): World {
  return { envs: {}, tainted: {}, leases: {} };
}

/**
 * Invariants:
 *  - a slot has at most one holder; effect.requested with a taken (resource, slot) is a bug (decide never does it)
 *  - effect.settled releases the lease of its key whatever the outcome (cancelled, ambiguous, timed_out too).
 *    An ambiguous verify therefore frees its slot but ALSO carries a taint (see Outcome.taint) when residue is possible
 *  - resource.cleared on a non-tainted resource is ignored
 */
export function foldWorld(world: World, event: Draft<AuthoritativeEvent>): World {
  switch (event.type) {
    case "env.registered":
      return { ...world, envs: { ...world.envs, [event.data.env]: { path: event.data.path, configHash: event.data.configHash } } };
    case "resource.tainted":
      return { ...world, tainted: { ...world.tainted, [event.data.resource]: { reason: event.data.reason, key: event.data.key } } };
    case "resource.cleared": {
      const { [event.data.resource]: _cleared, ...tainted } = world.tainted;
      return { ...world, tainted };
    }
    case "effect.requested": {
      const lease = event.data.request.lease;
      if (!lease) return world;
      return { ...world, leases: { ...world.leases, [lease.resource]: { ...world.leases[lease.resource], [lease.slot]: event.data.request.key } } };
    }
    case "effect.settled": {
      const key = event.data.key;
      const leases: Record<string, Record<number, EffectKey>> = {};
      for (const [resource, slots] of Object.entries(world.leases)) {
        leases[resource] = Object.fromEntries(Object.entries(slots).filter(([, holder]) => holder !== key)) as Record<number, EffectKey>;
      }
      return { ...world, leases: leases as World["leases"] };
    }
    default:
      return world;
  }
}

export type Availability =
  | { readonly ok: true; readonly slot: number }
  | { readonly ok: false; readonly why: "tainted" | "capacity" };

/** Smallest free slot of `resource`, or why not. The ONLY lease-allocation rule; decide() calls it. */
export function acquire(world: World, resource: Resource, capacity: number): Availability {
  if (world.tainted[resource]) return { ok: false, why: "tainted" };
  const held = world.leases[resource] ?? {};
  for (let slot = 0; slot < capacity; slot++) if (!(slot in held)) return { ok: true, slot };
  return { ok: false, why: "capacity" };
}

/**
 * `ark-<env>-s<slot>`. Named by the LEASE SLOT, not by run or verification number: the next holder of a slot
 * always begins with `down -v` of this exact project, so a crashed predecessor of ANY run is cleaned by its
 * successor. Pure; handlers receive the result in VerifySpec.project and never compute names.
 */
export function projectName(env: EnvId, slot: number): string {
  return `ark-${env}-s${slot}`;
}
