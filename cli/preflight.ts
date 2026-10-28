import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { projectDirectory } from "./run";
import type { Reach } from "./omp-models";

// FR-13 AC1: cross-vendor review is enforced on every model a role can reach, not on the config text.
// What a role can reach is OMP's business: selector matching (fuzzy ids, thinking suffixes), comma candidates, role aliases, and the fallback walk
// (chain ownership by specificity, wildcard entries, each fallback model's own chain). That logic is OMP's own code, run by `cli/omp-models.ts`
// in a subprocess, so the CLI core imports nothing from OMP (NFR-03) and cannot drift from it. If OMP cannot be loaded, preflight refuses.
// The vendor is the resolved model's provider prefix. ponytail: provider prefix stands for vendor; an aggregator (openrouter/...) would need a vendor map.
const ROLES = ["implement", "validate", "review-x", "review-s"] as const;

// The installed OMP package: $ARK_OMP_PACKAGE, else the package that owns the `omp` binary on PATH.
function ompPackage(): string {
  const configuredPackage = process.env.ARK_OMP_PACKAGE;
  if (configuredPackage) return configuredPackage;
  const binary = Bun.which("omp");
  if (!binary) throw new Error("preflight refused: cannot find Oh My Pi (OMP) (no 'omp' on PATH and ARK_OMP_PACKAGE is not set); Ark checks models with OMP's own resolver");
  for (let directory = dirname(realpathSync(binary)); directory !== dirname(directory); directory = dirname(directory)) {
    const file = join(directory, "package.json");
    if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).name === "@oh-my-pi/pi-coding-agent") return directory;
  }
  throw new Error(`preflight refused: ${binary} is not inside an @oh-my-pi/pi-coding-agent package; set ARK_OMP_PACKAGE`);
}

type Roles = Record<string, { models: Reach[]; unresolved: string[] } | null>;
function reachable(): Roles {
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "omp-models.ts"), ompPackage(), ...ROLES, "default"], { cwd: projectDirectory() });
  if (result.exitCode !== 0) throw new Error(`preflight refused: Oh My Pi (OMP)'s model resolver failed to load or run:\n${result.stderr.toString().trim()}`);
  return JSON.parse(result.stdout.toString());
}

// Which config file defines `retry.fallbackChains.<key>` / `modelRoles.<key>`: the project's, else the global one (omp://settings.md:12-20), else OMP's own layers.
function origin(via: Reach["via"], projectFile: string): string {
  const section = via.kind === "chain" ? ["retry", "fallbackChains"] : ["modelRoles"];
  const globalFile = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent"), "config.yml");
  for (const [label, file] of [["project", projectFile], ["global", globalFile]] as const) {
    if (!existsSync(file)) continue;
    let node: unknown = Bun.YAML.parse(readFileSync(file, "utf8"));
    for (const key of section) node = typeof node === "object" && node !== null ? (node as Record<string, unknown>)[key] : undefined;
    if (typeof node === "object" && node !== null && Object.hasOwn(node, via.key)) return `${label} config ${file}`;
  }
  return "Oh My Pi (OMP) config";
}

export function preflight(): string {
  const file = join(projectDirectory(), ".omp", "config.yml");
  const roles = reachable();
  if (!existsSync(file) && !roles.implement) throw new Error(`preflight: no ${file}; write modelRoles for ${ROLES.join(", ")}`);
  for (const role of ROLES) {
    const roleModels = roles[role];
    if (!roleModels) throw new Error(`modelRoles.${role} is not set in the Oh My Pi (OMP) config`);
    // A selector OMP cannot resolve is not "unreachable": the catalog may differ at runtime (omp models refresh), so refuse instead of skipping it.
    if (roleModels.unresolved.length) throw new Error(`preflight refused: ${role} names no model Oh My Pi (OMP) knows: ${roleModels.unresolved.map((selector) => `'${selector}'`).join(", ")}`);
    if (!roleModels.models.length) throw new Error(`preflight refused: ${role} resolves to no model`);
  }
  const modelsByRole = Object.fromEntries(ROLES.map((role) => [role, roles[role]!.models])) as Record<(typeof ROLES)[number], Reach[]>;
  // A subagent whose role has no working credential runs on the parent session's model, whatever retry.modelFallback says
  // (OMP: resolveModelOverrideWithAuthFallback, src/config/model-resolver.ts). Ark's parent is the orchestrator, the `default` role, so what `default` can reach
  // (its model and that model's own chain) is reachable by every model-calling subagent whose vendor must differ from the implementer's.
  // ponytail: the implement and review-s roles are not widened this way; doing so would refuse the PRD default (default on the validator's vendor).
  const parent = (roles.default?.models ?? []).map((model): Reach => ({ selector: model.selector, via: { kind: "parent", key: "default" } }));
  for (const role of ["validate", "review-x"] as const) for (const model of parent) if (!modelsByRole[role].some((candidate) => candidate.selector === model.selector)) modelsByRole[role] = [...modelsByRole[role], model];
  const vendor = (model: Reach) => model.selector.split("/")[0];
  const implementers = new Set(modelsByRole.implement.map(vendor));
  const how = (model: Reach) => (model.via.kind === "parent" ? " via the parent session model (the default role)" : model.via.kind === "chain" ? ` via retry.fallbackChains.${model.via.key} (${origin(model.via, file)})` : "");
  const bad = [
    ...(["validate", "review-x"] as const).flatMap((role) =>
      modelsByRole[role].filter((model) => implementers.has(vendor(model))).map((model) => `${role} (${model.selector}) shares the implementer's vendor '${vendor(model)}'${how(model)}`)),
    ...modelsByRole["review-s"].filter((model) => !implementers.has(vendor(model))).map((model) => `review-s (${model.selector}) is not on the implementer's vendor '${[...implementers].join(", ")}'${how(model)}`),
  ];
  if (bad.length) throw new Error(`preflight refused (${file}):\n${bad.map((reason) => `  - ${reason}`).join("\n")}`);
  return `preflight ok\n${ROLES.map((role) => `  ${role}: ${modelsByRole[role][0].selector}${modelsByRole[role].length > 1 ? ` (also reachable: ${modelsByRole[role].slice(1).map((model) => model.selector).join(", ")})` : ""}\n`).join("")}`;
}
