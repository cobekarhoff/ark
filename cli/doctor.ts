import { git } from "./repo";
import { projectDir } from "./run";

// `ark doctor`, first check: the git host's default branch is what bounds an agent that ignores every other guardrail (ADR 0003), so it must be protected.
// Asks the host, not the local clone, for the default branch and its protection.
export function doctor(): string {
  const root = projectDir();
  const url = git(root, "config", "--get", "remote.origin.url");
  const slug = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/)?.[1];
  if (!slug) throw new Error(`cannot read owner/repo from remote.origin.url of ${root}`);
  const gh = (path: string) => {
    const r = Bun.spawnSync(["gh", "api", path]);
    if (r.exitCode !== 0) throw new Error(`gh api ${path} failed: ${r.stderr.toString().trim()}`);
    return JSON.parse(r.stdout.toString());
  };
  const branch: string = gh(`repos/${slug}`).default_branch;
  const p = gh(`repos/${slug}/branches/${branch}/protection`);
  const checks: string[] = p.required_status_checks?.contexts ?? [];
  const missing = [
    p.enforce_admins?.enabled !== true && "administrators are not included (enforce_admins is off)",
    !p.required_pull_request_reviews && "pull requests are not required",
    !checks.length && "no status check is required",
    p.allow_force_pushes?.enabled !== false && "force pushes are allowed",
  ].filter(Boolean);
  if (missing.length) throw new Error(`${slug} ${branch} is not protected enough: ${missing.join("; ")}`);
  return `ok: ${slug} ${branch} protected (administrators included, pull request required, checks: ${checks.join(", ")}, no force pushes)\n`;
}
