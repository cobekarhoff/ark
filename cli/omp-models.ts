#!/usr/bin/env bun
// The one place Ark touches OMP's own code (NFR-03: the CLI core imports nothing from OMP). `cli/preflight.ts` runs this file as a subprocess:
//   bun cli/omp-models.ts <omp package dir>      (cwd = the project directory)
// and reads one JSON object from stdout: { [role]: null | { selector, via }[] }, the models each role can reach.
// Resolution and the fallback walk are OMP's own functions (src/config/model-resolver.ts, src/session/retry-fallback-chains.ts), run against the
// effective settings (global + project) and the bundled catalog, so Ark never re-implements OMP's selector matching or chain ownership.
// Any failure to load OMP exits non-zero with the reason on stderr; the caller refuses.
import { join } from "node:path";

export type Reach = { selector: string; via: { kind: "role" | "chain" | "parent"; key: string } };

const [packageDirectory, ...roles] = process.argv.slice(2);
if (!packageDirectory || !roles.length) throw new Error("usage: omp-models.ts <omp package dir> <role>...");
const load = (file: string) => import(join(packageDirectory, "src", file));
const { Settings } = await load("config/settings.ts");
const { ModelRegistry } = await load("config/model-registry.ts");
const { discoverAuthStorage } = await load("sdk.ts");
const resolver = await load("config/model-resolver.ts");
const fallback = await load("session/retry-fallback-chains.ts");
const { cfgRetryFallbackChains, cfgRetryModelFallback } = await load("session/settings.ts");

const cwd = process.cwd();
const settings = await Settings.loadReadOnly({ cwd });
const registry = new ModelRegistry(await discoverAuthStorage(undefined, { settings, cwd }));
const preferences = resolver.getModelMatchPreferences(settings);

const configured = settings.getModelRoles() as Record<string, string>;
const chains = fallback.expandDefaultRetryFallbackChains(cfgRetryFallbackChains.get(settings), [...Object.keys(configured), "default"]) as Record<string, string[]>;
const context = { chains, getModelRole: (role: string) => settings.getModelRole(role), modelLookup: registry };
const followFallbacks = cfgRetryModelFallback.get(settings) !== false;

// Models OMP can actually run: the available pool (credentials configured), by provider. Roles run against this pool, not the whole catalog.
const available = registry.getAvailable() as { provider: string; id: string }[];
const availableBy = new Map<string, typeof available>();
for (const model of available) availableBy.set(model.provider, [...(availableBy.get(model.provider) ?? []), model]);

// Every concrete model a selector can run as. A provider-qualified selector names one model (sdk.ts: the provider's catalog). A bare/fuzzy one (`gpt-5`)
// lands wherever OMP's role resolution over the available pool puts it, which depends on provider preference and credentials, so every available provider
// it matches is counted. With no available match, the whole-catalog match stands in (nothing can run it today, but credentials may appear).
function concrete(selector: string): { parsed: ReturnType<typeof fallback.parseRetryFallbackSelector>; models: { provider: string; id: string }[] } {
  const parsed = fallback.parseRetryFallbackSelector(selector, registry);
  if (parsed) {
    const model = registry.find(parsed.provider, parsed.id) ?? resolver.parseModelPattern(selector, registry.getProviderModels(parsed.provider), preferences).model;
    return { parsed, models: model ? [model] : [] };
  }
  const found = new Map<string, { provider: string; id: string }>();
  const chosen = resolver.resolveModelRoleValue(selector, available, { settings }).model;
  if (chosen) found.set(`${chosen.provider}/${chosen.id}`, chosen);
  for (const [, pool] of availableBy) {
    const model = resolver.parseModelPattern(selector, pool, preferences).model;
    if (model) found.set(`${model.provider}/${model.id}`, model);
  }
  if (!found.size) {
    const model = resolver.parseModelPattern(selector, registry.getAll(), preferences).model;
    if (model) found.set(`${model.provider}/${model.id}`, model);
  }
  return { parsed, models: [...found.values()] };
}
// `provider/id` of what the selector runs as; an id the catalog lacks still counts under its provider (fail closed), except wildcard-generated ids OMP itself skips.
const routes = (selector: string, literal: boolean): string[] => {
  const { parsed, models } = concrete(selector);
  if (models.length) return models.map((model) => `${model.provider}/${model.id}`);
  return literal && parsed ? [`${parsed.provider}/${parsed.id}`] : [];
};

// `unresolved`: role candidates that name no model OMP can find; the caller refuses them rather than skip them.
function reach(role: string): { models: Reach[]; unresolved: string[] } | null {
  const value = settings.getModelRole(role);
  if (!value?.trim()) return null;
  const reachableModels = new Map<string, Reach>();
  const unresolved: string[] = [];
  const seen = new Set<string>();
  const walk = (selector: string, hint: string | undefined) => {
    if (seen.has(`${selector}|${hint}`)) return;
    seen.add(`${selector}|${hint}`);
    if (!followFallbacks) return;
    for (const model of concrete(selector).models) { // each model a bare selector can run as owns its own chain
      const key = fallback.resolveRetryFallbackChainKey(context, selector, model, hint);
      if (!key) continue;
      for (const candidate of fallback.findRetryFallbackCandidates(context, key, selector, model, { allowMissingPrimary: true })) {
        const listed = chains[key]?.includes(candidate.raw) ?? false; // generated by a wildcard entry otherwise
        for (const id of routes(candidate.raw, listed)) if (!reachableModels.has(id)) reachableModels.set(id, { selector: id, via: { kind: "chain", key } });
        walk(candidate.raw, undefined); // an exhausted chain consults the fallback model's own chain
      }
    }
  };
  for (const pattern of resolver.resolveConfiguredModelPatterns(value, settings) as string[]) {
    const ids = routes(pattern, true);
    for (const id of ids) if (!reachableModels.has(id)) reachableModels.set(id, { selector: id, via: { kind: "role", key: role } });
    if (!ids.length) unresolved.push(pattern);
    walk(pattern, role);
  }
  return { models: [...reachableModels.values()], unresolved };
}

console.log(JSON.stringify(Object.fromEntries(roles.map((role) => [role, reach(role)]))));
process.exit(0);
