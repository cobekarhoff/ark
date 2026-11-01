import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendEvent, deriveState, readEvents } from "../cli/events.ts";

const repositoryRoot = join(import.meta.dir, "..");

export function tempArkHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ark-home-"));
  process.env.ARK_HOME = home;
  return home;
}

/** Writes `$ARK_HOME/projects/<name>/ark.yml`. JSON is valid YAML, so the config is written as JSON. */
export function writeProject(name: string, config: Record<string, unknown>): string {
  const directory = join(process.env.ARK_HOME as string, "projects", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "ark.yml"), JSON.stringify(config, null, 2));
  return directory;
}

export function writeTicket(
  project: string,
  id: string,
  criteria: { id: string; text: string }[],
  title = `Ticket ${id}`,
): string {
  const file = join(process.env.ARK_HOME as string, "projects", project, "tickets", `${id}.md`);
  mkdirSync(dirname(file), { recursive: true });
  const frontmatter = [
    "---",
    `id: ${id}`,
    `title: ${JSON.stringify(title)}`,
    ...(criteria.length === 0 ? ["acceptance_criteria: []"] : ["acceptance_criteria:"]),
  ];
  for (const criterion of criteria)
    frontmatter.push(`  - id: ${criterion.id}`, `    text: ${JSON.stringify(criterion.text)}`);
  writeFileSync(file, `${frontmatter.join("\n")}\n---\n## Why\n\nTest ticket.\n`);
  return file;
}

function git(directory: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: directory });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
}

export function tempGitRepo(files: Record<string, string> = { "README.md": "# test\n" }): string {
  const directory = mkdtempSync(join(tmpdir(), "ark-repo-"));
  git(directory, "init", "-q", "-b", "main");
  git(directory, "config", "user.name", "Ark Test");
  git(directory, "config", "user.email", "ark@example.com");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, name)), { recursive: true });
    writeFileSync(join(directory, name), content);
  }
  git(directory, "add", "-A");
  git(directory, "commit", "-q", "-m", "initial");
  return directory;
}

export function ark(...args: string[]): { code: number; out: string; err: string } {
  const result = Bun.spawnSync(["bun", join(repositoryRoot, "cli", "ark.ts"), ...args], {
    env: process.env,
  });
  return {
    code: result.exitCode ?? 1,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
  };
}

/**
 * Records an evaluation the way ark evaluation record does. A clear evaluation that leaves the run
 * in planning also records a one-card strategy, so the run can pass ark plan check.
 */
export function recordEvaluation(
  runDirectory: string,
  blockers: string[] = [],
  risks: string[] = [],
): void {
  appendEvent(runDirectory, "evaluation.recorded", { blockers, risks, surfaces: ["none"] });
  if (deriveState(readEvents(runDirectory)).phase !== "planning") return;
  appendEvent(runDirectory, "strategy.recorded", {
    count: 1,
    recommended: "S1",
    cards: ["S1"],
    reason: "the only approach fits",
    card_text: { S1: "### S1 Only" },
  });
}
