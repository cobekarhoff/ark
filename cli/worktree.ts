import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { git } from "./repo";
import { open, projectDirectory, record } from "./run";

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "") || "work";

// One worktree per repo under <run>/worktrees/<repo>, on ark/<ticket>-<slug>, with pushing disabled.
export function worktreeCreate(runId: string, repositoryPath?: string): string {
  const { directory, state } = open(runId, "worktree.created", "worktree create");
  const repositoryRoot = git(resolve(repositoryPath ?? projectDirectory()), "rev-parse", "--show-toplevel");
  const repository = basename(repositoryRoot);
  if (state.repos.some((recordedRepository) => recordedRepository.name === repository)) throw new Error(`run ${runId} already has a worktree for '${repository}'`);

  const branch = `ark/${state.ticket}-${slug(JSON.parse(readFileSync(join(directory, "ticket.json"), "utf8")).title)}`;
  // Default branch HEAD: origin/HEAD when the repo has a remote, else the checked-out HEAD.
  const origin = Bun.spawnSync(["git", "-C", repositoryRoot, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const baseCommit = git(repositoryRoot, "rev-parse", `${origin.exitCode === 0 ? origin.stdout.toString().trim() : "HEAD"}^{commit}`);

  const worktree = join(directory, "worktrees", repository);
  // Per-worktree config, so disabling the push URL does not touch the main checkout.
  git(repositoryRoot, "config", "extensions.worktreeConfig", "true");
  git(repositoryRoot, "worktree", "add", "-b", branch, worktree, baseCommit);
  for (const remote of git(repositoryRoot, "remote").split("\n").filter(Boolean)) git(worktree, "config", "--worktree", `remote.${remote}.pushurl`, "DISABLED");

  // Pushing is also stopped by a pre-push hook of the run's own: `pushurl` entries accumulate across config files, so a remote that already has one
  // is still tried first, and an explicit URL ignores them all. A hook runs before anything is sent. (`ark merge-request open` pushes from the shared git dir, where this config is not loaded.)
  const hooksDirectory = join(directory, "hooks");
  mkdirSync(hooksDirectory, { recursive: true });
  writeFileSync(join(hooksDirectory, "pre-push"), '#!/bin/sh\necho "ark: agents never push; ark merge-request open pushes for you" >&2\nexit 1\n');
  chmodSync(join(hooksDirectory, "pre-push"), 0o755);
  git(worktree, "config", "--worktree", "core.hooksPath", hooksDirectory);

  record(directory, "worktree.created", { repo: repository, branch, base_sha: baseCommit, source: repositoryRoot }); // source: the human's checkout; ark merge-request open trusts its git dir, never the worktree's .git file
  return `created ${worktree}\nbranch: ${branch}\nbase_sha: ${baseCommit}\n`;
}
