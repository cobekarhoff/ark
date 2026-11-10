import type { ProjectConfig } from "./config.ts";

// omp models --json takes about 2 s and lists several hundred models.
const modelListTimeoutMs = 60_000;

/** The omp selectors, or the reason the list could not be read. */
function ompSelectors(): Set<string> | string {
  let result: Bun.SyncSubprocess<"pipe", "pipe">;
  try {
    result = Bun.spawnSync(["omp", "models", "--json"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: modelListTimeoutMs,
    });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (result.exitCode === null) return `omp models --json timed out`;
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim().split("\n")[0];
    return `omp models --json exited ${result.exitCode}${detail ? `: ${detail}` : ""}`;
  }
  try {
    const parsed = JSON.parse(result.stdout.toString()) as { models: { selector: string }[] };
    return new Set(parsed.models.map((model) => model.selector));
  } catch {
    return "omp models --json printed no valid JSON";
  }
}

/**
 * One line per role that cannot run, per project, plus a "role models: unchecked" line when the omp model list could not be read.
 * claude, codex and pi are checked on PATH only; omp roles also need their model in `omp models --json`, read once for all projects.
 */
export function checkRoles(configs: Record<string, ProjectConfig>): {
  lines: string[];
  failures: number;
} {
  const entries = Object.entries(configs).map(
    ([project, config]) => [project, Object.entries(config.roles)] as const,
  );
  const usesOmp = entries.some(([, roles]) => roles.some(([, role]) => role.harness === "omp"));
  const selectors =
    usesOmp && Bun.which("omp", { PATH: process.env.PATH }) ? ompSelectors() : undefined;
  const lines: string[] = [];
  let failures = 0;
  for (const [project, roles] of entries) {
    const causes: string[] = [];
    for (const [name, role] of roles) {
      if (!Bun.which(role.harness, { PATH: process.env.PATH }))
        causes.push(`role ${name}: harness ${role.harness} not installed`);
      else if (role.harness === "omp" && selectors instanceof Set && !selectors.has(role.model))
        causes.push(`role ${name}: omp ${role.model}: model not found by omp`);
    }
    if (causes.length === 0) continue;
    failures += causes.length;
    lines.push(project, ...causes.map((cause) => `  ${cause}`));
  }
  if (typeof selectors === "string") lines.push(`role models: unchecked (${selectors})`);
  else if (usesOmp && selectors === undefined)
    lines.push("role models: unchecked (omp not installed)");
  return { lines, failures };
}
