import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evalsLedger, evalsTitle } from "../skills/pr-writing/evals/ledger.ts";
import { configKeys, loadStandaloneConfig } from "../skills/pr-writing/lib/ledger.ts";
import { lintBody } from "../skills/pr-writing/lib/lint.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

const root = resolve(import.meta.dir, "..");
const skillFolder = join(root, "skills/pr-writing");
const scriptNames = ["gather", "review", "lint_body", "post_mr"];
const scriptFile = (name: string) => join(skillFolder, "scripts", `${name}.ts`);
const originalPath = process.env.PATH ?? "";

// A token made at run time, so no file of the repo holds a string a secret scanner would flag.
const githubToken = `ghp${"_"}${"0".repeat(36)}`;

const temporaryFolders: string[] = [];
afterEach(() => {
  for (const folder of temporaryFolders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function temporaryFolder(prefix: string): string {
  // realpath-free: macOS tmpdir is a symlink, but scripts only compare paths relative to the repo.
  const folder = mkdtempSync(join(tmpdir(), `pr-writing-skill-${prefix}-`));
  temporaryFolders.push(folder);
  return folder;
}

// --- fake host tools --------------------------------------------------------------------------

/** `gh`, `glab` and `curl` that record each call to `$FAKE_LOG` and exit 1: a logged call proves a host or network touch. */
function failingHostTools(folder: string): { bin: string; log: string; calls: () => string[] } {
  const bin = join(folder, "fail-bin");
  const log = join(folder, "fail-calls.log");
  mkdirSync(bin, { recursive: true });
  for (const tool of ["gh", "glab", "curl"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${log}"\nexit 1\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  return {
    bin,
    log,
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
  };
}

type FakeState = {
  /** Open MRs as the GitLab API lists them. */
  mrs: { iid: number; web_url: string; description: string; draft: boolean; sha: string }[];
  /** True: every call exits 1 with `401 Unauthorized`. */
  fail: boolean;
};

const fakeGlabSource = `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG!, JSON.stringify(argv) + "\\n");
const state = JSON.parse(readFileSync(process.env.FAKE_STATE!, "utf8"));
if (state.fail) {
  console.error("401 Unauthorized");
  process.exit(1);
}
const option = (name: string) => argv[argv.indexOf(name) + 1];
if (argv[0] === "api" && argv.at(-1) === "user") console.log(JSON.stringify({ username: "me" }));
else if (argv[0] === "api" && argv.at(-1) === "projects/:id") console.log(JSON.stringify({ default_branch: "main" }));
else if (argv[0] === "api") console.log(JSON.stringify(state.mrs));
else if (argv[0] === "mr" && argv[1] === "list") console.log(JSON.stringify(state.mrs.map(() => ({ target_branch: "main" }))));
else if (argv[0] === "mr" && argv[1] === "create") {
  const url = "https://gitlab.com/org/repo/-/merge_requests/9";
  state.mrs.push({ iid: 9, web_url: url, description: option("--description"), draft: argv.includes("--draft"), sha: "" });
  writeFileSync(process.env.FAKE_STATE!, JSON.stringify(state));
  console.log(url);
} else if (argv[0] === "mr" && argv[1] === "update") {
  for (const mr of state.mrs) if (mr.iid === Number(argv[2])) mr.description = option("--description");
  writeFileSync(process.env.FAKE_STATE!, JSON.stringify(state));
}
`;

type Run = { code: number; stdout: string; stderr: string };

function run(command: string[], options: { cwd: string; env?: Record<string, string> }): Run {
  const spawned = Bun.spawnSync(command, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: spawned.exitCode,
    stdout: spawned.stdout.toString(),
    stderr: spawned.stderr.toString(),
  };
}

function git(directory: string, ...args: string[]): string {
  const result = run(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: directory,
  });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const parseJson = (text: string) => JSON.parse(text) as Record<string, unknown>;

// --- fixture repo on a fake GitLab -------------------------------------------------------------

/**
 * A git repo on branch `fix-retry-429`, two commits ahead of `main`, with a bare local `origin` whose path holds
 * `gitlab` (so the host is GitLab) and a fake `glab` whose state the test switches by writing `state`.
 */
function gitlabRepo(config?: string) {
  const folder = temporaryFolder("repo");
  const repo = join(folder, "repo");
  const origin = join(folder, "gitlab.com/org/repo.git");
  mkdirSync(origin, { recursive: true });
  git(origin, "init", "--bare", "-b", "main");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "a.ts"), "base\n");
  if (config !== undefined) writeFileSync(join(repo, ".pr-writing.toml"), config);
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "origin", "main");
  git(repo, "checkout", "-b", "fix-retry-429");
  writeFileSync(join(repo, "a.ts"), "one\n");
  git(repo, "commit", "-am", "fix: one");
  writeFileSync(join(repo, "c.ts"), "two\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "fix: two");

  const bin = join(folder, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "glab"), fakeGlabSource);
  chmodSync(join(bin, "glab"), 0o755);
  const log = join(folder, "glab-calls.log");
  const stateFile = join(folder, "glab-state.json");
  const setState = (state: Partial<FakeState>) =>
    writeFileSync(stateFile, JSON.stringify({ mrs: [], fail: false, ...state }));
  setState({});
  const environment = {
    PATH: `${bin}:${originalPath}`,
    FAKE_LOG: log,
    FAKE_STATE: stateFile,
  };
  const script = (name: string, ...args: string[]) =>
    run(["bun", scriptFile(name), ...args], { cwd: repo, env: environment });
  const calls = (): string[][] =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const clearCalls = () => writeFileSync(log, "");
  const writes = () =>
    calls().filter((call) => call[0] === "mr" && (call[1] === "create" || call[1] === "update"));
  return {
    repo,
    origin,
    environment,
    script,
    setState,
    calls,
    clearCalls,
    writes,
    head: () => git(repo, "rev-parse", "HEAD"),
    bodyFile: join(repo, ".pr-writing", "body.md"),
    ledgerFile: join(repo, ".pr-writing", "ledger.json"),
  };
}

function nonGitFolder() {
  const folder = temporaryFolder("plain");
  const tools = failingHostTools(folder);
  const cwd = join(folder, "work");
  mkdirSync(cwd);
  const script = (name: string, ...args: string[]) =>
    run(["bun", scriptFile(name), ...args], {
      cwd,
      env: { PATH: `${tools.bin}:${originalPath}`, FAKE_LOG: tools.log },
    });
  return { script, calls: tools.calls };
}

test("ARK-T68 ARK-317/AC2 --help prints usage prose on stderr only, with examples and exit codes, outside any repo", () => {
  const { script, calls } = nonGitFolder();
  for (const name of scriptNames) {
    const result = script(name, "--help");
    expect(result.code, name).toBe(0);
    expect(result.stdout, name).toBe("");
    expect(result.stderr, name).toContain(`${name}.ts`);
    expect(result.stderr, name).toMatch(
      new RegExp(`^\\s*bun skills/pr-writing/scripts/${name}\\.ts`, "m"),
    );
    for (const code of ["0", "1", "2"])
      expect(result.stderr, name).toMatch(new RegExp(`^\\s*${code}\\s+\\S`, "m"));
  }
  expect(calls()).toEqual([]);
});

test("ARK-T68 ARK-317/AC2 --json-schema prints one JSON schema on stdout and nothing on stderr, outside any repo", () => {
  const { script, calls } = nonGitFolder();
  for (const name of scriptNames) {
    const result = script(name, "--json-schema");
    expect(result.code, name).toBe(0);
    expect(result.stderr, name).toBe("");
    const schema = parseJson(result.stdout);
    expect(schema.$schema, name).toBeString();
    expect(schema.type, name).toBe("object");
  }
  expect(calls()).toEqual([]);
});

test("ARK-T68 ARK-317/AC2 a bad argument exits 1 with a JSON error on stdout and prose naming --help on stderr", () => {
  const { script, calls } = nonGitFolder();
  for (const name of scriptNames) {
    const result = script(name, "--bogus");
    expect(result.code, name).toBe(1);
    expect(parseJson(result.stdout).error, name).toContain("--bogus");
    expect(result.stderr, name).toContain("--help");
    expect(result.stderr, name).not.toMatch(/\n\s+at /);
  }
  expect(calls()).toEqual([]);
});

const checksConfig = (...checks: string[]) =>
  `checks = [${checks.map((check) => `'${check}'`).join(", ")}]\n`;

/** A shell command that prints `count` lines `line 1` .. `line <count>` and exits with `exitCode`. */
const printLines = (count: number, exitCode = 0) =>
  `for i in $(seq 1 ${count}); do echo "line $i"; done; exit ${exitCode}`;

/** Every file under `directory` except `.git`, with its hash. */
function snapshot(directory: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  const visit = (current: string) => {
    for (const entry of readdirSync(current)) {
      if (entry === ".git") continue;
      const path = join(current, entry);
      if (statSync(path).isDirectory()) visit(path);
      else
        hashes[path.slice(directory.length)] = createHash("sha256")
          .update(readFileSync(path))
          .digest("hex");
    }
  };
  visit(directory);
  return hashes;
}

type CheckRecord = {
  command: string;
  status: string;
  exit_code: number | null;
  output_tail: string[];
};

test("ARK-T69 ARK-317/AC3 gather writes the ledger from git and the host with no Ark run, and prints one JSON document", () => {
  const fixture = gitlabRepo();
  const result = fixture.script("gather");
  expect(result.code).toBe(0);
  const output = parseJson(result.stdout);
  expect(Object.keys(output).sort()).toEqual(
    ["base", "existing_mr", "files", "head", "host", "ledger"].sort(),
  );
  expect(output).toMatchObject({
    ledger: ".pr-writing/ledger.json",
    head: fixture.head(),
    base: "main",
    host: "gitlab",
    files: 2,
    existing_mr: null,
  });
  const file = JSON.parse(readFileSync(fixture.ledgerFile, "utf8"));
  expect(file.ledger.source).toBe("git");
  expect(file.ledger.repos[0].head).toBe(fixture.head());
  expect(file.ledger.repos[0].base).toBe("main");
  expect(file.ledger.repos[0].commits).toHaveLength(2);
  expect(JSON.stringify(file.ledger.repos[0].files)).toContain("c.ts");
});

test("ARK-T69 ARK-317/AC3 gather --run-dir takes the Ark ledger of the run, not the git-only one", () => {
  const fixture = gitlabRepo();
  const arkHome = temporaryFolder("home");
  const runFolder = join(temporaryFolder("run"), "run");
  mkdirSync(join(runFolder, "findings"), { recursive: true });
  mkdirSync(join(runFolder, "results/evidence/ARK-T1/head"), { recursive: true });
  mkdirSync(join(runFolder, "results/evidence/ARK-T1/base"), { recursive: true });
  for (const side of ["base", "head"])
    writeFileSync(
      join(runFolder, `results/evidence/ARK-T1/${side}/result.json`),
      JSON.stringify({ case: "ARK-T1", status: side === "base" ? "fail" : "pass", sha: "abc1234" }),
    );
  writeFileSync(
    join(runFolder, "findings/review.md"),
    "Reviewed head: abc\n\n### P2: retry loop has no cap\n\n- **File:** `a.ts`\n",
  );
  writeFileSync(
    join(runFolder, "ticket.md"),
    `---\n${JSON.stringify({
      id: "ARK-9",
      title: "Retry on 429",
      kind: "bugfix",
      acceptance_criteria: [
        { id: "AC1", text: "Retries.", method: "test", verified_by: ["ARK-T1"] },
      ],
    })}\n---\n## Problem\n\nA 429 fails the call.\n\n## Change\n\n1. Retry.\n`,
  );
  const events = [
    {
      type: "run.started",
      data: {
        run: "run",
        project: "demo",
        ticket: { id: "ARK-9", title: "Retry on 429" },
        kind: "bugfix",
        criteria: ["AC1"],
        criteria_gate: true,
      },
    },
    {
      type: "worktree.created",
      data: { repo: ".", path: fixture.repo, branch: "fix-retry-429", base: "main" },
    },
    {
      type: "test.completed",
      data: { passed: true, heads: { ".": fixture.head() }, criteria: { AC1: "passing" } },
    },
  ];
  writeFileSync(
    join(runFolder, "events.ndjson"),
    `${events
      .map((event, i) => JSON.stringify({ seq: i + 1, time: "2026-11-06T10:05:00.000Z", ...event }))
      .join("\n")}\n`,
  );

  const result = run(["bun", scriptFile("gather"), "--run-dir", runFolder], {
    cwd: fixture.repo,
    env: { ...fixture.environment, ARK_HOME: arkHome },
  });
  expect(result.code, result.stderr).toBe(0);
  const { ledger } = JSON.parse(readFileSync(fixture.ledgerFile, "utf8"));
  expect(ledger.source).toBe("run");
  expect(ledger.ticket.id).toBe("ARK-9");
  expect(JSON.stringify(ledger.evidence)).toContain("ARK-T1");
  expect(ledger.findings.map((finding: { title: string }) => finding.title)).toEqual([
    "retry loop has no cap",
  ]);
});

test("ARK-T69 ARK-317/AC3 gather --existing-only prints the open MR, or nothing, and exits 2 with no file written when the probe fails", () => {
  const fixture = gitlabRepo();
  const open = {
    iid: 412,
    web_url: "https://gitlab.com/org/repo/-/merge_requests/412",
    description: "text",
    draft: true,
    sha: fixture.head(),
  };

  fixture.setState({ mrs: [open] });
  const found = fixture.script("gather", "--existing-only");
  expect(found.code).toBe(0);
  expect(parseJson(found.stdout)).toMatchObject({ iid: 412, draft: true, head: open.sha });

  fixture.setState({});
  const none = fixture.script("gather", "--existing-only");
  expect(none.code).toBe(0);
  expect(none.stdout).toBe("");
  expect(none.stderr).toContain("no open MR");

  fixture.setState({ fail: true });
  const failed = fixture.script("gather", "--existing-only");
  expect(failed.code).toBe(2);
  expect(parseJson(failed.stdout).error).toBe("probe failed");
  // None of the three runs wrote a ledger.
  expect(existsSync(join(fixture.repo, ".pr-writing"))).toBe(false);

  // A probe failure leaves an existing ledger byte for byte as it was.
  fixture.setState({});
  expect(fixture.script("gather").code).toBe(0);
  const before = readFileSync(fixture.ledgerFile, "utf8");
  fixture.setState({ fail: true });
  expect(fixture.script("gather", "--existing-only").code).toBe(2);
  expect(readFileSync(fixture.ledgerFile, "utf8")).toBe(before);
});

test("ARK-T69 ARK-317/AC3 a normal gather exits 2 with a probe-failed JSON when the host refuses, and keeps the ledger", () => {
  const fixture = gitlabRepo();
  fixture.setState({ fail: true });
  const result = fixture.script("gather", "--base", "main");
  expect(result.code).toBe(2);
  const output = parseJson(result.stdout);
  expect(output.error).toBe("probe failed");
  expect(output).not.toHaveProperty("existing_mr");
  expect(result.stderr).toContain("401 Unauthorized");
  expect(existsSync(fixture.ledgerFile)).toBe(true);

  // An absent MR is still exit 0 with existing_mr null.
  fixture.setState({});
  const none = fixture.script("gather", "--base", "main");
  expect(none.code).toBe(0);
  expect(parseJson(none.stdout).existing_mr).toBeNull();
});

test("ARK-T69 ARK-317/AC3 review exits 2 with ok false when no check failed and one is not_run", () => {
  const fixture = gitlabRepo(checksConfig("true", "no-such-tool-xyz --version"));
  const result = fixture.script("review");
  expect(result.code).toBe(2);
  const output = parseJson(result.stdout) as { ok: boolean; checks: CheckRecord[] };
  expect(output.ok).toBe(false);
  expect(output.checks.map((check) => check.status)).toEqual(["pass", "not_run"]);
});

test("ARK-T69 ARK-317/AC3 review records pass, fail with the last 50 lines and not_run in order, and changes no file", () => {
  const fixture = gitlabRepo(
    checksConfig("true", printLines(120, 1), "no-such-tool-xyz --version"),
  );
  const before = snapshot(fixture.repo);
  const result = fixture.script("review");
  expect(result.code).toBe(1);
  const output = parseJson(result.stdout) as { ok: boolean; checks: CheckRecord[] };
  expect(output.ok).toBe(false);
  const [pass, fail, notRun] = output.checks;
  expect(output.checks.map((check) => check.status)).toEqual(["pass", "fail", "not_run"]);
  expect(pass).toMatchObject({ command: "true", exit_code: 0 });
  expect(fail.command).toBe(printLines(120, 1));
  expect(fail.exit_code).toBe(1);
  expect(fail.output_tail).toHaveLength(50);
  expect(fail.output_tail.at(-1)).toBe("line 120");
  expect(notRun.command).toBe("no-such-tool-xyz --version");
  expect(notRun.exit_code).toBeNull();
  expect(notRun.output_tail.join("\n")).toContain("no-such-tool-xyz");
  expect(snapshot(fixture.repo)).toEqual(before);
  expect(git(fixture.repo, "status", "--porcelain")).toBe("");
});

test.each([
  [49, 49],
  [50, 50],
  [51, 50],
])("ARK-T69 ARK-317/AC3 review keeps %d lines of output as a tail of %d lines", (printed, kept) => {
  const fixture = gitlabRepo(checksConfig(printLines(printed)));
  const output = parseJson(fixture.script("review").stdout) as { checks: CheckRecord[] };
  expect(output.checks[0].output_tail).toHaveLength(kept);
  expect(output.checks[0].output_tail.at(-1)).toBe(`line ${printed}`);
});

test("ARK-T69 ARK-317/AC3 review exits 0 with ok true when every check passes", () => {
  const fixture = gitlabRepo(checksConfig("true", printLines(3), "echo done"));
  const result = fixture.script("review");
  expect(result.code).toBe(0);
  expect(parseJson(result.stdout).ok).toBe(true);
});

// --- ARK-T70 -----------------------------------------------------------------------------------

const fullConfig = `reviewers = ["ana", "bo"]
tier_floor = 2
sensitive_paths = ["db/**"]
agent_authored = true
title_prefix = "feat(TICKET): desc"
checks = ["true"]
`;

function configFolder(content?: string): string {
  const folder = temporaryFolder("config");
  if (content !== undefined) writeFileSync(join(folder, ".pr-writing.toml"), content);
  return folder;
}

test("ARK-T70 ARK-317/AC4 .pr-writing.toml gives each of the six keys with its type", () => {
  const config = loadStandaloneConfig(configFolder(fullConfig), {});
  expect(config.reviewers).toEqual(["ana", "bo"]);
  expect(config.tier_floor).toBe(2);
  expect(config.sensitive_paths).toEqual(["db/**"]);
  expect(config.agent_authored).toBe(true);
  expect(config.title_prefix).toBe("feat(TICKET): desc");
  expect(config.checks).toEqual(["true"]);
});

test("ARK-T70 ARK-317/AC4 PR_WRITING_<KEY> overrides the file with typed values and leaves other keys alone", () => {
  const config = loadStandaloneConfig(configFolder(fullConfig), {
    PR_WRITING_REVIEWERS: "cy,di",
    PR_WRITING_AGENT_AUTHORED: "false",
    PR_WRITING_TITLE_PREFIX: "fix(TICKET): desc",
    PR_WRITING_TIER_FLOOR: "3",
  });
  expect(config.reviewers).toEqual(["cy", "di"]);
  expect(config.agent_authored).toBe(false);
  expect(config.title_prefix).toBe("fix(TICKET): desc");
  expect(config.tier_floor).toBe(3);
  expect(config.sensitive_paths).toEqual(["db/**"]);
  expect(config.checks).toEqual(["true"]);
});

test("ARK-T70 ARK-317/AC4 an environment value applies with no file present and other keys take defaults", () => {
  const config = loadStandaloneConfig(configFolder(), { PR_WRITING_REVIEWERS: "cy" });
  expect(config.reviewers).toEqual(["cy"]);
  expect(config.tier_floor).toBe(0);
  expect(config.agent_authored).toBe(true);
  expect(config.checks).toEqual([]);
});

test.each([
  ["PR_WRITING_AGENT_AUTHORED", "maybe"],
  ["PR_WRITING_TIER_FLOOR", "high"],
  ["PR_WRITING_TIER_FLOOR", "4"],
])("ARK-T70 ARK-317/AC4 %s=%s is refused naming the variable", (name, value) => {
  expect(() => loadStandaloneConfig(configFolder(fullConfig), { [name]: value })).toThrow(name);
});

test("ARK-T70 ARK-317/AC4 review exits 1 on a bad environment value and runs no check", () => {
  const folder = configFolder('checks = ["touch ran.marker"]\n');
  const result = run(["bun", scriptFile("review")], {
    cwd: folder,
    env: { PR_WRITING_AGENT_AUTHORED: "maybe" },
  });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("PR_WRITING_AGENT_AUTHORED");
  expect(existsSync(join(folder, "ran.marker"))).toBe(false);
});

test.each([
  ["tier_floor = 0", 0],
  ["tier_floor = 3", 3],
])("ARK-T70 ARK-317/AC4 the file value %s loads as the number %d", (line, expected) => {
  expect(loadStandaloneConfig(configFolder(`${line}\n`), {}).tier_floor).toBe(expected);
});

test.each(["tier_floor = 4", 'tier_floor = "T2"'])(
  "ARK-T70 ARK-317/AC4 the file value %s is refused",
  (line) => {
    expect(() => loadStandaloneConfig(configFolder(`${line}\n`), {})).toThrow("tier_floor");
  },
);

test("ARK-T70 ARK-317/AC4 review refuses a misspelled key, names the valid keys and runs no check", () => {
  const folder = configFolder('reviewrs = ["ana"]\nchecks = ["touch ran.marker"]\n');
  const result = run(["bun", scriptFile("review")], { cwd: folder });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('unknown key "reviewrs"');
  expect(result.stderr).toContain(configKeys.join(", "));
  expect(parseJson(result.stdout)).toEqual({ error: "bad config key", key: "reviewrs" });
  expect(existsSync(join(folder, "ran.marker"))).toBe(false);
});

test("ARK-T70 ARK-317/AC4 the repo's own .pr-writing.toml parses with valid keys only and loads", () => {
  const parsed = Bun.TOML.parse(readFileSync(join(root, ".pr-writing.toml"), "utf8"));
  expect(Object.keys(parsed).length).toBeGreaterThan(0);
  for (const key of Object.keys(parsed)) expect(configKeys as readonly string[]).toContain(key);
  expect(Object.keys(parsed)).toContain("checks");
  expect(loadStandaloneConfig(root, {}).checks.length).toBeGreaterThan(0);
});

// --- ARK-T71 -----------------------------------------------------------------------------------

const title = "Fix retry on 429";

const failedChecks = (output: Record<string, unknown>) =>
  output.checks as { id: string; result: string; reason: string }[];

/** Gathers and lints the generated body, as the skill does before it asks the human. */
function gatheredRepo() {
  const fixture = gitlabRepo();
  expect(fixture.script("gather").code).toBe(0);
  const lint = () => fixture.script("lint_body", "--title", title);
  expect(lint().code).toBe(0);
  fixture.clearCalls();
  return {
    ...fixture,
    lint,
    generated: () => readFileSync(fixture.bodyFile, "utf8"),
    post: (...flags: string[]) => fixture.script("post_mr", "--title", title, ...flags),
    openMr: (description: string) =>
      fixture.setState({
        mrs: [
          {
            iid: 412,
            web_url: "https://gitlab.com/org/repo/-/merge_requests/412",
            description,
            draft: true,
            sha: fixture.head(),
          },
        ],
      }),
    description: () =>
      (JSON.parse(readFileSync(fixture.environment.FAKE_STATE, "utf8")) as FakeState).mrs[0]
        .description,
  };
}

test("ARK-T71 ARK-317/AC5 post_mr without --confirmed refuses, lints nothing and calls no host command", () => {
  const fixture = gatheredRepo();
  const bad = join(fixture.repo, "bad.md");
  writeFileSync(bad, "Self-review completed.\n");
  for (const flags of [[], ["--body", bad]]) {
    const result = fixture.post(...flags);
    expect(result.code).toBe(1);
    expect(result.stdout.trim()).toBe('{"refused":"no --confirmed","posted":false}');
    expect(result.stderr).toContain("--confirmed");
  }
  expect(fixture.calls()).toEqual([]);
});

test("ARK-T71 ARK-317/AC5 post_mr --confirmed refuses a body that fails lint and writes nothing to the host", () => {
  const fixture = gatheredRepo();
  const bad = join(fixture.repo, "bad.md");
  // The verify item is a bare claim: no `- [ ]` item with a command.
  writeFileSync(bad, fixture.generated().replace(/^- \[ \] .*$/m, "- Self-review completed"));
  const result = fixture.post("--confirmed", "--body", bad);
  expect(result.code).toBe(1);
  const output = parseJson(result.stdout);
  expect(output).toMatchObject({ refused: "lint fail", posted: false });
  expect(failedChecks(output).map((check) => check.id)).toContain("VAL01");
  expect(fixture.writes()).toEqual([]);
});

test("ARK-T71 ARK-317/AC5 post_mr refuses with STALE01 on a new commit, then succeeds after gather and lint", () => {
  const fixture = gatheredRepo();
  const ledgerHead = fixture.head();
  writeFileSync(join(fixture.repo, "d.ts"), "three\n");
  git(fixture.repo, "add", ".");
  git(fixture.repo, "commit", "-m", "fix: three");
  const currentHead = fixture.head();

  const refused = fixture.post("--confirmed");
  expect(refused.code).toBe(1);
  const stale = failedChecks(parseJson(refused.stdout)).find((check) => check.id === "STALE01");
  expect(stale?.result).toBe("fail");
  expect(stale?.reason).toContain(ledgerHead.slice(0, 7));
  expect(stale?.reason).toContain(currentHead.slice(0, 7));
  expect(fixture.writes()).toEqual([]);
  expect(git(fixture.origin, "branch", "--list", "fix-retry-429")).toBe("");

  // Gather and lint again: the same post now goes through, as a Draft.
  rmSync(fixture.bodyFile);
  expect(fixture.script("gather").code).toBe(0);
  expect(fixture.lint().code).toBe(0);
  const created = fixture.post("--confirmed");
  expect(created.code, created.stderr).toBe(0);
  expect(parseJson(created.stdout)).toMatchObject({ action: "created", draft: true });
});

test("ARK-T71 ARK-317/AC5 post_mr creates a Draft by default and a ready MR with --ready", () => {
  for (const [flags, draft] of [
    [["--confirmed"], true],
    [["--confirmed", "--ready"], false],
  ] as const) {
    const fixture = gatheredRepo();
    const result = fixture.post(...flags);
    expect(result.code, result.stderr).toBe(0);
    const output = parseJson(result.stdout);
    expect(output).toMatchObject({ action: "created", draft });
    expect(output.url).toBeString();
    const [create, ...more] = fixture.writes();
    expect(more).toEqual([]);
    expect(create.slice(0, 2)).toEqual(["mr", "create"]);
    expect(create.includes("--draft")).toBe(draft);
  }
});

test("ARK-T71 ARK-317/AC5 post_mr updates only the text between the markers of an open Draft MR", () => {
  const fixture = gatheredRepo();
  const before = "- [x] Tested by hand\n\n";
  const after = "\n\n- Human footer\n";
  fixture.openMr(`${before}${fixture.generated().trimEnd()}${after}`);
  const edited = fixture.generated().replace("- Nothing open.", "- Nothing open. Edited.");
  expect(edited).not.toBe(fixture.generated());
  writeFileSync(fixture.bodyFile, edited);
  expect(fixture.lint().code).toBe(0);

  const result = fixture.post("--confirmed");
  expect(result.code, result.stderr).toBe(0);
  expect(parseJson(result.stdout)).toMatchObject({ action: "updated", draft: true });
  const [update, ...more] = fixture.writes();
  expect(more).toEqual([]);
  expect(update.slice(0, 3)).toEqual(["mr", "update", "412"]);
  expect(fixture.description()).toBe(`${before}${edited.trimEnd()}${after}`);
});

test("ARK-T71 ARK-317/AC5 post_mr refuses with STALE01 when the body changed after lint_body ran", () => {
  const fixture = gatheredRepo();
  writeFileSync(
    fixture.bodyFile,
    fixture.generated().replace("- Nothing open.", "- Nothing open. Edited."),
  );
  const result = fixture.post("--confirmed");
  expect(result.code).toBe(1);
  const stale = failedChecks(parseJson(result.stdout)).find((check) => check.id === "STALE01");
  expect(stale?.result).toBe("fail");
  expect(stale?.reason.toLowerCase()).toContain("hash");
  expect(fixture.writes()).toEqual([]);
});

test("ARK-T71 ARK-317/AC5 post_mr exits 2 with not authenticated when the host refuses the token", () => {
  const fixture = gatheredRepo();
  fixture.setState({ fail: true });
  const result = fixture.post("--confirmed");
  expect(result.code).toBe(2);
  expect(parseJson(result.stdout)).toMatchObject({ error: "not authenticated", posted: false });
  expect(fixture.writes()).toEqual([]);
});

test("ARK-T71 ARK-317/AC5 post_mr lints the final merged body: a token a person pasted outside the markers refuses the post", () => {
  const fixture = gatheredRepo();
  const pasted = `Pasted by hand: ${githubToken}\n\n${fixture.generated().trimEnd()}\n`;
  fixture.openMr(pasted);
  const result = fixture.post("--confirmed");
  expect(result.code).toBe(1);
  const output = parseJson(result.stdout);
  expect(output).toMatchObject({ refused: "lint fail", posted: false });
  const leak = failedChecks(output).find((check) => check.id === "FMT02");
  expect(leak?.result).toBe("fail");
  expect(fixture.writes()).toEqual([]);
  expect(fixture.description()).toBe(pasted);
});

// --- ARK-T72 -----------------------------------------------------------------------------------

test("ARK-T72 ARK-317/AC6 run_evals lints the three frozen bodies offline, prints per-check failure rates and the rubric", () => {
  const folder = temporaryFolder("evals");
  const tools = failingHostTools(folder);
  const evalsFolder = join(skillFolder, "evals");
  const fixtureFiles = ["pr-121.md", "pr-117.md", "pr-109.md"].map((name) =>
    join(evalsFolder, name),
  );
  const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const before = fixtureFiles.map(hash);

  const result = run(["bun", join(evalsFolder, "run_evals.ts")], {
    cwd: folder,
    env: { PATH: `${tools.bin}:${originalPath}`, FAKE_LOG: tools.log },
  });
  expect(result.code, result.stderr).toBe(0);
  expect(tools.calls()).toEqual([]);

  const output = parseJson(result.stdout) as {
    bodies: string[];
    checks: { id: string; failed: number; total: number; rate: number }[];
    rubric: string[];
  };
  expect(output.bodies).toEqual(["#121", "#117", "#109"]);

  // The cross-check: lint each body directly and count the fails of each check id.
  const linted = fixtureFiles.map((file) =>
    lintBody({ body: readFileSync(file, "utf8"), title: evalsTitle, ledger: evalsLedger }),
  );
  expect(output.checks.length).toBeGreaterThan(0);
  for (const check of output.checks) {
    const failed = linted.filter((results) =>
      results.some((entry) => entry.id === check.id && entry.result === "fail"),
    ).length;
    expect(check, check.id).toEqual({ id: check.id, failed, total: 3, rate: failed / 3 });
  }
  expect(output.checks.some((check) => check.failed > 0)).toBe(true);

  expect(output.rubric).toHaveLength(6);
  expect(result.stderr).toContain(readFileSync(join(evalsFolder, "rubric.md"), "utf8"));
  expect(fixtureFiles.map(hash)).toEqual(before);
});
