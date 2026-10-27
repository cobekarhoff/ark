import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { projectDir } from "./run";
import type { Reach } from "./omp-models";

// FR-13 AC1: cross-vendor review is enforced on every model a role can reach, not on the config text.
// What a role can reach is OMP's business: selector matching (fuzzy ids, thinking suffixes), comma candidates, role aliases, and the fallback walk
// (chain ownership by specificity, wildcard entries, each fallback model's own chain). That logic is OMP's own code, run by `cli/omp-models.ts`
// in a subprocess, so the CLI core imports nothing from OMP (NFR-03) and cannot drift from it. If OMP cannot be loaded, preflight refuses.
// The vendor is the resolved model's provider prefix. ponytail: provider prefix stands for vendor; an aggregator (openrouter/...) would need a vendor map.
const ROLES = ["implement", "validate", "review-x", "review-s"] as const;

// The installed OMP package: $ARK_OMP_PACKAGE, else the package that owns the `omp` binary on PATH.
function ompPackage(): string {
  const given = process.env.ARK_OMP_PACKAGE;
  if (given) return given;
  const bin = Bun.which("omp");
  if (!bin) throw new Error("preflight refused: cannot find OMP (no 'omp' on PATH and ARK_OMP_PACKAGE is not set); Ark checks models with OMP's own resolver");
  for (let d = dirname(realpathSync(bin)); d !== dirname(d); d = dirname(d)) {
    const file = join(d, "package.json");
    if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).name === "@oh-my-pi/pi-coding-agent") return d;
  }
  throw new Error(`preflight refused: ${bin} is not inside an @oh-my-pi/pi-coding-agent package; set ARK_OMP_PACKAGE`);
}

function reachable(): Record<string, Reach[] | null> {
  const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "omp-models.ts"), ompPackage(), ...ROLES], { cwd: projectDir() });
  if (r.exitCode !== 0) throw new Error(`preflight refused: OMP's model resolver failed to load or run:\n${r.stderr.toString().trim()}`);
  return JSON.parse(r.stdout.toString());
}

// Which config file defines `retry.fallbackChains.<key>` / `modelRoles.<key>`: the project's, else the global one (omp://settings.md:12-20), else OMP's own layers.
function origin(via: Reach["via"], projectFile: string): string {
  const section = via.kind === "chain" ? ["retry", "fallbackChains"] : ["modelRoles"];
  const globalFile = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent"), "config.yml");
  for (const [label, file] of [["project", projectFile], ["global", globalFile]] as const) {
    if (!existsSync(file)) continue;
    let node: unknown = Bun.YAML.parse(readFileSync(file, "utf8"));
    for (const k of section) node = typeof node === "object" && node !== null ? (node as Record<string, unknown>)[k] : undefined;
    if (typeof node === "object" && node !== null && Object.hasOwn(node, via.key)) return `${label} config ${file}`;
  }
  return "OMP config";
}

export function preflight(): string {
  const file = join(projectDir(), ".omp", "config.yml");
  const reach = reachable();
  if (!existsSync(file) && !reach.implement) throw new Error(`preflight: no ${file}; write modelRoles for ${ROLES.join(", ")}`);
  for (const r of ROLES) if (!reach[r]) throw new Error(`modelRoles.${r} is not set in the OMP config`);
  const model = reach as Record<(typeof ROLES)[number], Reach[]>;
  const vendor = (m: Reach) => m.selector.split("/")[0];
  const implementers = new Set(model.implement.map(vendor));
  const how = (m: Reach) => (m.via.kind === "chain" ? ` via retry.fallbackChains.${m.via.key} (${origin(m.via, file)})` : "");
  const bad = [
    ...(["validate", "review-x"] as const).flatMap((r) =>
      model[r].filter((m) => implementers.has(vendor(m))).map((m) => `${r} (${m.selector}) shares the implementer's vendor '${vendor(m)}'${how(m)}`)),
    ...model["review-s"].filter((m) => !implementers.has(vendor(m))).map((m) => `review-s (${m.selector}) is not on the implementer's vendor '${[...implementers].join(", ")}'${how(m)}`),
  ];
  if (bad.length) throw new Error(`preflight refused (${file}):\n${bad.map((b) => `  - ${b}`).join("\n")}`);
  return `preflight ok\n${ROLES.map((r) => `  ${r}: ${model[r][0].selector}${model[r].length > 1 ? ` (also reachable: ${model[r].slice(1).map((m) => m.selector).join(", ")})` : ""}\n`).join("")}`;
}
