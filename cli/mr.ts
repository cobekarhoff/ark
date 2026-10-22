import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./repo";
import { mrEnabled, project, readLedger, record, runDir } from "./run";

type Pr = { url: string; number: number; state: string; baseRefName: string; headRepositoryOwner: { login: string } | null };

// Remote URLs may carry credentials (https://user:token@host/..): no error or ledger line may show them.
const redact = (s: string) => s.replace(/(\/\/)[^/@\s]+@/g, "$1***@");

function gh(...args: string[]): string {
  const r = Bun.spawnSync(["gh", ...args]);
  if (r.exitCode !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

// Opens one GitHub PR per repo worktree. The only gh subcommands used are `pr list` and `pr create`: nothing here, or anywhere in the CLI, merges.
export function mr(runId: string): string {
  const dir = runDir(runId);
  const events = readLedger(dir);
  const state = project(events);
  const illegal = () => new Error(`ark mr is legal only in state 'mrs_open' (state '${state.state}')`);

  if (!mrEnabled()) { // normally G2 approval already closed the run; this covers a config flipped after approval
    if (state.state === "mrs_open") record(dir, "run.closed", { reason: "mr disabled" });
    else if (state.state !== "done") throw illegal();
    return `MRs are disabled in ark.yml; run closed at ready branches: ${state.repos.map((r) => r.branch).join(", ")}\n`;
  }
  if (state.state !== "mrs_open") throw illegal();

  const ticket = JSON.parse(readFileSync(join(dir, "ticket.json"), "utf8")) as { title: string; acceptance_criteria: { id: string; text: string }[] };
  const matrixFile = join(dir, "trace-matrix.md");
  if (!existsSync(matrixFile)) throw new Error("trace-matrix.md is missing from the run folder");
  const art = join(dir, "artifacts");
  const evidence = existsSync(art) ? (readdirSync(art, { recursive: true }) as string[]).filter((f) => statSync(join(art, f)).isFile()).sort() : [];
  const body = [
    `# ${state.ticket}: ${ticket.title}`,
    ticket.acceptance_criteria.map((a) => `- ${a.id}: ${a.text}`).join("\n"),
    `## Trace matrix\n\n${readFileSync(matrixFile, "utf8").trimEnd()}`,
    `## Evidence (paths relative to the run folder, run ${runId})\n\n${evidence.length ? evidence.map((f) => `- artifacts/${f}`).join("\n") : "- none"}`,
  ].join("\n\n") + "\n";

  const out: string[] = [];
  for (const repo of state.repos) {
    const done = events.find((e) => e.type === "mr.opened" && e.data.repo === repo.name);
    if (done) {
      out.push(`${repo.name}: ${done.data.url}`);
      continue;
    }
    const wt = join(dir, "ws", repo.name);
    // Only ark/* branches, and only the SHA that was approved: an agent must not steer the CLI's credentials at another branch or at later commits.
    if (!repo.branch.startsWith("ark/")) throw new Error(`refusing to push '${repo.branch}': not an ark/ branch`);
    if (!repo.head_sha) throw new Error(`${repo.name} has no recorded head_sha; record implementer.completed before ark mr`);
    if (git(wt, "rev-parse", "HEAD") !== repo.head_sha) throw new Error(`${wt} HEAD differs from the approved ${repo.head_sha}; commits made after approval are not pushed`);

    // The URL comes from the shared config of the main checkout, not the agent's worktree config.
    const common = git(wt, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const url = git(wt, "config", "--file", join(common, "config"), "--get", "remote.origin.url");
    const slug = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/)?.[1];
    if (!slug) throw new Error(`cannot read owner/repo from remote.origin.url '${redact(url)}'`);
    const head = Bun.spawnSync(["git", "-C", wt, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (head.exitCode !== 0) throw new Error(`${repo.name} has no origin/HEAD to read the default branch from; run 'git remote set-head origin -a'`);
    const base = head.stdout.toString().trim().replace(/^origin\//, "");

    // The worktree's pushurl is DISABLED for agents; an explicit URL bypasses it with the CLI's own credentials.
    // Pushed from the shared git dir, so the agent's per-worktree config (insteadOf, hooksPath) is never loaded; the SHA resolves in the shared object store.
    const push = Bun.spawnSync(["git", "--git-dir", common, "push", url, `${repo.head_sha}:refs/heads/${repo.branch}`]);
    if (push.exitCode !== 0) throw new Error(redact(`git push ${url} failed: ${push.stderr.toString().trim()}`));

    const bodyFile = join(dir, "mr", `${repo.name}.md`);
    mkdirSync(join(dir, "mr"), { recursive: true });
    writeFileSync(bodyFile, body);
    // A PR counts as ours only if it is from this repo (not a fork with the same branch name) into the default branch.
    const owner = slug.split("/")[0].toLowerCase();
    const prs = JSON.parse(gh("pr", "list", "--repo", slug, "--head", repo.branch, "--state", "all", "--json", "url,number,state,baseRefName,headRepositoryOwner") || "[]") as Pr[];
    const mine = prs.filter((p) => p.baseRefName === base && p.headRepositoryOwner?.login.toLowerCase() === owner);
    const found = mine.find((p) => p.state === "OPEN");
    const dead = mine.find((p) => p.state !== "OPEN");
    if (!found && dead) throw new Error(`${repo.branch} already has a ${dead.state.toLowerCase()} PR ${dead.url}; ark mr will not reuse it`);
    const prUrl = found?.url ?? gh("pr", "create", "--repo", slug, "--head", repo.branch, "--base", base, "--title", `${state.ticket}: ${ticket.title}`, "--body-file", bodyFile).split("\n").pop()!;
    const number = found?.number ?? Number(prUrl.match(/\/pull\/(\d+)/)?.[1]);
    if (!Number.isInteger(number)) throw new Error(`cannot read a PR number from '${prUrl}'`);
    record(dir, "mr.opened", { repo: repo.name, url: prUrl, number });
    out.push(`${repo.name}: ${prUrl}`);
  }
  return `${out.join("\n")}\n`;
}
