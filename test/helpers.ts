import { afterAll, beforeAll } from "bun:test";
import type { Subprocess } from "bun";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendEvent, deriveState, readEvents } from "../cli/events.ts";
import { fakeToolScripts, writeFakeToolState, type FakeToolOptions } from "./hub-fixtures.ts";

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
  criteria: {
    id: string;
    text: string;
    manual?: boolean;
    method?: string;
    /** Any value, so a test can write a `verified_by` that is not a list. */
    verified_by?: unknown;
  }[],
  title = `Ticket ${id}`,
  kind?: string,
): string {
  const file = join(process.env.ARK_HOME as string, "projects", project, "tickets", `${id}.md`);
  mkdirSync(dirname(file), { recursive: true });
  const frontmatter = [
    "---",
    `id: ${id}`,
    `title: ${JSON.stringify(title)}`,
    "status: ready",
    ...(kind === undefined ? [] : [`kind: ${kind}`]),
    ...(criteria.length === 0 ? ["acceptance_criteria: []"] : ["acceptance_criteria:"]),
  ];
  for (const criterion of criteria)
    frontmatter.push(
      `  - id: ${criterion.id}`,
      `    text: ${JSON.stringify(criterion.text)}`,
      ...(criterion.manual ? ["    manual: true"] : []),
      ...(criterion.method === undefined ? [] : [`    method: ${criterion.method}`]),
      ...(criterion.verified_by === undefined
        ? []
        : [`    verified_by: ${JSON.stringify(criterion.verified_by)}`]),
    );
  writeFileSync(file, `${frontmatter.join("\n")}\n---\n## Why\n\nTest ticket.\n`);
  return file;
}

function git(directory: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: directory });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
}

/** One built repo for each distinct file set in this process: repos with the same files share commit ids. */
const repoTemplates = new Map<string, string>();

export function tempGitRepo(files: Record<string, string> = { "README.md": "# test\n" }): string {
  const key = JSON.stringify(Object.entries(files));
  let template = repoTemplates.get(key);
  if (template === undefined) {
    template = mkdtempSync(join(tmpdir(), "ark-repo-template-"));
    git(template, "init", "-q", "-b", "main");
    git(template, "config", "user.name", "Ark Test");
    git(template, "config", "user.email", "ark@example.com");
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(template, name)), { recursive: true });
      writeFileSync(join(template, name), content);
    }
    git(template, "add", "-A");
    git(template, "commit", "-q", "-m", "initial");
    repoTemplates.set(key, template);
  }
  const directory = mkdtempSync(join(tmpdir(), "ark-repo-"));
  cpSync(template, directory, { recursive: true });
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

/** Writes an executable `<name>` with the given shell script and puts it first on PATH. Callers restore PATH. */
export function writeFakeCommand(name: string, script: string): string {
  const directory = mkdtempSync(join(tmpdir(), `ark-${name}-`));
  const file = join(directory, name);
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
  process.env.PATH = `${directory}:${process.env.PATH}`;
  return directory;
}

/** Fake gh and glab: each answers from `answers`, keyed by its exact argument list. A missing key fails with exit 1, like an unreachable host. Puts both first on PATH; callers restore PATH. */
export function fakeHosts(answers: Record<string, unknown>): void {
  const bin = mkdtempSync(join(tmpdir(), "ark-hosts-"));
  const scenario = join(bin, "answers.json");
  writeFileSync(scenario, JSON.stringify(answers));
  for (const tool of ["gh", "glab"]) {
    const file = join(bin, tool);
    writeFileSync(
      file,
      `#!/usr/bin/env bun
import { readFileSync } from "node:fs";
const answers = JSON.parse(readFileSync(${JSON.stringify(scenario)}, "utf8"));
const key = "${tool} " + process.argv.slice(2).join(" ");
if (!Object.hasOwn(answers, key)) { console.error("host cannot answer: " + key); process.exit(1); }
const answer = answers[key];
console.log(typeof answer === "string" ? answer : JSON.stringify(answer));
`,
    );
    chmodSync(file, 0o755);
  }
  process.env.PATH = `${bin}:${process.env.PATH}`;
}

/** A fresh state folder for the fake `orca`, `gh`, `omp` and `plannotator`; puts the four on PATH. */
export function installFakeTools(options: FakeToolOptions): string {
  const state = mkdtempSync(join(tmpdir(), "ark-fake-tools-"));
  writeFakeToolState(state, options);
  const scripts = fakeToolScripts(state);
  writeFakeCommand("orca", scripts.orca);
  writeFakeCommand("gh", scripts.gh);
  writeFakeCommand("omp", scripts.omp);
  writeFakeCommand("plannotator", scripts.plannotator);
  return state;
}

export type StartedHub = {
  process: Subprocess<"ignore", "pipe", "pipe">;
  baseUrl: string;
};

/** Starts `bun hub/main.ts --port 0` and resolves once it prints its address. The caller stops it with `stopHub`. */
export async function startHub(): Promise<StartedHub> {
  const hub = Bun.spawn(["bun", join(repositoryRoot, "hub", "main.ts"), "--port", "0"], {
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let output = "";
  for await (const chunk of hub.stdout) {
    output += new TextDecoder().decode(chunk);
    const port = output.match(/127\.0\.0\.1:(\d+)/)?.[1];
    if (port) return { process: hub, baseUrl: `http://127.0.0.1:${port}` };
  }
  throw new Error(`the hub exited before serving: ${output}`);
}

export async function stopHub(hub: { kill(): void; exited: Promise<number> }): Promise<void> {
  hub.kill();
  await hub.exited;
}

/**
 * Records an evaluation the way ark evaluation record does. A run always waits for the criteria gate
 * (ARK-311): a clear evaluation of a run with criteria also records the human's criteria accept, then
 * a one-card strategy, so the run can pass ark plan check. An evaluation with blockers leaves the gate open.
 */
export function recordEvaluation(
  runDirectory: string,
  blockers: string[] = [],
  risks: string[] = [],
): void {
  appendEvent(runDirectory, "evaluation.recorded", { blockers, risks, surfaces: ["none"] });
  const waiting = deriveState(readEvents(runDirectory));
  if (blockers.length === 0 && waiting.phase === "awaiting_criteria" && waiting.criteria.length > 0)
    appendEvent(runDirectory, "gate.answered", { gate: "criteria", answer: "accept", by: "human" });
  if (deriveState(readEvents(runDirectory)).phase !== "planning") return;
  appendEvent(runDirectory, "strategy.recorded", {
    count: 1,
    recommended: "S1",
    cards: ["S1"],
    reason: "the only approach fits",
    card_text: { S1: "### S1 Only" },
  });
}

/** Freezes the hub clock for the calling test file: keeps a caller's ARK_NOW, else sets a fixed mid-week instant, and restores the variable afterwards. `ark ui` subprocesses inherit it. */
export function useFrozenClock(): void {
  let previous: string | undefined;
  beforeAll(() => {
    previous = process.env.ARK_NOW;
    if ((previous ?? "") === "") process.env.ARK_NOW = "2026-11-04T12:00:00Z";
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.ARK_NOW;
    else process.env.ARK_NOW = previous;
  });
}

/** The frozen hub clock (ARK_NOW, the variable cli/clock.ts reads), in epoch milliseconds. */
export function testNow(): number {
  return Date.parse(process.env.ARK_NOW as string);
}

/** ISO instant `millisecondsAgo` before the frozen clock. */
export function isoAgo(millisecondsAgo: number): string {
  return new Date(testNow() - millisecondsAgo).toISOString();
}

/** Dated `YYYY/MM/DD` folder segments of the frozen clock's UTC day, as Codex lays out its sessions. */
export function codexDay(): [string, string, string] {
  const [year, month, day] = new Date(testNow()).toISOString().slice(0, 10).split("-");
  return [year, month, day];
}

const evidenceBodies = {
  demonstration: [
    "## What the human did\n\nOpened the page.",
    "## What the human saw\n\nThe feature.",
    "## Before\n\n- results/evidence/FAKE-T1/base/screenshots/open.png",
    "## After\n\n- results/evidence/FAKE-T1/head/screenshots/open.png\n\nhuman: ok",
  ],
  inspection: [
    "## Files\n\n- cli/a.ts:1-10",
    "## Checked against\n\nThe AC text.",
    "## Verdict\n\nThe code does it.\n\nreviewer: pass",
  ],
  analysis: ["Command", "Output", "Threshold", "Result"].map(
    (name) => `## ${name}\n\nBase: base value\nHead: head value`,
  ),
};

/** Writes a well-formed `results/evidence/<AC id>.md` for a non-test AC; `id` ends in `AC<k>`. */
export function writeEvidenceFile(
  runDirectory: string,
  id: string,
  method: keyof typeof evidenceBodies = "demonstration",
): void {
  const directory = join(runDirectory, "results", "evidence");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${id.match(/AC\d+$/)![0]}.md`),
    `${evidenceBodies[method].join("\n\n")}\n`,
  );
}

/** A workspace folder with an empty git repo at each of `repos`. A "." entry makes the workspace itself a repo. */
export function workspaceWithRepos(repos: string[]): string {
  const workspace = repos.includes(".")
    ? tempGitRepo()
    : mkdtempSync(join(tmpdir(), "ark-workspace-"));
  for (const repo of repos.filter((name) => name !== ".")) {
    mkdirSync(dirname(join(workspace, repo)), { recursive: true });
    renameSync(tempGitRepo(), join(workspace, repo));
  }
  return workspace;
}

export const clara = {
  core: "repos/shared/clara-core",
  platform: "repos/platform",
  reports: "repos/domains/reports",
};

/**
 * The 3-repo plan of ARK-336: `impl-core` in core, a bump step in platform and in reports, `validate` in platform
 * (the suite repo), and `review-core` in core. It needs `validate`, a step of another repo, but makes no repo edge.
 * Every step serves `criteria`.
 */
export function claraPlan(criteria: string[]) {
  const step = (id: string, role: string, repo: string, needs: string[]) => ({
    id,
    role,
    repo,
    harness: role === "implementer" ? "claude" : "codex",
    model: role === "implementer" ? "claude-sonnet" : "gpt-codex",
    needs,
    criteria,
  });
  const pin = "clara-core>=0.0.6rc1";
  return {
    steps: [
      step("impl-core", "implementer", clara.core, []),
      step("bump-platform", "implementer", clara.platform, ["impl-core"]),
      step("bump-reports", "implementer", clara.reports, ["impl-core", "bump-platform"]),
      step("validate", "validator", clara.platform, ["bump-platform", "bump-reports"]),
      step("review-core", "reviewer", clara.core, ["impl-core", "validate"]),
    ],
    repos: [
      { repo: clara.core, why: "holds the changed client", depends_on: [] },
      {
        repo: clara.platform,
        why: "calls clara-core",
        depends_on: [
          {
            repo: clara.core,
            kind: "package",
            pin,
            evidence: "services/tenant-manifest-service/pyproject.toml:11",
            bump: "bump-platform",
          },
        ],
      },
      {
        repo: clara.reports,
        why: "calls clara-core and the platform API",
        depends_on: [
          {
            repo: clara.core,
            kind: "package",
            pin,
            evidence: "pyproject.toml:14",
            bump: "bump-reports",
          },
          {
            repo: clara.platform,
            kind: "api",
            pin: "openapi@v3",
            evidence: "clients/platform.ts:3",
          },
        ],
      },
    ],
  };
}
