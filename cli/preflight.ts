import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { projectDir } from "./run";

// FR-13 AC1: cross-vendor review is enforced on every model a role can reach, not on the config text.
// Roles come from the project's .omp/config.yml `modelRoles`; the provider is the selector's prefix before the first "/".
// ponytail: provider prefix stands for vendor; an aggregator (openrouter/...) would need a vendor map.
const ROLES = ["implement", "validate", "review-x", "review-s"] as const;

type Config = { modelRoles?: Record<string, unknown>; retry?: { modelFallback?: unknown; fallbackChains?: Record<string, unknown> } };

// "@alias" -> its role value; "a,b" -> every candidate; ":high" thinking suffix dropped. The first is what OMP picks when it is available.
function resolve(roles: Record<string, unknown>, role: string, seen: string[] = []): string[] {
  if (seen.includes(role)) throw new Error(`modelRoles.${role}: alias cycle ${[...seen, role].join(" -> ")}`);
  const v = roles[role];
  if (typeof v !== "string" || !v.trim()) throw new Error(`modelRoles.${role} is not set in .omp/config.yml`);
  return selectors(roles, v, `modelRoles.${role}`, [...seen, role]);
}

function selectors(roles: Record<string, unknown>, value: string, at: string, seen: string[]): string[] {
  return value.split(",").flatMap((c) => {
    const first = c.trim();
    if (first.startsWith("@")) return resolve(roles, first.slice(1), seen);
    const model = first.replace(/:[a-z]+$/, "");
    if (!model.includes("/")) throw new Error(`${at} '${value}' is not a provider/model selector`);
    return [model];
  });
}

// Every selector a role can reach: its candidates, then, while retry.modelFallback is on, the fallback chains OMP walks on a request failure:
// the role's own chain (chat roles without one inherit `default`), plus the chain keyed by any reachable model (an exact `provider/model` key or a
// `prefix*` wildcard), followed through to a fixpoint because an exhausted chain consults the fallback model's own chain.
function reachable(cfg: Config, role: string): string[] {
  const roles = cfg.modelRoles ?? {};
  const chains = cfg.retry?.fallbackChains ?? {};
  const reach = resolve(roles, role);
  if (cfg.retry?.modelFallback === false) return reach;
  const chain = (key: string) => {
    const list = chains[key];
    if (!Array.isArray(list) || list.some((s) => typeof s !== "string")) throw new Error(`retry.fallbackChains.${key} must be a list of provider/model selectors`);
    return list.flatMap((s: string) => selectors(roles, s, `retry.fallbackChains.${key}`, []));
  };
  const add = (key: string) => {
    for (const s of chain(key)) if (!reach.includes(s)) reach.push(s);
  };
  const own = [role, "default"].find((k) => Object.hasOwn(chains, k));
  if (own) add(own);
  for (const m of reach) { // reach grows while it is walked
    for (const key of Object.keys(chains)) {
      if (key.includes("/") && (key === m || (key.endsWith("*") && m.startsWith(key.slice(0, -1))))) add(key);
    }
  }
  return reach;
}

export function preflight(): string {
  const file = join(projectDir(), ".omp", "config.yml");
  if (!existsSync(file)) throw new Error(`preflight: no ${file}; write modelRoles for ${ROLES.join(", ")}`);
  const cfg = (Bun.YAML.parse(readFileSync(file, "utf8")) ?? {}) as Config;
  const model = Object.fromEntries(ROLES.map((r) => [r, reachable(cfg, r)]));
  const vendor = (selector: string) => selector.split("/")[0];
  const implementers = new Set(model.implement.map(vendor));
  const bad = [
    ...["validate", "review-x"].flatMap((r) => model[r].filter((m) => implementers.has(vendor(m))).map((m) => `${r} (${m}) shares the implementer's provider '${vendor(m)}'`)),
    ...model["review-s"].filter((m) => !implementers.has(vendor(m))).map((m) => `review-s (${m}) is not on the implementer's provider '${[...implementers].join(", ")}'`),
  ];
  if (bad.length) throw new Error(`preflight refused (${file}):\n${bad.map((b) => `  - ${b}`).join("\n")}`);
  return `preflight ok\n${ROLES.map((r) => `  ${r}: ${model[r][0]}${model[r].length > 1 ? ` (also reachable: ${model[r].slice(1).join(", ")})` : ""}\n`).join("")}`;
}
