import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./repo";
import { project, projectDir, readLedger, record, runDir } from "./run";

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
  if (state.state !== "mrs_open") throw new Error(`ark mr is legal only in state 'mrs_open' (state '${state.state}')`);

  const cfg = Bun.YAML.parse(readFileSync(join(projectDir(), "ark.yml"), "utf8")) as { mr?: unknown };
  if (cfg.mr !== undefined && typeof cfg.mr !== "boolean") throw new Error("ark.yml: mr must be true or false");
  if (cfg.mr === false) {
    record(dir, "run.closed", { reason: "mr disabled" });
    return `MRs are disabled in ark.yml; run closed at ready branches: ${state.repos.map((r) => r.branch).join(", ")}\n`;
  }

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
    const wt = join(dir, "ws", repo.name);
    const url = git(wt, "config", "--get", "remote.origin.url");
    const slug = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/)?.[1];
    if (!slug) throw new Error(`cannot read owner/repo from remote.origin.url '${url}'`);
    const base = git(wt, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").replace(/^origin\//, "");

    // The worktree's pushurl is DISABLED for agents; an explicit URL bypasses it with the CLI's own credentials.
    git(wt, "push", url, `HEAD:refs/heads/${repo.branch}`);

    const bodyFile = join(dir, "mr", `${repo.name}.md`);
    mkdirSync(join(dir, "mr"), { recursive: true });
    writeFileSync(bodyFile, body);
    const [found] = JSON.parse(gh("pr", "list", "--repo", slug, "--head", repo.branch, "--json", "url,number") || "[]") as { url: string; number: number }[];
    const prUrl = found?.url ?? gh("pr", "create", "--repo", slug, "--head", repo.branch, "--base", base, "--title", `${state.ticket}: ${ticket.title}`, "--body-file", bodyFile).split("\n").pop()!;
    const number = found?.number ?? Number(prUrl.match(/\/pull\/(\d+)/)?.[1]);
    if (!Number.isInteger(number)) throw new Error(`cannot read a PR number from '${prUrl}'`);
    if (!events.some((e) => e.type === "mr.opened" && e.data.url === prUrl)) record(dir, "mr.opened", { repo: repo.name, url: prUrl, number });
    out.push(`${repo.name}: ${prUrl}`);
  }
  return `${out.join("\n")}\n`;
}
