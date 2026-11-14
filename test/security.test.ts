import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ark, tempArkHome, tempGitRepo, writeProject, writeTicket } from "./helpers";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(60_000);

// The integration tests of ARK-380: the real `ark merge-request open`, `ark run close <run> handed_off` and `ark status`
// against the fake host of fixtures/merge-request and the emulated gitleaks and osv-scanner of fixtures/security.
// The fake gitleaks reports each added `FAKE-SECRET <rule>` line of the commit range it is given. The fake osv-scanner
// answers by the sha1 of the lockfile's bytes, so a base lockfile and a head lockfile can differ.

const hostFixtures = resolve(import.meta.dir, "fixtures/merge-request");
const scannerFixtures = resolve(import.meta.dir, "fixtures/security");
const run = "2026-10-29-ARK-900-1";
const sentinel = "SENTINEL-SECRET-VALUE-4242";
const overrides = [
  "FAKE_GITLEAKS_EXIT",
  "FAKE_GITLEAKS_STDERR",
  "FAKE_GITLEAKS_REPORT",
  "FAKE_OSV_EXIT",
  "FAKE_OSV_STDERR",
  "FAKE_OSV_STDOUT",
];
const outerPath = process.env.PATH;

let logFile = "";
let scanLog = "";
let osvDirectory = "";

beforeEach(() => {
  const folder = mkdtempSync(join(tmpdir(), "ark-security-fakes-"));
  logFile = join(folder, "calls.ndjson");
  scanLog = join(folder, "scans.log");
  osvDirectory = join(folder, "osv");
  mkdirSync(osvDirectory);
  writeFileSync(scanLog, "");
  Object.assign(process.env, {
    FAKE_LOG: logFile,
    FAKE_SCAN_LOG: scanLog,
    FAKE_OSV_DIR: osvDirectory,
  });
  process.env.PATH = `${scannerFixtures}:${hostFixtures}:${outerPath}`;
});

afterEach(() => {
  process.env.PATH = outerPath;
  for (const name of overrides) delete process.env[name];
});

type LoggedCall = { tool: string; cwd: string; argv: string[]; body?: string };

function calls(): LoggedCall[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const created = () => calls().filter((call) => call.argv.includes("create"));
const edited = () =>
  calls().filter((call) => call.argv.includes("edit") || call.argv.includes("update"));
const bodyOf = (call: LoggedCall | undefined) => call?.body ?? "";

function git(directory: string, ...args: string[]): string {
  const result = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=Ark Test",
      "-c",
      "user.email=ark@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: directory, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** Commits `files` and returns the full id of the new commit. */
function commitFiles(worktree: string, files: Record<string, string>, message: string): string {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(worktree, name)), { recursive: true });
    writeFileSync(join(worktree, name), content);
  }
  git(worktree, "add", "-A");
  git(worktree, "commit", "-m", message);
  return git(worktree, "rev-parse", "HEAD");
}

/** A source file whose `line`-th line is the marker the fake gitleaks reports as a leak of `rule`. */
const markerFile = (rule: string, line = 12) =>
  `${Array.from({ length: line - 1 }, (_, i) => `// filler ${i + 1}`).join("\n")}\nFAKE-SECRET ${rule}\n`;

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");
const lockfileText = (label: string) => `{"lockfileVersion":1,"label":"${label}"}\n`;

type Vulnerability = { id: string; severity?: string; aliases?: string[] };
type PackageEntry = {
  name: string;
  version: string;
  licenses?: string[];
  vulnerabilities?: Vulnerability[];
};

function writeOsvReport(key: string, packages: PackageEntry[]) {
  const report = {
    results: [
      {
        source: { path: "lockfile", type: "lockfile" },
        packages: packages.map((entry) => ({
          package: { name: entry.name, version: entry.version, ecosystem: "npm" },
          licenses: entry.licenses,
          vulnerabilities: entry.vulnerabilities?.map((vulnerability) => ({
            id: vulnerability.id,
            aliases: vulnerability.aliases ?? [],
            database_specific: { severity: vulnerability.severity },
          })),
        })),
      },
    ],
  };
  writeFileSync(join(osvDirectory, `${key}.json`), JSON.stringify(report));
}

/** What the fake osv-scanner prints for a lockfile with exactly this text. */
const osvReports = (lockfile: string, packages: PackageEntry[]) =>
  writeOsvReport(sha1(lockfile), packages);

const criticalLeftPad: PackageEntry = {
  name: "left-pad",
  version: "1.3.0",
  vulnerabilities: [
    { id: "GHSA-aaaa-bbbb-cccc", severity: "CRITICAL", aliases: ["CVE-2026-0001"] },
  ],
};
const highLodash: PackageEntry = {
  name: "lodash",
  version: "4.17.0",
  vulnerabilities: [{ id: "GHSA-dddd-eeee-ffff", severity: "HIGH" }],
};

type Repository = { name: string; worktree: string; source: string; bare: string };
type Setup = {
  names?: string[];
  baseFiles?: Record<string, string>;
  /** The commits of the run branch in one repo. Default: one clean commit. */
  commits?: (repository: Repository) => void;
  config?: Record<string, unknown>;
  /** The base recorded in `worktree.created`. Default: `main`. */
  base?: string;
};

const projectConfig = (workspace: string, extra: Record<string, unknown> = {}) => ({
  workspace,
  ticket_source: "local",
  suites: [{ name: "e2e", level: "e2e", repo: ".", command: "true {report}", parser: "bun" }],
  pr_writing: { tier_floor: 1 },
  roles: {
    implementer: { harness: "claude", model: "claude-sonnet" },
    validator: { harness: "codex", model: "gpt-codex" },
    reviewer: { harness: "codex", model: "gpt-codex" },
  },
  ...extra,
});

const appendEvent = (runDirectory: string, type: string, data: Record<string, unknown>) => {
  const file = join(runDirectory, "events.ndjson");
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  lines.push(
    JSON.stringify({ seq: lines.length + 1, time: "2026-10-29T00:00:00.000Z", type, data }),
  );
  writeFileSync(file, `${lines.join("\n")}\n`);
};

/** Records a passing test of the heads the worktrees are at now, as `ark test` does after a new commit. */
function retest(runDirectory: string, repositories: Repository[]) {
  appendEvent(runDirectory, "test.completed", {
    passed: true,
    heads: Object.fromEntries(
      repositories.map(({ name, worktree }) => [
        `repos/${name}`,
        git(worktree, "rev-parse", "HEAD"),
      ]),
    ),
    suites: [{ name: "e2e", level: "e2e", passed: true }],
    criteria: { "ARK-900-AC1": "passing", "ARK-900-AC2": "passing" },
  });
}

/** A run at the point where `ark merge-request open` accepts it: plan approved, a passing test at every head. */
function setup(options: Setup = {}) {
  const { names = ["core"], baseFiles, commits, config = {}, base = "main" } = options;
  tempArkHome();
  // each setup is a new run on a fresh fake host
  rmSync(`${logFile}.state`, { force: true });
  writeFileSync(logFile, "");
  const workspace = mkdtempSync(join(tmpdir(), "ark-workspace-"));
  const projectDirectory = writeProject("demo", projectConfig(workspace, config));
  const ticketFile = writeTicket(
    "demo",
    "ARK-900",
    [
      { id: "ARK-900-AC1", text: "Core exports units" },
      { id: "ARK-900-AC2", text: "App shows units" },
    ],
    "Show units",
  );
  const runDirectory = join(projectDirectory, "runs", run);
  mkdirSync(runDirectory, { recursive: true });
  copyFileSync(ticketFile, join(runDirectory, "ticket.md"));
  const steps = names.map((name, i) => ({
    id: `${name}-impl`,
    role: "implementer",
    repo: `repos/${name}`,
    harness: "claude",
    model: "claude-sonnet",
    needs: [],
    criteria: i < 2 ? [`ARK-900-AC${i + 1}`] : [],
  }));
  writeFileSync(
    join(runDirectory, "plan.yml"),
    JSON.stringify({
      steps,
      repos: names.map((name) => ({ repo: `repos/${name}`, why: name, depends_on: [] })),
      test_cases: [],
    }),
  );
  const events: { type: string; data: Record<string, unknown> }[] = [
    {
      type: "run.started",
      data: {
        run,
        project: "demo",
        round_budget: 2,
        ticket: { id: "ARK-900", title: "Show units" },
        criteria: ["ARK-900-AC1", "ARK-900-AC2"],
        ticket_file: ticketFile,
      },
    },
    { type: "plan.checked", data: { valid: true, problems: [], plan_hash: "hash", steps } },
    { type: "gate.answered", data: { gate: "plan", answer: "approve" } },
  ];
  const repositories: Repository[] = [];
  for (const name of names) {
    const source = join(workspace, "repos", name);
    mkdirSync(join(workspace, "repos"), { recursive: true });
    renameSync(tempGitRepo(baseFiles), source);
    // A local bare repo whose path names the host: `git push` works offline and `remote get-url` reads as GitHub.
    const bare = join(
      mkdtempSync(join(tmpdir(), "ark-origin-")),
      "github.com",
      "org",
      `${name}.git`,
    );
    mkdirSync(bare, { recursive: true });
    git(bare, "init", "--bare");
    git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
    git(source, "remote", "add", "origin", bare);
    git(source, "push", "origin", "main");
    git(source, "remote", "set-head", "origin", "main");
    const worktree = join(mkdtempSync(join(tmpdir(), "ark-worktree-")), name);
    git(source, "worktree", "add", "-b", `ark/${run}`, worktree, "main");
    const repository = { name, worktree, source, bare };
    if (commits) commits(repository);
    else commitFiles(worktree, { [`${name}.txt`]: name }, name);
    repositories.push(repository);
    events.push({
      type: "worktree.created",
      data: { repo: `repos/${name}`, path: worktree, branch: `ark/${run}`, base },
    });
  }
  events.push({
    type: "test.completed",
    data: {
      passed: true,
      heads: Object.fromEntries(
        repositories.map(({ name, worktree }) => [
          `repos/${name}`,
          git(worktree, "rev-parse", "HEAD"),
        ]),
      ),
      suites: [{ name: "e2e", level: "e2e", passed: true }],
      criteria: { "ARK-900-AC1": "passing", "ARK-900-AC2": "passing" },
    },
  });
  writeFileSync(
    join(runDirectory, "events.ndjson"),
    `${events
      .map((event, i) => JSON.stringify({ seq: i + 1, time: "2026-10-29T00:00:00.000Z", ...event }))
      .join("\n")}\n`,
  );
  return { runDirectory, workspace, repositories, core: repositories[0] };
}

const openMergeRequest = () => ark("merge-request", "open", run);
const said = (result: { out: string; err: string }) => `${result.out}${result.err}`;
const branchTip = (repository: Repository) =>
  Bun.spawnSync(["git", "rev-parse", "--verify", `refs/heads/ark/${run}`], {
    cwd: repository.bare,
    stdout: "pipe",
    stderr: "pipe",
  })
    .stdout.toString()
    .trim();
const eventTypes = (runDirectory: string) =>
  readFileSync(join(runDirectory, "events.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).type as string);

/** The text under `## <title>` up to the next `##` heading, or "" when there is none. */
function section(body: string, title: string): string {
  const lines = body.split("\n");
  const start = lines.indexOf(`## ${title}`);
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

const rowWith = (text: string, needle: string) =>
  text.split("\n").find((line) => line.includes(needle)) ?? "";
const securityHeading = /^(## Security|\*\*Security\*\*)/m;

/** Refused: nothing pushed, nothing posted. */
function expectNothingShipped(repositories: Repository[]) {
  for (const repository of repositories) expect(branchTip(repository)).toBe("");
  expect(created()).toHaveLength(0);
}

// ---------------------------------------------------------------------------------------------------------------------
// ARK-T401: secrets
// ---------------------------------------------------------------------------------------------------------------------

test("ARK-T401 merge-request open refuses a secret in a run commit, names rule, file, line and commit, and ships nothing", () => {
  let commit = "";
  const { runDirectory, repositories } = setup({
    commits: ({ worktree }) => {
      commitFiles(worktree, { "core.txt": "core" }, "core");
      commit = commitFiles(worktree, { "src/config.ts": markerFile("generic-api-key") }, "config");
    },
  });
  const result = openMergeRequest();
  expect(result.code).not.toBe(0);
  const text = said(result);
  expect(text).toContain(`generic-api-key in src/config.ts:12 (commit ${commit.slice(0, 8)})`);
  expect(text).not.toContain(sentinel);
  expectNothingShipped(repositories);
  expect(eventTypes(runDirectory)).not.toContain("merge_request.opened");
});

test("ARK-T401 merge-request check --stage final prints the same secret refusal that open gives", () => {
  const dirty = setup({
    commits: ({ worktree }) => {
      commitFiles(worktree, { "src/config.ts": markerFile("generic-api-key") }, "config");
    },
  });
  const check = ark("merge-request", "check", run, "--stage", "final");
  expect(check.code).toBe(1);
  expect(said(check)).toContain("generic-api-key in src/config.ts:12");
  expect(said(check)).not.toContain(sentinel);
  expect(said(openMergeRequest())).toContain("generic-api-key in src/config.ts:12");
  expectNothingShipped(dirty.repositories);
});

test("ARK-T401 merge-request open names every secret of several commits, each with its own file, line and commit", () => {
  let awsCommit = "";
  let keyCommit = "";
  const { repositories } = setup({
    commits: ({ worktree }) => {
      awsCommit = commitFiles(
        worktree,
        { "deploy/aws.ts": markerFile("aws-access-key", 3) },
        "aws",
      );
      keyCommit = commitFiles(worktree, { "src/key.ts": markerFile("generic-api-key", 7) }, "key");
    },
  });
  const result = openMergeRequest();
  expect(result.code).not.toBe(0);
  const text = said(result);
  expect(text).toContain(`aws-access-key in deploy/aws.ts:3 (commit ${awsCommit.slice(0, 8)})`);
  expect(text).toContain(`generic-api-key in src/key.ts:7 (commit ${keyCommit.slice(0, 8)})`);
  expectNothingShipped(repositories);
});

test("ARK-T401 a clean run opens, and the posted body holds neither the marker line nor a secret value", () => {
  setup();
  const result = openMergeRequest();
  expect(result.code, said(result)).toBe(0);
  expect(created()).toHaveLength(1);
  expect(bodyOf(created()[0])).not.toContain(sentinel);
  expect(bodyOf(created()[0])).not.toContain("FAKE-SECRET");
});

test("ARK-T401 a crashed scan of a repo that holds a leak never prints the secret value", () => {
  const { repositories } = setup({
    commits: ({ worktree }) => {
      commitFiles(worktree, { "src/config.ts": markerFile("generic-api-key") }, "config");
    },
  });
  // The fake logs each finding with its Secret to stderr, as gitleaks does. An unreadable report makes the scan fail, and
  // the failure shows that stderr: it holds the sentinel only when gitleaks ran without --redact.
  process.env.FAKE_GITLEAKS_REPORT = "not json";
  const result = openMergeRequest();
  expect(result.code).not.toBe(0);
  expect(said(result)).toContain("gitleaks failed");
  expect(said(result)).toContain("Secret: REDACTED");
  expect(said(result)).not.toContain(sentinel);
  expectNothingShipped(repositories);
});

test("ARK-T401 a secret in a commit before the base does not block", () => {
  setup({ baseFiles: { "README.md": "# test\n", "src/old.ts": markerFile("generic-api-key") } });
  const result = openMergeRequest();
  expect(result.code, said(result)).toBe(0);
  expect(created()).toHaveLength(1);
});

test("ARK-T401 run close handed_off with a base that is not in the object store scans the whole first-parent history: a secret refuses, a clean history closes", () => {
  const unknownBase = "0".repeat(40);
  const leaking = setup({
    base: unknownBase,
    baseFiles: { "src/old.ts": markerFile("generic-api-key", 3) },
  });
  const refused = ark("run", "close", run, "handed_off");
  expect(refused.code).not.toBe(0);
  expect(said(refused)).toContain("generic-api-key in src/old.ts:3");
  expect(eventTypes(leaking.runDirectory)).not.toContain("run.closed");

  const clean = setup({ base: unknownBase });
  const closed = ark("run", "close", run, "handed_off");
  expect(closed.code, said(closed)).toBe(0);
  expect(eventTypes(clean.runDirectory)).toContain("run.closed");
});

test("ARK-T401 a run commit cannot switch the secret gate off: an inline allow, a committed allowlist, a committed or untracked ignore file and a `-diff` or `binary` attribute still refuse", () => {
  const secret = markerFile("generic-api-key");
  const bypasses: Record<string, (worktree: string) => void> = {
    "gitleaks:allow comment": (worktree) =>
      commitFiles(
        worktree,
        { "src/config.ts": secret.replace("generic-api-key", "generic-api-key # gitleaks:allow") },
        "config",
      ),
    ".gitleaks.toml allowlist": (worktree) =>
      commitFiles(
        worktree,
        { "src/config.ts": secret, ".gitleaks.toml": '[allowlist]\npaths = ["src/config.ts"]\n' },
        "config",
      ),
    ".gitleaksignore": (worktree) => {
      const commit = commitFiles(worktree, { "src/config.ts": secret }, "config");
      commitFiles(
        worktree,
        { ".gitleaksignore": `${commit}:src/config.ts:generic-api-key:12\n` },
        "ignore",
      );
    },
    ".gitleaksignore left untracked in the worktree": (worktree) => {
      const commit = commitFiles(worktree, { "src/config.ts": secret }, "config");
      writeFileSync(
        join(worktree, ".gitleaksignore"),
        `${commit}:src/config.ts:generic-api-key:12\n`,
      );
    },
    ".gitattributes -diff": (worktree) =>
      commitFiles(
        worktree,
        { ".gitattributes": "src/config.ts -diff\n", "src/config.ts": secret },
        "config",
      ),
    ".gitattributes binary": (worktree) =>
      commitFiles(
        worktree,
        { ".gitattributes": "src/config.ts binary\n", "src/config.ts": secret },
        "config",
      ),
  };
  for (const [name, commit] of Object.entries(bypasses)) {
    const { repositories } = setup({ commits: ({ worktree }) => commit(worktree) });
    const result = openMergeRequest();
    expect(result.code, name).not.toBe(0);
    expect(said(result), name).toContain("generic-api-key in src/config.ts:12");
    expectNothingShipped(repositories);
  }
});

test("ARK-T401 a .gitleaks.toml allowlist that the base already holds still applies", () => {
  setup({
    baseFiles: {
      "README.md": "# test\n",
      ".gitleaks.toml": '[allowlist]\npaths = ["src/legacy.ts"]\n',
    },
    commits: ({ worktree }) =>
      commitFiles(worktree, { "src/legacy.ts": markerFile("generic-api-key") }, "legacy"),
  });
  const result = openMergeRequest();
  expect(result.code, said(result)).toBe(0);
  expect(created()).toHaveLength(1);
});

/** The run branch merges origin/main, which holds a commit with a marker that local `main` lacks, as `ark worktree sync` does. */
function mergeTargetWithSecret({ worktree, bare }: Repository) {
  commitFiles(worktree, { "core.txt": "core" }, "core");
  const folder = mkdtempSync(join(tmpdir(), "ark-target-"));
  git(folder, "clone", "-q", bare, "target");
  commitFiles(join(folder, "target"), { "src/target.ts": markerFile("aws-access-key") }, "target");
  git(join(folder, "target"), "push", "-q", "origin", "HEAD:main");
  git(worktree, "fetch", "-q", "origin");
  git(worktree, "merge", "-q", "--no-edit", "origin/main");
}

test("ARK-T401 a secret merged in from the target does not block, and a secret committed after that merge does", () => {
  setup({ commits: mergeTargetWithSecret });
  const merged = openMergeRequest();
  expect(merged.code, said(merged)).toBe(0);
  expect(created()).toHaveLength(1);

  let ownCommit = "";
  const own = setup({
    commits: (repository) => {
      mergeTargetWithSecret(repository);
      ownCommit = commitFiles(
        repository.worktree,
        { "src/own.ts": markerFile("generic-api-key", 5) },
        "own",
      );
    },
  });
  const refused = openMergeRequest();
  expect(refused.code).not.toBe(0);
  expect(said(refused)).toContain(
    `generic-api-key in src/own.ts:5 (commit ${ownCommit.slice(0, 8)})`,
  );
  expect(said(refused)).not.toContain("aws-access-key");
  expect(branchTip(own.core)).toBe("");
});

test("ARK-T401 a secret that a merge commit adds in its conflict resolution refuses, named by the merge commit", () => {
  let mergeCommit = "";
  const { core } = setup({
    commits: ({ worktree, bare }) => {
      commitFiles(worktree, { "src/conflict.ts": "ours\n" }, "ours");
      const folder = mkdtempSync(join(tmpdir(), "ark-target-"));
      git(folder, "clone", "-q", bare, "target");
      commitFiles(join(folder, "target"), { "src/conflict.ts": "theirs\n" }, "theirs");
      git(join(folder, "target"), "push", "-q", "origin", "HEAD:main");
      git(worktree, "fetch", "-q", "origin");
      const merge = Bun.spawnSync(["git", "merge", "--no-edit", "origin/main"], { cwd: worktree });
      expect(merge.exitCode).not.toBe(0);
      writeFileSync(join(worktree, "src/conflict.ts"), markerFile("generic-api-key", 7));
      git(worktree, "add", "-A");
      git(worktree, "commit", "-m", "resolve");
      mergeCommit = git(worktree, "rev-parse", "HEAD");
    },
  });
  const result = openMergeRequest();
  expect(result.code).not.toBe(0);
  expect(said(result)).toContain(
    `generic-api-key in src/conflict.ts:7 (commit ${mergeCommit.slice(0, 8)})`,
  );
  expect(branchTip(core)).toBe("");
});

test("ARK-T401 a refresh of an open MR scans again and refuses before it pushes or edits", () => {
  const { runDirectory, repositories, core } = setup();
  expect(openMergeRequest().code).toBe(0);
  expect(created()).toHaveLength(1);
  const tip = branchTip(core);
  expect(tip).toMatch(/^[0-9a-f]{40}$/);

  const commit = commitFiles(
    core.worktree,
    { "src/late.ts": markerFile("generic-api-key", 4) },
    "late",
  );
  retest(runDirectory, repositories);
  const result = openMergeRequest();
  expect(result.code).not.toBe(0);
  expect(said(result)).toContain(`generic-api-key in src/late.ts:4 (commit ${commit.slice(0, 8)})`);
  expect(branchTip(core)).toBe(tip);
  expect(edited()).toHaveLength(0);
  expect(created()).toHaveLength(1);
});

test("ARK-T401 run close handed_off refuses a secret the same way and leaves the run open; a clean branch closes", () => {
  let commit = "";
  const leaking = setup({
    commits: ({ worktree }) => {
      commit = commitFiles(worktree, { "src/config.ts": markerFile("generic-api-key") }, "config");
    },
  });
  const refused = ark("run", "close", run, "handed_off");
  expect(refused.code).not.toBe(0);
  expect(said(refused)).toContain(
    `generic-api-key in src/config.ts:12 (commit ${commit.slice(0, 8)})`,
  );
  expect(eventTypes(leaking.runDirectory)).not.toContain("run.closed");

  const clean = setup();
  const closed = ark("run", "close", run, "handed_off");
  expect(closed.code, said(closed)).toBe(0);
  expect(eventTypes(clean.runDirectory)).toContain("run.closed");
});

// ---------------------------------------------------------------------------------------------------------------------
// ARK-T402: vulnerabilities and scanner failures
// ---------------------------------------------------------------------------------------------------------------------

const headLockfile = lockfileText("head");
const commitLockfile = ({ worktree }: Repository) =>
  commitFiles(worktree, { "bun.lock": headLockfile }, "lockfile");

test("ARK-T402 merge-request open refuses a critical or a high vulnerability, naming id, package, version, severity and lockfile", () => {
  for (const [entry, id, severity] of [
    [criticalLeftPad, "GHSA-aaaa-bbbb-cccc", "CRITICAL"],
    [highLodash, "GHSA-dddd-eeee-ffff", "HIGH"],
  ] as const) {
    const { repositories } = setup({ commits: commitLockfile });
    osvReports(headLockfile, [entry]);
    const result = openMergeRequest();
    expect(result.code, severity).not.toBe(0);
    const row = rowWith(said(result), id);
    for (const part of [entry.name, entry.version, severity, "bun.lock"])
      expect(row).toContain(part);
    expectNothingShipped(repositories);
  }
});

test("ARK-T402 two vulnerable lockfiles are named in one refusal, each with its own lockfile", () => {
  const docsLockfile = lockfileText("docs");
  const { repositories } = setup({
    commits: ({ worktree }) =>
      commitFiles(
        worktree,
        { "bun.lock": headLockfile, "docs/package-lock.json": docsLockfile },
        "lockfiles",
      ),
  });
  osvReports(headLockfile, [criticalLeftPad]);
  osvReports(docsLockfile, [highLodash]);
  const result = openMergeRequest();
  expect(result.code).not.toBe(0);
  expect(rowWith(said(result), "GHSA-aaaa-bbbb-cccc")).toContain("bun.lock");
  expect(rowWith(said(result), "GHSA-dddd-eeee-ffff")).toContain("docs/package-lock.json");
  expectNothingShipped(repositories);
});

test("ARK-T402 medium and low vulnerabilities do not block", () => {
  setup({ commits: commitLockfile });
  osvReports(headLockfile, [
    {
      name: "pkg-medium",
      version: "1.0.0",
      vulnerabilities: [{ id: "GHSA-mmmm-1111-2222", severity: "MODERATE" }],
    },
    {
      name: "pkg-low",
      version: "1.0.0",
      vulnerabilities: [{ id: "GHSA-llll-3333-4444", severity: "LOW" }],
    },
  ]);
  const result = openMergeRequest();
  expect(result.code, said(result)).toBe(0);
  expect(created()).toHaveLength(1);
});

test("ARK-T402 a vulnerability with no severity blocks when it is a malicious-package advisory, and lists when it is not", () => {
  setup({ commits: commitLockfile });
  osvReports(headLockfile, [
    { name: "left-pad", version: "1.3.0", vulnerabilities: [{ id: "GHSA-nnnn-5555-6666" }] },
  ]);
  const unscored = openMergeRequest();
  expect(unscored.code, said(unscored)).toBe(0);
  const listedRow = rowWith(section(bodyOf(created()[0]), "Security"), "GHSA-nnnn-5555-6666");
  expect(listedRow).toContain("left-pad");

  const { repositories } = setup({ commits: commitLockfile });
  osvReports(headLockfile, [
    { name: "evil-pkg", version: "1.0.0", vulnerabilities: [{ id: "MAL-2026-1234" }] },
  ]);
  const malicious = openMergeRequest();
  expect(malicious.code).not.toBe(0);
  expect(rowWith(said(malicious), "MAL-2026-1234")).toContain("evil-pkg");
  expectNothingShipped(repositories);
});

test("ARK-T402 a high vulnerability that the base already holds still blocks", () => {
  const { repositories } = setup({
    baseFiles: { "README.md": "# test\n", "bun.lock": headLockfile },
  });
  osvReports(headLockfile, [highLodash]);
  const result = openMergeRequest();
  expect(result.code).not.toBe(0);
  expect(said(result)).toContain("GHSA-dddd-eeee-ffff");
  expectNothingShipped(repositories);
});

test("ARK-T402 a repo with no lockfile opens, and so does osv-scanner's no-lockfile exit", () => {
  setup();
  const plain = openMergeRequest();
  expect(plain.code, said(plain)).toBe(0);
  expect(created()).toHaveLength(1);

  setup({ commits: commitLockfile });
  process.env.FAKE_OSV_EXIT = "128";
  process.env.FAKE_OSV_STDERR = "No package sources found";
  const unknown = openMergeRequest();
  expect(unknown.code, said(unknown)).toBe(0);
  expect(created()).toHaveLength(1);
});

test("ARK-T402 a failing osv-scanner never reads as clean: crash, unreadable report and offline lookup all refuse", () => {
  const failures: { exit: string; stdout?: string; stderr?: string; shown: string }[] = [
    { exit: "2", stderr: "panic: boom", shown: "panic: boom" },
    { exit: "1", stdout: "not json", shown: "cannot be read" },
    { exit: "0", stdout: "", shown: "cannot be read" },
    {
      exit: "127",
      stderr: "failed to fetch: lookup api.osv.dev: no such host",
      shown: "lookup api.osv.dev: no such host",
    },
    { exit: "127", stderr: "could not extract bun.lock: malformed", shown: "malformed" },
  ];
  for (const failure of failures) {
    const { repositories } = setup({ commits: commitLockfile });
    process.env.FAKE_OSV_EXIT = failure.exit;
    process.env.FAKE_OSV_STDOUT = failure.stdout ?? "";
    process.env.FAKE_OSV_STDERR = failure.stderr ?? "";
    const result = openMergeRequest();
    expect(result.code, failure.shown).not.toBe(0);
    expect(said(result)).toContain(failure.shown);
    expect(said(result)).toContain("network");
    expectNothingShipped(repositories);
  }
});

test("ARK-T402 a failing gitleaks never reads as clean: a crash and an unreadable report refuse", () => {
  const { repositories } = setup();
  process.env.FAKE_GITLEAKS_EXIT = "2";
  process.env.FAKE_GITLEAKS_STDERR = "fatal: boom";
  const crashed = openMergeRequest();
  expect(crashed.code).not.toBe(0);
  expect(said(crashed)).toContain("fatal: boom");
  expectNothingShipped(repositories);

  delete process.env.FAKE_GITLEAKS_EXIT;
  delete process.env.FAKE_GITLEAKS_STDERR;
  process.env.FAKE_GITLEAKS_REPORT = "not json";
  const unreadable = openMergeRequest();
  expect(unreadable.code).not.toBe(0);
  expect(said(unreadable)).toContain("gitleaks failed");
  expectNothingShipped(repositories);
});

test("ARK-T402 a refresh of an open MR refuses when the head gained a vulnerable lockfile", () => {
  const { runDirectory, repositories, core } = setup();
  osvReports(headLockfile, [criticalLeftPad]);
  expect(openMergeRequest().code).toBe(0);
  const tip = branchTip(core);

  commitLockfile(core);
  retest(runDirectory, repositories);
  const result = openMergeRequest();
  expect(result.code).not.toBe(0);
  expect(said(result)).toContain("GHSA-aaaa-bbbb-cccc");
  expect(branchTip(core)).toBe(tip);
  expect(edited()).toHaveLength(0);
});

// ---------------------------------------------------------------------------------------------------------------------
// ARK-T403: the Security section of the MR body
// ---------------------------------------------------------------------------------------------------------------------

const baseLockfile = lockfileText("base");
const oldPackage: PackageEntry = { name: "pkg-old", version: "1.0.0", licenses: ["GPL-3.0-only"] };
const newPackage: PackageEntry = { name: "pkg-new", version: "2.0.0", licenses: ["Apache-2.0"] };
const mediumFinding: Vulnerability = { id: "GHSA-mmmm-1111-2222", severity: "MODERATE" };
const lowFinding: Vulnerability = { id: "GHSA-llll-3333-4444", severity: "LOW" };
const withBaseLockfile = { "README.md": "# test\n", "bun.lock": baseLockfile };
const changeLockfile = ({ worktree }: Repository) =>
  commitFiles(worktree, { "bun.lock": headLockfile }, "lockfile");

/** `pkg-old` is at the base; the head adds `pkg-new`, with a medium finding on the old and a low one on the new. */
function reportBaseAndHead() {
  osvReports(baseLockfile, [oldPackage]);
  osvReports(headLockfile, [
    { ...oldPackage, vulnerabilities: [mediumFinding] },
    { ...newPackage, vulnerabilities: [lowFinding] },
  ]);
}

test("ARK-T403 merge-request open lists medium and low findings and the licences of new packages only, and still opens", () => {
  setup({ baseFiles: withBaseLockfile, commits: changeLockfile });
  reportBaseAndHead();
  const result = openMergeRequest();
  expect(result.code, said(result)).toBe(0);
  expect(created()).toHaveLength(1);
  const body = bodyOf(created()[0]);
  const security = section(body, "Security");
  expect(security).not.toBe("");

  const medium = rowWith(security, "GHSA-mmmm-1111-2222");
  expect(medium).toContain("pkg-old");
  expect(medium.toLowerCase()).toMatch(/medium|moderate/);
  const low = rowWith(security, "GHSA-llll-3333-4444");
  expect(low).toContain("pkg-new");
  expect(low.toLowerCase()).toContain("low");
  expect(rowWith(security, "Apache-2.0")).toContain("pkg-new");
  // pkg-old is old at the base: its licence is not listed
  expect(body).not.toContain("GPL-3.0-only");
  for (const secretLike of ["AKIA", "ghp_", "glpat-", "xox", "-----BEGIN"])
    expect(body).not.toContain(secretLike);
});

test("ARK-T403 a clean scan adds no Security section and no licence text", () => {
  setup({ baseFiles: withBaseLockfile, commits: changeLockfile });
  osvReports(baseLockfile, []);
  osvReports(headLockfile, []);
  const result = openMergeRequest();
  expect(result.code, said(result)).toBe(0);
  const body = bodyOf(created()[0]);
  expect(body).not.toMatch(securityHeading);
  expect(body).not.toContain("licen");
});

test("ARK-T403 a new package with no finding is listed with its licence and no finding row", () => {
  setup({ baseFiles: withBaseLockfile, commits: changeLockfile });
  osvReports(baseLockfile, []);
  osvReports(headLockfile, [{ ...newPackage, licenses: ["MIT"] }]);
  const result = openMergeRequest();
  expect(result.code, said(result)).toBe(0);
  const security = section(bodyOf(created()[0]), "Security");
  expect(rowWith(security, "pkg-new")).toContain("MIT");
  expect(security).not.toMatch(/GHSA|accepted/);
});

test("ARK-T403 a run that changes no lockfile lists no licence", () => {
  setup({ baseFiles: withBaseLockfile });
  osvReports(baseLockfile, [oldPackage]);
  const result = openMergeRequest();
  expect(result.code, said(result)).toBe(0);
  expect(bodyOf(created()[0])).not.toContain("GPL-3.0-only");
  expect(bodyOf(created()[0])).not.toMatch(securityHeading);
});

test("ARK-T403 a tier 0 body renders the section as a bold title and passes the lint", () => {
  setup({ baseFiles: withBaseLockfile, commits: changeLockfile, config: { pr_writing: {} } });
  reportBaseAndHead();
  const result = openMergeRequest();
  expect(result.code, said(result)).toBe(0);
  const body = bodyOf(created()[0]);
  expect(body).toContain("**Security**");
  expect(body).toContain("GHSA-mmmm-1111-2222");
  expect(body).not.toContain("## Security");
});

test("ARK-T403 each repo's body holds the section of its own scan", () => {
  setup({
    names: ["core", "app"],
    baseFiles: withBaseLockfile,
    commits: ({ name, worktree }) => {
      if (name === "core") commitFiles(worktree, { "bun.lock": headLockfile }, "lockfile");
      else commitFiles(worktree, { "app.txt": "app" }, "app");
    },
  });
  osvReports(baseLockfile, []);
  osvReports(headLockfile, [{ ...oldPackage, vulnerabilities: [mediumFinding] }]);
  const result = openMergeRequest();
  expect(result.code, said(result)).toBe(0);
  const bodies = Object.fromEntries(
    created().map((call) => [call.cwd.split("/").at(-1), bodyOf(call)]),
  );
  expect(bodies.core).toContain("GHSA-mmmm-1111-2222");
  expect(bodies.app).not.toMatch(securityHeading);
});

test("ARK-T403 a refresh rebuilds the section from the scan of that call", () => {
  setup({ baseFiles: withBaseLockfile, commits: changeLockfile });
  reportBaseAndHead();
  expect(openMergeRequest().code).toBe(0);
  expect(bodyOf(created()[0])).toContain("GHSA-mmmm-1111-2222");

  // No new commit and no new event: only the scanner's answer changes.
  osvReports(baseLockfile, []);
  osvReports(headLockfile, []);
  const cleared = openMergeRequest();
  expect(cleared.code, said(cleared)).toBe(0);
  expect(edited()).toHaveLength(1);
  expect(bodyOf(edited()[0])).not.toMatch(securityHeading);

  osvReports(headLockfile, [
    { ...oldPackage, vulnerabilities: [{ id: "GHSA-nnnn-5555-6666", severity: "LOW" }] },
  ]);
  const changed = openMergeRequest();
  expect(changed.code, said(changed)).toBe(0);
  expect(edited()).toHaveLength(2);
  expect(bodyOf(edited()[1])).toContain("GHSA-nnnn-5555-6666");
  expect(bodyOf(edited()[1])).not.toContain("GHSA-mmmm-1111-2222");
});

// ---------------------------------------------------------------------------------------------------------------------
// ARK-T404: security.accepted
// ---------------------------------------------------------------------------------------------------------------------

const reasonCritical = "waived: not reachable from the CLI";
const reasonSecret = "waived: test fixture key";
const accept = (id: string, reason = reasonCritical) => ({
  security: { accepted: [{ id, reason }] },
});

test("ARK-T404 an accepted vulnerability, named by id or by alias, opens and shows as accepted with its reason", () => {
  for (const id of ["GHSA-aaaa-bbbb-cccc", "CVE-2026-0001"]) {
    setup({ commits: commitLockfile, config: accept(id) });
    osvReports(headLockfile, [criticalLeftPad]);
    const result = openMergeRequest();
    expect(result.code, `${id}: ${said(result)}`).toBe(0);
    const security = section(bodyOf(created().at(-1)), "Security");
    const row = rowWith(security, "GHSA-aaaa-bbbb-cccc");
    for (const part of ["accepted", "left-pad", reasonCritical]) expect(row).toContain(part);
    expect(security).not.toMatch(/critical/i);
  }
});

test("ARK-T404 one accepted finding does not let a second one through", () => {
  const { workspace, repositories } = setup({
    commits: commitLockfile,
    config: accept("GHSA-aaaa-bbbb-cccc"),
  });
  osvReports(headLockfile, [criticalLeftPad, highLodash]);
  const partial = openMergeRequest();
  expect(partial.code).not.toBe(0);
  expect(said(partial)).toContain("GHSA-dddd-eeee-ffff");
  expect(said(partial)).not.toContain("GHSA-aaaa-bbbb-cccc");
  expectNothingShipped(repositories);

  writeProject(
    "demo",
    projectConfig(workspace, {
      security: {
        accepted: [
          { id: "GHSA-aaaa-bbbb-cccc", reason: reasonCritical },
          { id: "GHSA-dddd-eeee-ffff", reason: "waived: dev dependency" },
        ],
      },
    }),
  );
  const both = openMergeRequest();
  expect(both.code, said(both)).toBe(0);
  const security = section(bodyOf(created()[0]), "Security");
  expect(rowWith(security, "GHSA-aaaa-bbbb-cccc")).toContain("accepted");
  expect(rowWith(security, "GHSA-dddd-eeee-ffff")).toContain("waived: dev dependency");
});

test("ARK-T404 an entry that names no finding accepts nothing, and is no error when the scan is clean", () => {
  const { repositories } = setup({
    commits: commitLockfile,
    config: accept("GHSA-zzzz-0000-0000"),
  });
  osvReports(headLockfile, [criticalLeftPad]);
  const refused = openMergeRequest();
  expect(refused.code).not.toBe(0);
  expect(said(refused)).toContain("GHSA-aaaa-bbbb-cccc");
  expectNothingShipped(repositories);

  osvReports(headLockfile, []);
  const clean = openMergeRequest();
  expect(clean.code, said(clean)).toBe(0);
});

test("ARK-T404 an accepted secret opens, shows its fingerprint and reason without the value, and a second secret still blocks", () => {
  let first = "";
  let second = "";
  const { runDirectory, workspace, core } = setup({
    commits: ({ worktree }) => {
      first = commitFiles(worktree, { "src/config.ts": markerFile("generic-api-key") }, "config");
      second = commitFiles(worktree, { "src/other.ts": markerFile("aws-access-key", 9) }, "other");
    },
  });
  const fingerprint = `${first}:src/config.ts:generic-api-key:12`;
  writeProject("demo", projectConfig(workspace, accept(fingerprint, reasonSecret)));
  const partial = openMergeRequest();
  expect(partial.code).not.toBe(0);
  expect(said(partial)).toContain(
    `aws-access-key in src/other.ts:9 (commit ${second.slice(0, 8)})`,
  );
  expect(said(partial)).not.toContain("src/config.ts");
  expect(said(partial)).not.toContain(sentinel);

  // Remove the second secret from the branch: reset to the first commit.
  git(core.worktree, "reset", "-q", "--hard", first);
  retest(runDirectory, [core]);
  const result = openMergeRequest();
  expect(result.code, said(result)).toBe(0);
  const row = rowWith(section(bodyOf(created()[0]), "Security"), fingerprint);
  for (const part of ["accepted", "generic-api-key", "src/config.ts", reasonSecret])
    expect(row).toContain(part);
  expect(bodyOf(created()[0])).not.toContain(sentinel);
  expect(said(result)).not.toContain(sentinel);
});

test("ARK-T404 a refresh re-reads the accepted list: the edited body shows the new reason", () => {
  const { workspace } = setup({ commits: commitLockfile, config: accept("GHSA-aaaa-bbbb-cccc") });
  osvReports(headLockfile, [criticalLeftPad]);
  expect(openMergeRequest().code).toBe(0);
  expect(bodyOf(created()[0])).toContain(reasonCritical);

  writeProject(
    "demo",
    projectConfig(workspace, accept("GHSA-aaaa-bbbb-cccc", "waived: re-reviewed")),
  );
  const result = openMergeRequest();
  expect(result.code, said(result)).toBe(0);
  expect(edited()).toHaveLength(1);
  expect(bodyOf(edited()[0])).toContain("waived: re-reviewed");
  expect(bodyOf(edited()[0])).not.toContain(reasonCritical);
});

test("ARK-T404 accepting a finding in ark.yml changes no head and asks for no new test run", () => {
  const { workspace, core } = setup({ commits: commitLockfile });
  osvReports(headLockfile, [criticalLeftPad]);
  const head = git(core.worktree, "rev-parse", "HEAD");
  expect(openMergeRequest().code).not.toBe(0);

  writeProject("demo", projectConfig(workspace, accept("GHSA-aaaa-bbbb-cccc")));
  const result = openMergeRequest();
  expect(result.code, said(result)).toBe(0);
  expect(said(result)).not.toContain("ark test");
  expect(git(core.worktree, "rev-parse", "HEAD")).toBe(head);
});

test("ARK-T404 a malformed security block refuses to load ark.yml and names the field", () => {
  const { workspace, repositories } = setup();
  const entry = { id: "GHSA-aaaa-bbbb-cccc", reason: reasonCritical };
  const malformed: [Record<string, unknown>, string][] = [
    [{ security: { accepted: [{ id: entry.id }] } }, "security.accepted[0].reason"],
    [{ security: { accepted: [{ id: entry.id, reason: "" }] } }, "security.accepted[0].reason"],
    [{ security: { accepted: [{ reason: "r" }] } }, "security.accepted[0].id"],
    [{ security: { accepted: [{ id: "", reason: "r" }] } }, "security.accepted[0].id"],
    [{ security: { accepted: [entry, entry] } }, "security.accepted[1]"],
    [{ security: { accepted: [], extra: true } }, "extra"],
    [{ security: { accepted: [{ ...entry, why: "x" }] } }, "why"],
    [{ security: { accepted: entry } }, "security.accepted"],
  ];
  for (const [config, field] of malformed) {
    writeProject("demo", projectConfig(workspace, config));
    const result = openMergeRequest();
    expect(result.code, field).not.toBe(0);
    expect(said(result), JSON.stringify(config)).toContain(field);
    expectNothingShipped(repositories);
  }
  for (const config of [{ security: { accepted: [] } }, {}]) {
    writeProject("demo", projectConfig(workspace, config));
    const result = openMergeRequest();
    expect(result.code, `${JSON.stringify(config)}: ${said(result)}`).toBe(0);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// ARK-T405: a missing scanner
// ---------------------------------------------------------------------------------------------------------------------

const brewGitleaks = "brew install gitleaks";
const brewOsv = "brew install osv-scanner";

/** A PATH with bun, the harnesses the roles name, the fake host and the system folders, and only the scanners listed. */
function pathWith(installed: string[]): string {
  const bin = mkdtempSync(join(tmpdir(), "ark-scanner-path-"));
  symlinkSync(process.execPath, join(bin, "bun"));
  for (const harness of ["claude", "codex"]) {
    writeFileSync(join(bin, harness), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, harness), 0o755);
  }
  for (const tool of installed) symlinkSync(join(scannerFixtures, tool), join(bin, tool));
  return `${bin}:${hostFixtures}:/usr/bin:/bin`;
}

/** The full line that holds `needle`: the text a person reads and acts on. */
const lineWith = (text: string, needle: string) =>
  text.split("\n").find((line) => line.includes(needle)) ?? "";

test("ARK-T405 with neither scanner installed, status names both with their brew commands and exits 0, and merge-request open refuses with the same lines", () => {
  const { repositories } = setup();
  process.env.PATH = pathWith([]);
  const status = ark("status");
  expect(status.code, said(status)).toBe(0);
  const gitleaksLine = lineWith(status.out, brewGitleaks);
  const osvLine = lineWith(status.out, brewOsv);
  expect(gitleaksLine).toContain("gitleaks");
  expect(osvLine).toContain("osv-scanner");

  const result = openMergeRequest();
  expect(result.code).not.toBe(0);
  // the same line of each tool, byte for byte
  expect(lineWith(result.err, brewGitleaks)).toBe(gitleaksLine);
  expect(lineWith(result.err, brewOsv)).toBe(osvLine);
  expectNothingShipped(repositories);
  expect(readFileSync(scanLog, "utf8")).toBe("");
});

test("ARK-T405 with one scanner missing, status and the refusal name that one only", () => {
  setup();
  const cases = [
    { installed: ["osv-scanner"], missing: ["gitleaks", brewGitleaks], other: "osv-scanner" },
    { installed: ["gitleaks"], missing: ["osv-scanner", brewOsv], other: "gitleaks" },
  ];
  for (const { installed, missing, other } of cases) {
    process.env.PATH = pathWith(installed);
    const status = ark("status");
    expect(status.code, said(status)).toBe(0);
    const line = lineWith(status.out, missing[1]);
    expect(line).toContain(missing[0]);
    expect(status.out).not.toContain(`brew install ${other}`);

    const result = openMergeRequest();
    expect(result.code).not.toBe(0);
    expect(lineWith(result.err, missing[1])).toBe(line);
    expect(result.err).not.toContain(`brew install ${other}`);
    expect(created()).toHaveLength(0);
    expect(readFileSync(scanLog, "utf8")).toBe("");
  }
});

test("ARK-T405 with both scanners installed, status prints no scanner or role line and the open proceeds", () => {
  setup();
  process.env.PATH = pathWith(["gitleaks", "osv-scanner"]);
  const status = ark("status");
  expect(status.code, said(status)).toBe(0);
  expect(status.out).not.toContain("brew install");
  expect(status.out).not.toContain("role ");

  const result = openMergeRequest();
  expect(result.code, said(result)).toBe(0);
  expect(created()).toHaveLength(1);
});

test("ARK-T405 a missing osv-scanner refuses a repo that has no lockfile", () => {
  const { repositories } = setup();
  process.env.PATH = pathWith(["gitleaks"]);
  const result = openMergeRequest();
  expect(result.code).not.toBe(0);
  expect(result.err).toContain(brewOsv);
  expectNothingShipped(repositories);
});

test("ARK-T405 run close handed_off refuses a missing scanner in a project with merge_requests none, and closes with both installed", () => {
  const { runDirectory } = setup({ config: { merge_requests: "none" } });
  process.env.PATH = pathWith([]);
  const refused = ark("run", "close", run, "handed_off");
  expect(refused.code).not.toBe(0);
  expect(refused.err).toContain(brewGitleaks);
  expect(refused.err).toContain(brewOsv);
  expect(eventTypes(runDirectory)).not.toContain("run.closed");

  process.env.PATH = pathWith(["gitleaks", "osv-scanner"]);
  const closed = ark("run", "close", run, "handed_off");
  expect(closed.code, said(closed)).toBe(0);
  expect(eventTypes(runDirectory)).toContain("run.closed");
});

test("ARK-T405 status prints each missing-scanner line once, with an open run and with no run", () => {
  setup();
  process.env.PATH = pathWith([]);
  const lines = (status: { out: string }) =>
    [brewGitleaks, brewOsv].map((command) => status.out.split(command).length - 1);
  const withRun = ark("status");
  expect(withRun.code, said(withRun)).toBe(0);
  expect(lines(withRun)).toEqual([1, 1]);

  // a project with no run at all
  tempArkHome();
  writeProject("empty", projectConfig(mkdtempSync(join(tmpdir(), "ark-workspace-"))));
  const withoutRun = ark("status");
  expect(withoutRun.code, said(withoutRun)).toBe(0);
  expect(lines(withoutRun)).toEqual([1, 1]);
});
