import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { projectDir } from "./run";

// FR-13 AC1: cross-vendor review is enforced on the resolved role models, not on the config text.
// Roles come from the project's .omp/config.yml `modelRoles`; the provider is the selector's prefix before the first "/".
// ponytail: provider prefix stands for vendor; an aggregator (openrouter/...) would need a vendor map.
const ROLES = ["implement", "validate", "review-x", "review-s"] as const;

// "@alias" -> its role value; "a,b" -> first candidate; ":high" thinking suffix dropped.
function resolve(roles: Record<string, unknown>, role: string, seen: string[] = []): string {
  if (seen.includes(role)) throw new Error(`modelRoles.${role}: alias cycle ${[...seen, role].join(" -> ")}`);
  const v = roles[role];
  if (typeof v !== "string" || !v.trim()) throw new Error(`modelRoles.${role} is not set in .omp/config.yml`);
  const first = v.split(",")[0].trim();
  if (first.startsWith("@")) return resolve(roles, first.slice(1), [...seen, role]);
  const model = first.replace(/:[a-z]+$/, "");
  if (!model.includes("/")) throw new Error(`modelRoles.${role} '${v}' is not a provider/model selector`);
  return model;
}

export function preflight(): string {
  const file = join(projectDir(), ".omp", "config.yml");
  if (!existsSync(file)) throw new Error(`preflight: no ${file}; write modelRoles for ${ROLES.join(", ")}`);
  const roles = (Bun.YAML.parse(readFileSync(file, "utf8")) as { modelRoles?: Record<string, unknown> } | null)?.modelRoles ?? {};
  const model = Object.fromEntries(ROLES.map((r) => [r, resolve(roles, r)]));
  const vendor = (r: string) => model[r].split("/")[0];
  const bad = [
    ...["validate", "review-x"].filter((r) => vendor(r) === vendor("implement")).map((r) => `${r} (${model[r]}) shares the implementer's provider '${vendor("implement")}'`),
    ...(vendor("review-s") === vendor("implement") ? [] : [`review-s (${model["review-s"]}) is not on the implementer's provider '${vendor("implement")}'`]),
  ];
  if (bad.length) throw new Error(`preflight refused (${file}):\n${bad.map((b) => `  - ${b}`).join("\n")}`);
  return `preflight ok\n${ROLES.map((r) => `  ${r}: ${model[r]}\n`).join("")}`;
}
