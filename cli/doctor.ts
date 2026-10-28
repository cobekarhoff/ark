import { git } from "./repo";
import { projectDirectory } from "./run";

// `ark doctor`, first check: the git host's default branch is what bounds an agent that ignores every other guardrail (ADR 0003), so it must be protected.
// Asks the host, not the local clone, for the default branch and its protection.
export function doctor(): string {
  const root = projectDirectory();
  const url = git(root, "config", "--get", "remote.origin.url");
  const slug = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/)?.[1];
  if (!slug) throw new Error(`cannot read owner/repo from remote.origin.url of ${root}`);
  const gh = (path: string) => {
    const result = Bun.spawnSync(["gh", "api", path]);
    if (result.exitCode !== 0) throw new Error(`gh api ${path} failed: ${result.stderr.toString().trim()}`);
    return JSON.parse(result.stdout.toString());
  };
  const branch: string = gh(`repos/${slug}`).default_branch;
  const protection = gh(`repos/${slug}/branches/${branch}/protection`);
  const checks: string[] = protection.required_status_checks?.contexts ?? [];
  const bypassAllowances = protection.required_pull_request_reviews?.bypass_pull_request_allowances ?? {};
  const bypass: string[] = [...(bypassAllowances.users ?? []).map((user: { login: string }) => `user ${user.login}`), ...(bypassAllowances.teams ?? []).map((team: { slug: string }) => `team ${team.slug}`), ...(bypassAllowances.apps ?? []).map((application: { slug: string }) => `app ${application.slug}`)];
  const missing = [
    protection.enforce_admins?.enabled !== true && "administrators are not included (enforce_admins is off)",
    !protection.required_pull_request_reviews && "pull requests are not required",
    bypass.length > 0 && `these may bypass the pull request requirement: ${bypass.join(", ")}`,
    !checks.length && "no status check is required",
    protection.allow_force_pushes?.enabled !== false && "force pushes are allowed",
    protection.allow_deletions?.enabled !== false && "deleting the branch is allowed",
  ].filter(Boolean);
  if (missing.length) throw new Error(`${slug} ${branch} is not protected enough: ${missing.join("; ")}`);
  return `ok: ${slug} ${branch} protected (administrators included, pull request required with no bypass allowances, checks: ${checks.join(", ")}, no force pushes, no deletion)\n`;
}
