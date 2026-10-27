import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { projectDir } from "./run";

// FR-13 AC1: cross-vendor review is enforced on every model a role can reach, not on the config text.
// The vendor is the selector's provider prefix (before the first "/"); roles are filled from the effective OMP config.
// ponytail: provider prefix stands for vendor; an aggregator (openrouter/...) would need a vendor map.
const ROLES = ["implement", "validate", "review-x", "review-s"] as const;

type Chains = Record<string, unknown>;
type Config = { modelRoles?: Record<string, unknown>; retry?: { modelFallback?: unknown; fallbackChains?: Chains } };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// Objects merge key by key, anything else (arrays, scalars) is replaced by the higher layer, and a null there counts as unset (omp://settings.md:167-168).
function merge(low: unknown, high: unknown): unknown {
  if (high === null || high === undefined) return low;
  if (!isObject(low) || !isObject(high)) return high;
  return Object.fromEntries([...new Set([...Object.keys(low), ...Object.keys(high)])].map((k) => [k, merge(low[k], high[k])]));
}

// What OMP will actually run with: `omp config list --json` (global + project + overlays, cwd = the project's .omp/). Without the omp binary,
// the documented merge of the two files (omp://settings.md:12-20): <agent dir>/config.yml under the project's .omp/config.yml.
function effective(projectFile: string): Config {
  const r = (() => {
    try { return Bun.spawnSync(["omp", "config", "list", "--json"], { cwd: projectDir() }); } catch { return undefined; } // not installed
  })();
  if (r) {
    if (r.exitCode !== 0) throw new Error(`preflight: 'omp config list --json' failed: ${r.stderr.toString().trim()}`);
    const all = JSON.parse(r.stdout.toString()) as Record<string, { value?: unknown } | undefined>;
    return {
      modelRoles: all.modelRoles?.value as Config["modelRoles"],
      retry: { modelFallback: all["retry.modelFallback"]?.value, fallbackChains: all["retry.fallbackChains"]?.value as Chains | undefined },
    };
  }
  const read = (f: string) => (existsSync(f) ? Bun.YAML.parse(readFileSync(f, "utf8")) : undefined);
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
  return (merge(read(join(agentDir, "config.yml")), read(projectFile)) ?? {}) as Config;
}

// "@alias" -> its role value; "a,b" -> every candidate (OMP picks the first one that is available, so any may run); ":high" thinking suffix dropped.
function resolve(roles: Record<string, unknown>, role: string, seen: string[] = []): string[] {
  if (seen.includes(role)) throw new Error(`modelRoles.${role}: alias cycle ${[...seen, role].join(" -> ")}`);
  const v = roles[role];
  if (typeof v !== "string" || !v.trim()) throw new Error(`modelRoles.${role} is not set in the OMP config`);
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

// Every selector a role can reach: its candidates, then, while retry.modelFallback is on, what OMP's fallback walk can switch to.
// OMP picks the chain that owns the failing model by specificity (omp://settings.md:587): an exact `provider/model-id` key, then a `provider/*` wildcard key,
// then the role's own chain, then `default` (a role with no chain inherits it; an explicit `[]` means no fallbacks, also for an exact key, omp://settings.md:579).
// A `provider/*` entry keeps the failing model's id and swaps the provider, an id-prefixed one (`openrouter/google/*`) re-prefixes it (omp://settings.md:579,589).
// When a chain is exhausted, recovery consults the fallback model's own chain (omp://settings.md:589), so each reached model is walked in turn.
// Only the role's primaries get the role chain / `default`; a fallback model is walked by its exact or wildcard key alone.
function reachable(cfg: Config, role: string): string[] {
  const roles = cfg.modelRoles ?? {};
  const chains = cfg.retry?.fallbackChains ?? {};
  const primaries = resolve(roles, role);
  if (cfg.retry?.modelFallback === false) return primaries; // omp://settings.md:577,591

  const keyFor = (m: string) =>
    Object.hasOwn(chains, m) ? m : Object.keys(chains).filter((k) => k.includes("/") && k.endsWith("*") && m.startsWith(k.slice(0, -1))).sort((a, b) => b.length - a.length)[0];
  const entries = (key: string, failing: string) => {
    const list = chains[key];
    if (!Array.isArray(list) || list.some((s) => typeof s !== "string")) throw new Error(`retry.fallbackChains.${key} must be a list of provider/model selectors`);
    return list.flatMap((s: string) => selectors(roles, s, `retry.fallbackChains.${key}`, [])).map((e) => (e.endsWith("/*") ? e.slice(0, -1) + failing.slice(failing.lastIndexOf("/") + 1) : e));
  };

  const reach = [...primaries];
  const own = [role, "default"].find((k) => Object.hasOwn(chains, k));
  const walked = new Set<string>();
  const walk = (m: string, owner?: string) => {
    if (walked.has(`${m}|${owner}`)) return;
    walked.add(`${m}|${owner}`);
    const key = keyFor(m) ?? owner;
    if (key === undefined) return;
    for (const next of entries(key, m)) {
      if (!reach.includes(next)) reach.push(next);
      walk(next);
    }
  };
  for (const p of primaries) walk(p, own);
  return reach;
}

export function preflight(): string {
  const file = join(projectDir(), ".omp", "config.yml");
  const cfg = effective(file);
  if (!existsSync(file) && !cfg.modelRoles?.implement) throw new Error(`preflight: no ${file}; write modelRoles for ${ROLES.join(", ")}`);
  const model = Object.fromEntries(ROLES.map((r) => [r, reachable(cfg, r)]));
  const vendor = (selector: string) => selector.split("/")[0];
  const implementers = new Set(model.implement.map(vendor));
  const bad = [
    ...["validate", "review-x"].flatMap((r) => model[r].filter((m) => implementers.has(vendor(m))).map((m) => `${r} (${m}) shares the implementer's vendor '${vendor(m)}'`)),
    ...model["review-s"].filter((m) => !implementers.has(vendor(m))).map((m) => `review-s (${m}) is not on the implementer's vendor '${[...implementers].join(", ")}'`),
  ];
  if (bad.length) throw new Error(`preflight refused (${file}):\n${bad.map((b) => `  - ${b}`).join("\n")}`);
  return `preflight ok\n${ROLES.map((r) => `  ${r}: ${model[r][0]}${model[r].length > 1 ? ` (also reachable: ${model[r].slice(1).join(", ")})` : ""}\n`).join("")}`;
}
