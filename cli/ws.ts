import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { git } from "./repo";
import { open, projectDir, record } from "./run";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "") || "work";

// One worktree per repo under <run>/ws/<repo>, on ark/<ticket>-<slug>, with pushing disabled.
export function wsCreate(runId: string, repoPath?: string): string {
  const { dir, state } = open(runId, "ws.created", "ws");
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

  // Pushing is also stopped by a pre-push hook of the run's own: `pushurl` entries accumulate across config files, so a remote that already has one
  // is still tried first, and an explicit URL ignores them all. A hook runs before anything is sent. (`ark mr` pushes from the shared git dir, where this config is not loaded.)
  const hooks = join(dir, "hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, "pre-push"), '#!/bin/sh\necho "ark: agents never push; ark mr pushes for you" >&2\nexit 1\n');
  chmodSync(join(hooks, "pre-push"), 0o755);
  git(wt, "config", "--worktree", "core.hooksPath", hooks);

  record(dir, "ws.created", { repo, branch, base_sha, source: top }); // source: the human's checkout; ark mr trusts its git dir, never the worktree's .git file
  return `created ${wt}\nbranch: ${branch}\nbase_sha: ${base_sha}\n`;
}
