import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { git } from "./repo";
import { open, projectDir, record } from "./run";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "") || "work";

// One worktree per repo under <run>/ws/<repo>, on ark/<ticket>-<slug>, with pushing disabled.
export function wsCreate(runId: string, repoPath?: string): string {
  const { dir, state } = open(runId, "ws.created");
  const top = git(resolve(repoPath ?? projectDir()), "rev-parse", "--show-toplevel");
  const repo = basename(top);
  if (state.repos.some((r) => r.name === repo)) throw new Error(`run ${runId} already has a worktree for '${repo}'`);

  const branch = `ark/${state.ticket}-${slug(JSON.parse(readFileSync(join(dir, "ticket.json"), "utf8")).title)}`;
  // Default branch HEAD: origin/HEAD when the repo has a remote, else the checked-out HEAD.
  const origin = Bun.spawnSync(["git", "-C", top, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const base_sha = git(top, "rev-parse", `${origin.exitCode === 0 ? origin.stdout.toString().trim() : "HEAD"}^{commit}`);

  const wt = join(dir, "ws", repo);
  // Per-worktree config, so disabling the push URL does not touch the main checkout.
  git(top, "config", "extensions.worktreeConfig", "true");
  git(top, "worktree", "add", "-b", branch, wt, base_sha);
  for (const remote of git(top, "remote").split("\n").filter(Boolean)) git(wt, "config", "--worktree", `remote.${remote}.pushurl`, "DISABLED");

  record(dir, "ws.created", { repo, branch, base_sha });
  return `created ${wt}\nbranch: ${branch}\nbase_sha: ${base_sha}\n`;
}
