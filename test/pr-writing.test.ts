import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { loadConfig, type PrWriting } from "../cli/config.ts";
import { buildBody } from "../skills/pr-writing/lib/body.ts";
import type { Ledger } from "../skills/pr-writing/lib/ledger.ts";
import {
  hashBody,
  lintBody,
  tierOfLedger,
  type LintInput,
  type LintResult,
} from "../skills/pr-writing/lib/lint.ts";
import { description } from "./fixtures/pr-writing/old-description.ts";
import { ark, tempArkHome, tempGitRepo, writeProject } from "./helpers.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(60_000);

const root = resolve(import.meta.dir, "..");
const fixtures = resolve(import.meta.dir, "fixtures/merge-request");
const lintFixtures = resolve(import.meta.dir, "fixtures/pr-writing/lint");
const originalPath = process.env.PATH;
const hostVariables = [
  "FAKE_LOG",
  "FAKE_TOKEN_OWNER",
  "FAKE_PROBE_FAIL",
  "FAKE_RACE_MR",
  "FAKE_EDIT_BODY",
  "FAKE_TOKEN_OWNERS",
];

// A token made at run time, so no file of the repo holds a string a secret scanner would flag.
const githubToken = `ghp${"_"}${"0".repeat(36)}`;

// --- shared helpers ---------------------------------------------------------------------------

let logFile = "";

beforeEach(() => {
  logFile = join(mkdtempSync(join(tmpdir(), "pr-writing-log-")), "calls.ndjson");
  process.env.FAKE_LOG = logFile;
  process.env.PATH = `${fixtures}:${(originalPath ?? "")
    .split(":")
    .filter((entry) => entry !== fixtures)
    .join(":")}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
  for (const name of hostVariables) delete process.env[name];
});

type LoggedCall = { tool: string; cwd: string; argv: string[]; body?: string };

function loggedCalls(): LoggedCall[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const writeCalls = () =>
  loggedCalls().filter(
    (call) =>
      call.argv.includes("create") || call.argv.includes("edit") || call.argv.includes("update"),
  );

function git(directory: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

const driverFile = resolve(import.meta.dir, "fixtures/pr-writing/driver.ts");

type Driven<T> = { value?: T; error?: string; out: string[]; err: string[] };

/** Runs a ledger or post call in a process that sees the fake `gh` and `glab` on PATH (see the driver). */
function drive<T>(
  command: "ledger" | "post",
  input: unknown,
  env: Record<string, string> = {},
): Driven<T> {
  const spawned = Bun.spawnSync(["bun", driverFile, command, JSON.stringify(input)], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const line = spawned.stdout.toString().trim().split("\n").at(-1) ?? "";
  if (line === "") throw new Error(`driver failed: ${spawned.stderr.toString()}`);
  return JSON.parse(line);
}

function ledgerOf(source: object, env: Record<string, string> = {}): Ledger {
  const { value, error } = drive<Ledger>("ledger", source, env);
  if (error !== undefined) throw new Error(error);
  return value!;
}

// --- run folder builder -----------------------------------------------------------------------

type RunSpec = {
  kind?: string;
  summary?: string;
  criteria?: { id: string; status: string; verifiedBy?: string[] }[];
  gates?: { gate: string; answer: string; by?: string }[];
  /** Findings files by name, `findings/<name>`. */
  findings?: Record<string, string>;
  /** `null`: no `results/evidence/`. Else one folder for each test case. */
  evidence?: Record<string, { base: string; head: string; sha?: string; shots?: string[] }> | null;
  repos?: {
    name: string;
    base?: Record<string, string>;
    changes: Record<string, string | null>;
    messages?: string[];
  }[];
  host?: "github" | "gitlab";
  steps?: { id: string; role: string; repo: string; needs: string[] }[];
  where?: string;
  interfaces?: { name: string; callers: string[] }[];
  risks?: string[];
  /** Checks of `ark.yml` and the result the last test run recorded for each (absent: not run). */
  checks?: { name: string; passed?: boolean }[];
  /** True: the last `test.completed` has no `checks` field, as in a run from before ARK-302. */
  withoutChecksField?: boolean;
  /** The ticket's `## Change` text (default: one numbered item). */
  changeText?: string;
  openedMergeRequests?: { repo: string; url: string; number: number }[];
  files?: Record<string, string>;
  prWriting?: PrWriting;
};

const evidenceSha = "abc1234def5678abc1234def5678abc1234def56";

/** Writes a run folder with real git worktrees for its repos and returns the ledger builder. */
function makeRun(spec: RunSpec = {}) {
  tempArkHome();
  const base = mkdtempSync(join(tmpdir(), "pr-writing-run-"));
  const directory = join(base, "run");
  mkdirSync(join(directory, "findings"), { recursive: true });
  const host = spec.host ?? "github";
  const criteria = spec.criteria ?? [{ id: "AC1", status: "passing", verifiedBy: ["ARK-T1"] }];
  const repoSpecs = spec.repos ?? [{ name: ".", changes: { "cli/a.ts": "changed\n" } }];

  writeProject("demo", {
    workspace: base,
    ticket_source: "local",
    suites: [{ name: "s", level: "integration", repo: ".", command: "true", parser: "bun" }],
    roles: Object.fromEntries(
      ["implementer", "validator", "reviewer"].map((role) => [role, { harness: "h", model: "m" }]),
    ),
    ...(spec.checks
      ? {
          checks: spec.checks.map(({ name }) => ({
            name,
            repo: repoSpecs[0].name === "." ? "repos/root" : repoSpecs[0].name,
            command: "true",
          })),
        }
      : {}),
  });

  const front = {
    id: "ARK-9",
    title: "Show units",
    ...(spec.summary ? { summary: spec.summary } : {}),
    kind: spec.kind ?? "feature",
    acceptance_criteria: criteria.map((criterion) => ({
      id: criterion.id,
      text: `AC-TEXT-MARKER ${criterion.id}`,
      method: "test",
      verified_by: criterion.verifiedBy ?? [],
    })),
  };
  writeFileSync(
    join(directory, "ticket.md"),
    `---\n${JSON.stringify(front)}\n---\n## Problem\n\nAn MR body listed a bug that was already fixed.\n\n## Change\n\n${spec.changeText ?? "1. The body is rebuilt from the run."}\n`,
  );

  const steps = spec.steps ?? [
    { id: "build", role: "implementer", repo: repoSpecs[0].name, needs: [] },
  ];
  writeFileSync(
    join(directory, "plan.yml"),
    JSON.stringify({
      steps: steps.map((step) => ({ harness: "h", model: "m", criteria: [], ...step })),
      test_cases: [],
      design: { interfaces: spec.interfaces ?? [] },
      summary: {
        why: "Bodies went stale.",
        changes: [
          { criterion: criteria[0].id, where: spec.where ?? "cli/a.ts", now: "n", fix: "f" },
        ],
      },
    }),
  );

  for (const [name, text] of Object.entries(spec.findings ?? {}))
    writeFileSync(join(directory, "findings", name), text);
  for (const [name, text] of Object.entries(spec.files ?? {}))
    writeFileSync(join(directory, name), text);

  const events: { type: string; time?: string; data: Record<string, unknown> }[] = [
    {
      type: "run.started",
      time: "2026-11-06T10:00:00.000Z",
      data: {
        run: "2026-11-06-ARK-9-1",
        project: "demo",
        ticket: { id: "ARK-9", title: "Show units" },
        kind: spec.kind ?? "feature",
        criteria: criteria.map((criterion) => criterion.id),
        criteria_gate: true,
      },
    },
  ];
  if (spec.risks)
    events.push({
      type: "evaluation.recorded",
      data: { blockers: [], risks: spec.risks, surfaces: [] },
    });
  for (const gate of spec.gates ?? [])
    events.push({ type: "gate.answered", data: { by: "human", ...gate } });

  const heads: Record<string, string> = {};
  const paths: Record<string, string> = {};
  for (const repoSpec of repoSpecs) {
    const repoDirectory = join(base, repoSpec.name === "." ? "repos/root" : repoSpec.name);
    mkdirSync(repoDirectory, { recursive: true });
    git(repoDirectory, "init", "-b", "main");
    for (const [name, text] of Object.entries(
      repoSpec.base ?? { "README.md": "x\n", "cli/a.ts": "base\n" },
    )) {
      mkdirSync(dirname(join(repoDirectory, name)), { recursive: true });
      writeFileSync(join(repoDirectory, name), text);
    }
    git(repoDirectory, "add", ".");
    git(repoDirectory, "commit", "-m", "base");
    git(
      repoDirectory,
      "remote",
      "add",
      "origin",
      `https://${host === "github" ? "github.com" : "gitlab.com"}/org/${repoSpec.name.split("/").at(-1)}.git`,
    );
    git(repoDirectory, "checkout", "-b", "ark/ARK-9-x");
    for (const [name, text] of Object.entries(repoSpec.changes)) {
      if (text === null) git(repoDirectory, "rm", "-q", name);
      else {
        mkdirSync(dirname(join(repoDirectory, name)), { recursive: true });
        writeFileSync(join(repoDirectory, name), text);
      }
    }
    git(repoDirectory, "add", "-A");
    const [first, ...rest] = repoSpec.messages ?? ["ARK-9: change"];
    git(repoDirectory, "commit", "-m", first, "--allow-empty");
    for (const message of rest) git(repoDirectory, "commit", "-m", message, "--allow-empty");
    heads[repoSpec.name] = git(repoDirectory, "rev-parse", "HEAD");
    paths[repoSpec.name] = repoDirectory;
    events.push({
      type: "worktree.created",
      data: { repo: repoSpec.name, path: repoDirectory, branch: "ark/ARK-9-x", base: "main" },
    });
  }
  for (const step of steps.filter((candidate) => candidate.role === "reviewer"))
    events.push({
      type: "step.started",
      data: { step: step.id, role: "reviewer", repo: step.repo, round: 1 },
    });
  for (const opened of spec.openedMergeRequests ?? [])
    events.push({ type: "merge_request.opened", data: opened });
  events.push(
    {
      type: "test.completed",
      time: "2026-11-06T10:10:00.000Z",
      data: {
        passed: false,
        heads: {},
        criteria: Object.fromEntries(criteria.map((criterion) => [criterion.id, "failing"])),
      },
    },
    {
      type: "test.completed",
      time: "2026-11-06T10:40:00.000Z",
      data: {
        passed: true,
        heads,
        criteria: Object.fromEntries(criteria.map((criterion) => [criterion.id, criterion.status])),
        ...(spec.withoutChecksField
          ? {}
          : {
              checks: (spec.checks ?? [])
                .filter((check) => check.passed !== undefined)
                .map(({ name, passed }) => ({ name, passed })),
            }),
      },
    },
  );
  writeFileSync(
    join(directory, "events.ndjson"),
    events
      .map((event, i) => JSON.stringify({ seq: i + 1, time: "2026-11-06T10:05:00.000Z", ...event }))
      .join("\n") + "\n",
  );

  if (spec.evidence !== null) {
    const evidence = spec.evidence ?? { "ARK-T1": { base: "fail", head: "pass" } };
    mkdirSync(join(directory, "results", "evidence"), { recursive: true });
    for (const [testCase, entry] of Object.entries(evidence))
      for (const side of ["base", "head"] as const) {
        const folder = join(directory, "results", "evidence", testCase, side);
        mkdirSync(join(folder, "screenshots"), { recursive: true });
        writeFileSync(
          join(folder, "result.json"),
          JSON.stringify({ case: testCase, status: entry[side], sha: entry.sha ?? evidenceSha }),
        );
        if (side === "head")
          for (const shot of entry.shots ?? [])
            writeFileSync(join(folder, "screenshots", shot), "");
      }
  }

  return {
    directory,
    paths,
    heads,
    ledger: (prWriting?: RunSpec["prWriting"]): Ledger =>
      ledgerOf({ runFolder: directory, prWriting: prWriting ?? spec.prWriting }),
  };
}

/** The first line of the generated text that is not blank and not a marker. */
const firstContentLine = (body: string) =>
  body.split("\n").find((line) => line.trim() !== "" && !line.startsWith("<!--"));

const result = (results: LintResult[], id: string) => results.find((entry) => entry.id === id)!;

const modules = ["ledger", "body", "lint", "post"];

/** The modules of `skills/pr-writing/lib/` that `file` imports, read by bun's own import scanner. */
function importedModules(file: string): string[] {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  return transpiler
    .scanImports(readFileSync(file, "utf8"))
    .map((entry) => resolve(dirname(file), entry.path))
    .filter((path) => dirname(path) === join(root, "skills/pr-writing/lib"))
    .map((path) => path.split("/").at(-1)!.replace(/\.ts$/, ""))
    .sort();
}

function sourcesUnder(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourcesUnder(join(folder, entry.name))
      : /\.tsx?$/.test(entry.name)
        ? [join(folder, entry.name)]
        : [],
  );
}

test("ARK-T52 both entry points import ledger, body, lint and post, and no other file builds an MR title or body", () => {
  const library = join(root, "skills/pr-writing/lib");
  // Entry point two: the skill scripts next to lib/ use the lib modules, and together all four.
  const scripts = sourcesUnder(join(root, "skills/pr-writing")).filter(
    (file) => !file.startsWith(`${library}/`),
  );
  expect(scripts.length).toBeGreaterThan(0);
  const used = new Set<string>();
  for (const script of scripts) {
    const imports = importedModules(script);
    expect({
      script: relative(root, script),
      unknown: imports.filter((name) => !modules.includes(name)),
    }).toEqual({
      script: relative(root, script),
      unknown: [],
    });
    for (const name of imports) used.add(name);
  }
  expect([...used].sort()).toEqual([...modules].sort());

  // Fingerprints of a body or title builder, and the host create calls, outside the module set.
  const fingerprints = [
    "Written by an AI agent",
    "has not reviewed it yet",
    'pr-writing:begin -->"',
    '"pr", "create"',
    '"mr", "create"',
    "gh pr create",
    "glab mr create",
  ];
  const others = [...sourcesUnder(join(root, "cli")), ...sourcesUnder(join(root, "skills"))].filter(
    (file) => !file.startsWith(`${library}/`) && !scripts.includes(file),
  );
  for (const file of others) {
    const text = readFileSync(file, "utf8");
    expect({
      file: relative(root, file),
      hit: fingerprints.find((hit) => text.includes(hit)),
    }).toEqual({
      file: relative(root, file),
      hit: undefined,
    });
  }
});

test("ARK-T53 the run ledger holds the last test result, the open findings, evidence, gates and merge order", () => {
  const run = makeRun({
    kind: "bug",
    summary: "Short outcome",
    criteria: [
      { id: "AC1", status: "passing", verifiedBy: ["ARK-T1"] },
      { id: "AC2", status: "failing", verifiedBy: ["ARK-T2"] },
    ],
    gates: [
      { gate: "criteria", answer: "accept" },
      { gate: "plan", answer: "approve" },
    ],
    risks: ["Old bodies have no markers."],
    evidence: {
      "ARK-T1": { base: "fail", head: "pass" },
      "ARK-T2": { base: "fail", head: "fail" },
    },
    repos: [
      { name: "repos/core", changes: { "cli/a.ts": "core\n" } },
      { name: "repos/app", changes: { "cli/a.ts": "app one\napp two\n" } },
    ],
    steps: [
      { id: "app-impl", role: "implementer", repo: "repos/app", needs: ["core-impl"] },
      { id: "core-impl", role: "implementer", repo: "repos/core", needs: [] },
    ],
    openedMergeRequests: [
      { repo: "repos/core", url: "https://github.com/org/core/pull/7", number: 7 },
    ],
    findings: {
      // A P0 that a later file closes with `No findings.`.
      "build-review-1.md": "### P0: Gone bug\n",
      "build-review-2.md": "No findings.\n",
      // A P1 closed by a send-back decision, then an open P2 and an open P3 in the latest file.
      "final-1.md":
        "### P1: Fixed bug\n\n## Run lead decision\n\n- P1 Fixed bug: send back, fix it\n",
      "final-2.md": "### P2: Slow path\n\n### P3: Naming\n",
    },
  });
  const ledger = run.ledger();

  expect(ledger.source).toBe("run");
  expect(ledger.ticket).toMatchObject({ id: "ARK-9", kind: "bug", summary: "Short outcome" });
  expect(ledger.ticket?.problem).toContain("already fixed");
  expect(ledger.ticket?.change).toContain("rebuilt from the run");
  expect(ledger.ticket?.criteria).toHaveLength(2);
  expect(ledger.plan).toMatchObject({
    why: "Bodies went stale.",
    risks: ["Old bodies have no markers."],
  });
  // The last test.completed only: the earlier one failed every AC.
  expect(ledger.criteria.map(({ id, status }) => [id.split("/").at(-1), status])).toEqual([
    ["AC1", "passing"],
    ["AC2", "failing"],
  ]);
  expect(
    ledger.evidence?.map((entry) => [entry.testCase, entry.base, entry.head, entry.sha]).sort(),
  ).toEqual([
    ["ARK-T1", "fail", "pass", evidenceSha],
    ["ARK-T2", "fail", "fail", evidenceSha],
  ]);
  expect(ledger.findings.map((finding) => `${finding.rank} ${finding.title}`)).toEqual([
    "P2 Slow path",
    "P3 Naming",
  ]);
  expect(ledger.humanGates).toEqual(["criteria", "plan"]);
  expect(ledger.mergeOrder).toEqual(["repos/core", "repos/app"]);
  expect(ledger.repos.map((repo) => repo.dependsOn)).toEqual([[], ["Depends on #7"]]);
  expect(ledger.repos[1].head).toBe(run.heads["repos/app"]);
  expect(ledger.repos[1].shortstat).toBe(
    git(run.paths["repos/app"], "diff", "--shortstat", "main...HEAD"),
  );
  expect(ledger.tokenOwner).toBe("cobekarhoff");
});

/** A fake `gh` that answers the base probes from environment variables; `FAKE_HOST_MODE=fail` fails every call. */
function probeHostBin(): string {
  const bin = mkdtempSync(join(tmpdir(), "pr-writing-probe-"));
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
[ "$FAKE_HOST_MODE" = fail ] && exit 1
case "$1 $2" in
  "pr list") if [ -n "$FAKE_MR_TARGET" ]; then echo "[{\\"baseRefName\\":\\"$FAKE_MR_TARGET\\"}]"; else echo "[]"; fi ;;
  "repo view") echo "$FAKE_DEFAULT_BRANCH" ;;
  "api user") echo cobekarhoff ;;
esac
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}

function gitRepoOnBranch(): string {
  const repo = mkdtempSync(join(tmpdir(), "pr-writing-git-"));
  git(repo, "init", "-b", "main");
  mkdirSync(join(repo, "cli"));
  mkdirSync(join(repo, ".gitlab/merge_request_templates"), { recursive: true });
  writeFileSync(join(repo, "cli", "gate.ts"), "a\n");
  writeFileSync(
    join(repo, ".gitlab/merge_request_templates/Default.md"),
    "## Summary\n\n## Testing\n",
  );
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  git(repo, "branch", "release/2");
  git(repo, "branch", "develop");
  git(repo, "remote", "add", "origin", "https://github.com/o/r.git");
  git(repo, "checkout", "-b", "ark/ARK-9-x");
  writeFileSync(join(repo, "cli", "gate.ts"), "b\n");
  git(repo, "commit", "-am", "ARK-9: change the gate");
  return repo;
}

test("ARK-T53 the git ledger picks the base by the fixed order and records a failed host probe as unknown", () => {
  const bin = probeHostBin();
  const repo = gitRepoOnBranch();
  const setOriginHead = (name: string | null) => {
    if (name === null)
      Bun.spawnSync(["git", "symbolic-ref", "--delete", "refs/remotes/origin/HEAD"], { cwd: repo });
    else git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${name}`);
  };
  const withHost = (environment: Record<string, string>) =>
    drive<Ledger>(
      "ledger",
      { directory: repo },
      { PATH: `${bin}:${process.env.PATH}`, ...environment },
    );

  // Succeeding host. Each row sets all three sources, so a wrong order picks another base.
  setOriginHead("main");
  const rowA = withHost({ FAKE_MR_TARGET: "release/2", FAKE_DEFAULT_BRANCH: "develop" }).value!;
  expect(rowA.baseProbe).toEqual({
    mergeRequestTarget: "release/2",
    originHead: "main",
    hostDefault: "develop",
    chosen: "release/2",
  });
  expect(rowA.repos[0].base).toBe("release/2");

  const rowB = withHost({ FAKE_DEFAULT_BRANCH: "develop" }).value!;
  expect(rowB.baseProbe).toMatchObject({ mergeRequestTarget: "none", chosen: "main" });

  setOriginHead(null);
  const rowC = withHost({ FAKE_DEFAULT_BRANCH: "develop" }).value!;
  expect(rowC.baseProbe).toMatchObject({ originHead: "none", chosen: "develop" });

  expect(withHost({ FAKE_DEFAULT_BRANCH: "" }).error).toMatch(/pass --base/);

  // The git ledger has the shape of the run ledger, filled from git.
  expect(rowC.source).toBe("git");
  expect(rowC.repos[0].commits.map((commit) => commit.subject)).toEqual(["ARK-9: change the gate"]);
  expect(rowC.repos[0].files).toEqual([{ path: "cli/gate.ts", status: "M" }]);
  expect(rowC.repos[0].shortstat).toContain("1 file changed");
  expect(rowC.template?.path).toBe(".gitlab/merge_request_templates/Default.md");
  expect(rowC.trackerRefs).toEqual(["ARK-9"]);

  // Failing host: nothing is `none`, every host-derived field is `unknown`.
  setOriginHead("main");
  const rowE = withHost({ FAKE_HOST_MODE: "fail" }).value!;
  expect(rowE.baseProbe).toEqual({
    mergeRequestTarget: "unknown",
    originHead: "main",
    hostDefault: "unknown",
    chosen: "main",
  });
  expect(rowE.tokenOwner).toBe("unknown");
  setOriginHead(null);
  expect(withHost({ FAKE_HOST_MODE: "fail" }).error).toMatch(
    /open MR target unknown, origin\/HEAD none, host default branch unknown\): pass --base/,
  );
});

/** One-repo run on a fake GitHub host with a bare remote that records pushes, for `ark merge-request open`. */
function cliRun(
  ticket: { title: string; summary?: string },
  extraConfig: Record<string, unknown> = {},
) {
  // A fresh fake host for each run: every run has the same branch and repo name.
  logFile = join(mkdtempSync(join(tmpdir(), "pr-writing-log-")), "calls.ndjson");
  process.env.FAKE_LOG = logFile;
  tempArkHome();
  const workspace = mkdtempSync(join(tmpdir(), "pr-writing-workspace-"));
  const source = join(workspace, "repos", "core");
  mkdirSync(join(workspace, "repos"), { recursive: true });
  Bun.spawnSync(["mv", tempGitRepo(), source]);
  const bare = mkdtempSync(join(tmpdir(), "pr-writing-bare-"));
  git(bare, "init", "--bare");
  git(source, "remote", "add", "origin", "https://github.com/org/core.git");
  git(source, "config", "remote.origin.pushurl", bare);
  const runId = "2026-11-06-ARK-316-1";
  const projectDirectory = writeProject("demo", {
    workspace,
    ticket_source: "local",
    suites: [{ name: "e2e", level: "e2e", repo: ".", command: "true", parser: "bun" }],
    pr_writing: { tier_floor: 1, ...(extraConfig.pr_writing as object) },
    roles: Object.fromEntries(
      ["implementer", "validator", "reviewer"].map((role) => [role, { harness: "h", model: "m" }]),
    ),
  });
  const directory = join(projectDirectory, "runs", runId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "ticket.md"),
    `---\n${JSON.stringify({
      id: "ARK-316",
      title: ticket.title,
      ...(ticket.summary ? { summary: ticket.summary } : {}),
      acceptance_criteria: [{ id: "ARK-316-AC1", text: "It works" }],
    })}\n---\n## Problem\n\nBodies went stale.\n`,
  );
  const worktree = join(mkdtempSync(join(tmpdir(), "pr-writing-worktree-")), "core");
  git(source, "worktree", "add", "-b", `ark/${runId}`, worktree, "main");
  writeFileSync(join(worktree, "core.txt"), "core");
  git(worktree, "add", "-A");
  git(worktree, "commit", "-m", "ARK-316: core");
  writeFileSync(
    join(directory, "plan.yml"),
    JSON.stringify({
      steps: [
        {
          id: "core-impl",
          role: "implementer",
          repo: "repos/core",
          harness: "h",
          model: "m",
          needs: [],
          criteria: ["ARK-316-AC1"],
        },
      ],
      test_cases: [],
    }),
  );
  const events = [
    {
      type: "run.started",
      data: {
        run: runId,
        project: "demo",
        round_budget: 2,
        ticket: { id: "ARK-316", title: ticket.title },
        criteria: ["ARK-316-AC1"],
      },
    },
    {
      type: "plan.checked",
      data: {
        valid: true,
        problems: [],
        plan_hash: "hash",
        steps: [{ id: "core-impl", role: "implementer", repo: "repos/core" }],
      },
    },
    { type: "gate.answered", data: { gate: "plan", answer: "approve" } },
    {
      type: "worktree.created",
      data: { repo: "repos/core", path: worktree, branch: `ark/${runId}`, base: "main" },
    },
    {
      type: "test.completed",
      data: {
        passed: true,
        heads: { "repos/core": git(worktree, "rev-parse", "HEAD") },
        suites: [{ name: "e2e", level: "e2e", passed: true }],
        criteria: { "ARK-316-AC1": "passing" },
      },
    },
  ];
  writeFileSync(
    join(directory, "events.ndjson"),
    events
      .map((event, i) => JSON.stringify({ seq: i + 1, time: "2026-11-06T10:00:00.000Z", ...event }))
      .join("\n") + "\n",
  );
  const pushed = () => git(bare, "branch", "--list");
  return { runId, pushed };
}

const createdTitles = () =>
  loggedCalls()
    .filter((call) => call.argv.includes("create"))
    .map((call) => call.argv[call.argv.indexOf("--title") + 1]);

/** A title of `length` characters made of words. */
const words = (length: number) =>
  "word "
    .repeat(Math.ceil(length / 5))
    .slice(0, length)
    .trim()
    .padEnd(length, "x");

const refusal = "ticket has no summary: pass --summary";

test("ARK-T54 the title is the summary, else a ticket title that fits, else --summary, else a refusal before any push", () => {
  const cases: {
    name: string;
    ticket: { title: string; summary?: string };
    flag?: string;
    /** The whole title, or the word `refused`. */
    expected: string;
  }[] = [
    {
      name: "1 summary beats a long title",
      ticket: { title: words(120), summary: "MR bodies come from one core" },
      expected: "ARK-316: MR bodies come from one core",
    },
    {
      name: "2 title of 63 fits at 72",
      ticket: { title: words(63) },
      expected: `ARK-316: ${words(63)}`,
    },
    { name: "3 title of 64 is 73 in all", ticket: { title: words(64) }, expected: "refused" },
    {
      name: "3b the flag rescues it",
      ticket: { title: words(64) },
      flag: "Short outcome text",
      expected: "ARK-316: Short outcome text",
    },
    {
      name: "4 summary of 64 is too long, the short title is used",
      ticket: { title: "Short title of the ticket", summary: words(64) },
      expected: "ARK-316: Short title of the ticket",
    },
    {
      name: "5 long summary and long title",
      ticket: { title: words(120), summary: words(64) },
      expected: "refused",
    },
    {
      name: "5b the flag rescues it",
      ticket: { title: words(120), summary: words(64) },
      flag: "Short outcome text",
      expected: "ARK-316: Short outcome text",
    },
    { name: "6 no summary and long title", ticket: { title: words(120) }, expected: "refused" },
    {
      name: "6b the flag rescues it",
      ticket: { title: words(120) },
      flag: "Short outcome text",
      expected: "ARK-316: Short outcome text",
    },
  ];
  for (const { name, ticket, flag, expected } of cases) {
    const { runId, pushed } = cliRun(ticket);
    const opened = ark("merge-request", "open", runId, ...(flag ? ["--summary", flag] : []));
    if (expected === "refused") {
      expect({
        name,
        code: opened.code,
        err: opened.err.includes(refusal),
        pushed: pushed(),
      }).toEqual({ name, code: 1, err: true, pushed: "" });
      expect(createdTitles().length).toBe(0);
      continue;
    }
    expect({ name, code: opened.code, err: opened.err }).toEqual({ name, code: 0, err: "" });
    const [title] = createdTitles().slice(-1);
    expect({ name, title }).toEqual({ name, title: expected });
    expect(title.length).toBeLessThanOrEqual(72);
    for (const call of loggedCalls().filter((entry) => entry.argv.includes("create")))
      expect(call.argv).not.toContain("--draft");
  }
});

test("ARK-T54 a title_prefix rule wins and its length counts", () => {
  const prefix = { pr_writing: { title_prefix: "feat(TICKET): desc" } }; // `feat(ARK-316): ` is 15 characters
  const open = (ticket: { title: string; summary?: string }) => {
    const { runId, pushed } = cliRun(ticket, prefix);
    return { opened: ark("merge-request", "open", runId), pushed: pushed() };
  };
  const { opened } = open({ title: words(120), summary: "MR bodies come from one core" });
  expect(opened.code, opened.err).toBe(0);
  expect(createdTitles()).toEqual(["feat(ARK-316): MR bodies come from one core"]);

  const fits = open({ title: words(120), summary: words(57) });
  expect(fits.opened.code, fits.opened.err).toBe(0);
  expect(createdTitles().at(-1)).toBe(`feat(ARK-316): ${words(57)}`);
  expect(createdTitles().at(-1)!.length).toBe(72);

  const tooLong = open({ title: words(120), summary: words(58) });
  expect(tooLong.opened.code).toBe(1);
  expect(tooLong.opened.err).toContain(refusal);
  expect(tooLong.pushed).toBe("");
  expect(createdTitles()).toEqual([]);
});

const sectionOrder = [
  "> Written by an AI agent",
  "Refs:",
  "## Problem",
  "## What is different",
  "## Evidence",
  "## How to verify",
  "## Not done",
  "## Risk and revert",
  "## Acceptance criteria",
];

/** The run of T37: an open P1, a manual-pending AC, an unproven AC, lint failed, typecheck not run, two MRs. */
function gappyRun(spec: RunSpec = {}) {
  return makeRun({
    kind: "bug",
    criteria: [
      { id: "AC1", status: "passing", verifiedBy: ["ARK-T5"] },
      { id: "AC2", status: "manual pending" },
      { id: "AC3", status: "missing", verifiedBy: ["ARK-T6"] },
    ],
    evidence: { "ARK-T5": { base: "fail", head: "pass" } },
    findings: { "review-1.md": "### P1: Missing guard\n" },
    checks: [{ name: "lint", passed: false }, { name: "typecheck" }],
    repos: [
      { name: "repos/core", changes: { "cli/a.ts": "core\n" } },
      { name: "repos/app", changes: { "cli/a.ts": "app\n" } },
    ],
    steps: [
      { id: "app-impl", role: "implementer", repo: "repos/app", needs: ["core-impl"] },
      { id: "core-impl", role: "implementer", repo: "repos/core", needs: [] },
    ],
    prWriting: {
      reviewers: [],
      tier_floor: 1,
      sensitive_paths: [],
      one_way_paths: [],
      agent_authored: true,
    },
    ...spec,
  });
}

test("ARK-T37 the body has the sections in order, lists each gap under Not done and pastes no AC text", () => {
  const body = buildBody(gappyRun().ledger());

  const positions = sectionOrder.map((heading) => body.indexOf(heading));
  expect(
    positions.every((position) => position >= 0),
    positions.join(),
  ).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));

  const evidence = body.split("## Evidence")[1].split("## ")[0];
  expect(evidence).toContain("`ARK-T5`: base fail, head pass");

  const verify = body.split("## How to verify")[1].split("## ")[0];
  const items = verify.split("\n").filter((line) => line.startsWith("- [ ]"));
  expect(items.length).toBeGreaterThan(0);
  for (const item of items) expect(item).toMatch(/`[^`]+`.*Expect/);

  const notDone = body.split("## Not done")[1].split("## ")[0];
  for (const gap of [
    "P1 open: Missing guard",
    "AC2 manual pending",
    "AC3 not proven",
    "Check `lint` failed",
    "Check `typecheck` did not run",
  ])
    expect(notDone).toContain(gap);

  const risk = body.split("## Risk and revert")[1].split("## ")[0];
  expect(risk).toMatch(/^\s*Merge risk: (low|medium|high) \(script/);
  const reverts = risk.match(/git revert -m 1 <merge sha of the MR for [^>]+>/g);
  expect(reverts).toEqual([
    "git revert -m 1 <merge sha of the MR for repos/app>",
    "git revert -m 1 <merge sha of the MR for repos/core>",
  ]);

  const checklist = body.split("## Acceptance criteria")[1];
  expect(checklist).toContain("[x] AC1 tested");
  expect(checklist).toContain("[ ] AC2 manual pending");
  expect(body).not.toContain("AC-TEXT-MARKER");
});

test("ARK-T37 a check that ran and passed leaves Not done, a failed check stays", () => {
  const body = buildBody(
    gappyRun({
      checks: [
        { name: "lint", passed: false },
        { name: "typecheck", passed: true },
      ],
    }).ledger(),
  );
  const notDone = body.split("## Not done")[1].split("## ")[0];
  expect(notDone).toContain("Check `lint` failed");
  expect(notDone).not.toContain("typecheck");
});

test("ARK-T37 a last test result with no checks field is unknown, never a did-not-run claim, while a checks list without the check is", () => {
  const notDoneOf = (spec: RunSpec) =>
    buildBody(gappyRun(spec).ledger()).split("## Not done")[1].split("## ")[0];

  expect(notDoneOf({})).toContain("Check `typecheck` did not run");

  const old = notDoneOf({ withoutChecksField: true });
  expect(old).not.toContain("did not run");
  expect(old).not.toContain("Check `lint`");
  expect(old).toContain("P1 open: Missing guard");
});

test("ARK-T37 what is different lists the Change items whole and leaves the Risks list and nested items out", () => {
  const longItem = `In \`a.ts\`, ${"keep every word of this long item, ".repeat(8)}and end the sentence here.`;
  const body = buildBody(
    gappyRun({
      changeText: [
        `1. ${longItem} A second sentence stays out.`,
        "2. Enforce each kind:",
        "   - `bug`: a nested item stays out.",
        "3. Update the docs.",
        "",
        "Risks:",
        "",
        "- A session file may mix models. This risk stays out.",
        "- Another risk, which a clip would cut mid-sentence,",
      ].join("\n"),
    }).ledger(),
  );
  const different = body.split("## What is different")[1].split("## ")[0];
  const bullets = different.split("\n").filter((line) => line.startsWith("- "));

  expect(bullets).toEqual([`- ${longItem}`, "- Update the docs."]);
  expect(longItem.length).toBeGreaterThan(180);
});

test("ARK-T37 the evidence follows the ticket kind: perf names baseline.md and compare.md, refactor shows pass at base and head", () => {
  const perf = buildBody(gappyRun({ kind: "perf" }).ledger());
  const perfEvidence = perf.split("## Evidence")[1].split("## ")[0];
  expect(perfEvidence).toContain("baseline.md");
  expect(perfEvidence).toContain("compare.md");

  const refactor = buildBody(
    gappyRun({ kind: "refactor", evidence: { "ARK-T5": { base: "pass", head: "pass" } } }).ledger(),
  );
  expect(refactor.split("## Evidence")[1]).toContain("`ARK-T5`: base pass, head pass");
});

const templateSources: [string, string][] = [
  [
    ".gitlab/merge_request_templates/Default.md",
    "## Summary\n\n## Changes\n\n## Testing\n\n## Related\n",
  ],
  [".github/pull_request_template.md", "## Summary\n\n## Changes\n\n## Testing\n\n## Related\n"],
  [
    ".claude/rules/gitlab-mr-template.md",
    "# MR template\n\nWrite the description with these headings:\n\n```markdown\n## Summary\n\n## Changes\n\n## Testing\n\n## Related\n```\n",
  ],
];

for (const [path, text] of templateSources)
  test(`ARK-T37 the body fills the headings of ${path}`, () => {
    const run = gappyRun({
      repos: [
        {
          name: ".",
          base: { "README.md": "x\n", "cli/a.ts": "base\n", [path]: text },
          changes: { "cli/a.ts": "changed\n" },
        },
      ],
      steps: [{ id: "build", role: "implementer", repo: ".", needs: [] }],
    });
    const body = buildBody(run.ledger());
    const headings = ["## Summary", "## Changes", "## Testing", "## Related"].map((heading) =>
      body.indexOf(heading),
    );
    expect(
      headings.every((position) => position >= 0),
      headings.join(),
    ).toBe(true);
    expect(headings).toEqual([...headings].sort((a, b) => a - b));
    expect(body).not.toContain("## Problem");
    // The gaps stay visible under the template's Testing heading.
    expect(body.split("## Testing")[1].split("## Related")[0]).toContain("P1 open: Missing guard");
  });

/** The MR body that the frozen pre-change `description()` (commit 9b85039) writes for the criteria of a ledger. */
function pinnedBaseBody(ledger: Ledger): string {
  return description(
    { id: ledger.ticket!.id, title: ledger.ticket!.title },
    ledger.criteria.map((criterion) => criterion.id),
    new Map(ledger.ticket!.criteria.map((criterion) => [criterion.id, criterion])),
    [],
  );
}

test("ARK-T37 the body of the same run no longer pastes the AC text that the pinned-base builder pasted", async () => {
  const ledger = gappyRun().ledger();
  const before = pinnedBaseBody(ledger);
  const after = buildBody(ledger);

  // The base builder ran on this fixture and pasted the AC text, so the absence below is not vacuous.
  expect(before).toContain("Acceptance criteria this repo serves:");
  expect(before).toContain("AC-TEXT-MARKER AC1");
  expect(after).not.toContain("AC-TEXT-MARKER");
  expect(after).toContain("## Not done");

  // ARK_T37_EVIDENCE_DIR (a run folder's results/evidence/) keeps both outputs with the case result.
  const keep = process.env.ARK_T37_EVIDENCE_DIR;
  if (keep !== undefined) {
    mkdirSync(keep, { recursive: true });
    const note = (side: string, text: string) =>
      `<!-- ARK-T37 ${side}: same fixture (gappyRun in test/pr-writing.test.ts) -->\n\n${text}\n`;
    writeFileSync(
      join(keep, "ARK-T37-before.md"),
      note(
        "before, description() of commit 9b85039 (frozen in test/fixtures/pr-writing/old-description.ts)",
        before,
      ),
    );
    writeFileSync(join(keep, "ARK-T37-after.md"), note("after, buildBody()", after));
  }
});

// --- ARK-T38 ----------------------------------------------------------------------------------

const provenanceText = (handle: string, shape: string) =>
  `> Written by an AI agent on behalf of @${handle}${shape} @${handle} has not reviewed it yet.`;

test("ARK-T38 the provenance line follows the gates the human answered: spec, strategy, none; the strategy answer wins", () => {
  const human = (...gates: string[]) => gates.map((gate) => ({ gate, answer: "accept" }));
  const auto = (gate: string) => ({ gate, answer: "accept", by: "auto" });
  const rows: [string, { gate: string; answer: string; by?: string }[], string][] = [
    ["A criteria", human("criteria"), ", following their spec."],
    ["B strategy", human("strategy"), ", who shaped the solution."],
    ["C none", [], "."],
    ["D both", human("criteria", "strategy"), ", who shaped the solution."],
    [
      "E criteria and an auto strategy",
      [...human("criteria"), auto("strategy")],
      ", following their spec.",
    ],
    ["F both auto", [auto("criteria"), auto("strategy")], "."],
  ];
  for (const [name, gates, shape] of rows) {
    const body = buildBody(makeRun({ gates, prWriting: undefined }).ledger());
    expect({ name, first: firstContentLine(body) }).toEqual({
      name,
      first: provenanceText("cobekarhoff", shape),
    });
  }
});

test("ARK-T38 on GitLab the handle is the glab token owner", () => {
  process.env.FAKE_TOKEN_OWNER = "cobe.k";
  const body = buildBody(
    makeRun({ host: "gitlab", gates: [{ gate: "criteria", answer: "accept" }] }).ledger(),
  );
  expect(firstContentLine(body)).toBe(provenanceText("cobe.k", ", following their spec."));
});

// --- lint fixtures: ARK-T39, ARK-T55 ----------------------------------------------------------

const head = "abc1234def5678abc1234def5678abc1234def56";
const defaultTitle = "ARK-316: Fix stale MR bodies";

/** A ledger that breaks no check, at tier 1 (40 changed lines). A fixture overrides what its check needs. */
function baseLedger(overrides: Record<string, any> = {}): Ledger {
  const { files, dependsOn, repos, ticket, ...rest } = overrides;
  const repo = {
    repo: ".",
    branch: "ark/ARK-316-x",
    base: "main",
    baseSha: "b".repeat(40),
    head,
    shortstat: "2 files changed, 40 insertions(+)",
    commits: [{ sha: head, subject: "ARK-316: fix", message: "ARK-316: fix" }],
    files: files ?? [{ path: "cli/a.ts", status: "M" }],
    dependsOn: dependsOn ?? [],
    ...repos?.[0],
  };
  return {
    source: "run",
    host: "github",
    tokenOwner: "cobekarhoff",
    baseProbe: null,
    ticket: {
      id: "ARK-316",
      title: "t",
      summary: null,
      kind: "feature",
      problem: "",
      change: "",
      criteria: [],
      ...ticket,
    },
    trackerRefs: ["ARK-316"],
    plan: null,
    criteria: [],
    evidence: null,
    findings: [],
    hasReviewerStep: false,
    checks: [],
    reviewer: null,
    mergeOrder: ["."],
    repos: [repo],
    humanGates: ["criteria"],
    template: null,
    risk: {
      verification: 1,
      alignment: 1,
      impact: 1,
      rollback: 1,
      mean: 1,
      script: "low",
      reviewer: null,
      level: "low",
      door: "two-way",
      sensitiveHits: [],
      oneWayHits: [],
      deleted: [],
      unplanned: [],
    },
    prWriting: {
      reviewers: [],
      tier_floor: 0,
      sensitive_paths: [],
      one_way_paths: [],
      agent_authored: true,
    },
    run: null,
    ...rest,
  } as Ledger;
}

type Fixture = { body: string; input: LintInput };

function loadFixture(id: string, side: "fail" | "control"): Fixture {
  const folder = join(lintFixtures, id);
  const json = (name: string) =>
    existsSync(join(folder, name)) ? JSON.parse(readFileSync(join(folder, name), "utf8")) : {};
  const body = readFileSync(join(folder, `${side}.md`), "utf8");
  const { title, ...extra } = json(`${side}.input.json`);
  return {
    body,
    input: {
      body,
      title: title ?? defaultTitle,
      ledger: baseLedger({ ...json("ledger.json"), ...json(`${side}.ledger.json`) }),
      ...extra,
    },
  };
}

const lintOf = (fixture: Fixture, overrides: Partial<LintInput> = {}) =>
  lintBody({ ...fixture.input, ...overrides });

test("ARK-T39 the good body fails no check and every result has an id, a result and a reason", () => {
  const good = loadFixture("PROV01", "control");
  const results = lintOf(good, { diff: "+a plain line\n" });
  expect(results.length).toBeGreaterThan(20);
  for (const entry of results) {
    expect(["fail", "warn", "pass", "skip"]).toContain(entry.result);
    expect(entry.id).not.toBe("");
    expect(entry.reason).not.toBe("");
  }
  expect(results.filter((entry) => entry.result === "fail" || entry.result === "warn")).toEqual([]);
});

const decidable: [string, RegExp][] = [
  ["PROV01", /line \d+, not the first line/],
  ["PROV02", /the body has "Co-Authored-By: Claude/],
  ["TITLE01", /73 characters, 72 allowed/],
  ["SIZE01", /4 prose lines, tier 0 allows 3/],
  ["SIZE02", /tier 0 has no headings: line 2 is "## Problem"/],
  ["REF01", /does not name ARK-77/],
  ["REF02", /no "Depends on" line for ARK-311.*no merge order line/],
  ["VAL01", /no `- \[ \]` verify item/],
  ["VAL03", /Not done does not list: Slow path/],
  ["RISK02", /migration files \(db\/migrations\/001_add_column\.sql\)/],
  ["RISK03", /does not note the CI file \.github\/workflows\/ci\.yml/],
  ["FMT01", /hard-wrapped paragraph at line \d+/],
  ["FMT02", /token that starts with AKIA/],
  ["STALE01", /ledger head abc1234 of \. differs from the current head deadbee/],
];

for (const [id, reason] of decidable)
  test(`ARK-T39 ${id} fails on its fixture with a reason and passes on its corrected control`, () => {
    const failed = result(lintOf(loadFixture(id, "fail")), id);
    expect({ id, result: failed.result }).toEqual({ id, result: "fail" });
    expect(failed.reason).toMatch(reason);
    expect(result(lintOf(loadFixture(id, "control")), id)).toMatchObject({ id, result: "pass" });
  });

test("ARK-T39 the variants of each decidable check fail and the near misses pass", () => {
  const good = loadFixture("PROV01", "control");
  const control = (id: string) => loadFixture(id, "control");
  const lintLine = (
    fixture: Fixture,
    id: string,
    body = fixture.body,
    overrides: Partial<LintInput> = {},
  ) => result(lintOf(fixture, { body, ...overrides }), id);

  // PROV01: a first line that matches no variant.
  expect(
    lintLine(
      good,
      "PROV01",
      good.body.replace(/^> Written by an AI agent.*$/m, "> Written by an AI."),
    ),
  ).toMatchObject({ result: "fail", reason: expect.stringContaining("not a provenance variant") });

  // PROV02: Generated with in the body, and a trailer only in a commit of the range.
  expect(lintLine(good, "PROV02", `${good.body}\nGenerated with Claude Code\n`).reason).toContain(
    'the body has "Generated with Claude Code"',
  );
  const trailer = "ARK-316: fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>";
  const inRange = lintOf({
    ...good,
    input: {
      ...good.input,
      ledger: baseLedger({
        repos: [{ commits: [{ sha: head, subject: "ARK-316: fix", message: trailer }] }],
      }),
    },
  });
  expect(result(inRange, "PROV02")).toMatchObject({
    result: "fail",
    reason: expect.stringMatching(/commit abc1234 in the range has "Co-Authored-By/),
  });

  // TITLE01: a trailing period, and a broken prefix rule against a kept one.
  expect(
    lintLine(good, "TITLE01", good.body, { title: "ARK-316: Fix stale bodies." }).reason,
  ).toContain("ends with a period");
  const prefixed = (title: string) =>
    result(
      lintOf(good, {
        title,
        ledger: baseLedger({
          prWriting: {
            reviewers: [],
            tier_floor: 0,
            sensitive_paths: [],
            one_way_paths: [],
            agent_authored: true,
            title_prefix: "feat(TICKET): desc",
          },
        }),
      }),
      "TITLE01",
    );
  expect(prefixed("ARK-316: Fix stale bodies")).toMatchObject({
    result: "fail",
    reason: expect.stringContaining("prefix rule feat(TICKET): desc"),
  });
  expect(prefixed("feat(ARK-316): Fix stale bodies").result).toBe("pass");

  // SIZE01: the ceiling of each tier passes and one more line fails; fenced lines do not count.
  const tiers: [number, string, number][] = [
    [0, "5 insertions(+)", 3],
    [1, "40 insertions(+)", 12],
    [2, "200 insertions(+)", 40],
    [3, "450 insertions(+)", 150],
  ];
  const proseBody = (count: number) =>
    Array.from({ length: count }, (_, i) => `Line ${i + 1}.`).join("\n\n");
  for (const [tier, shortstat, ceiling] of tiers) {
    const ledger = baseLedger({ repos: [{ shortstat: `1 file changed, ${shortstat}` }] });
    const at = result(
      lintBody({ body: proseBody(ceiling), title: defaultTitle, ledger }),
      "SIZE01",
    );
    const over = result(
      lintBody({ body: proseBody(ceiling + 1), title: defaultTitle, ledger }),
      "SIZE01",
    );
    expect({ tier, at: at.result, over: over.result }).toEqual({ tier, at: "pass", over: "fail" });
    const fenced = `${proseBody(ceiling)}\n\n\`\`\`text\n${proseBody(20)}\n\`\`\`\n`;
    expect(result(lintBody({ body: fenced, title: defaultTitle, ledger }), "SIZE01").result).toBe(
      "pass",
    );
  }

  // SIZE02: a heading at tier 1 is fine.
  expect(lintLine(good, "SIZE02").result).toBe("skip");

  // REF01: a body that closes another ticket. REF02: a wrong dependency, and a reversed merge order.
  const refs = control("REF01");
  expect(lintLine(refs, "REF01", `${refs.body}\nCloses ARK-78\n`).reason).toContain(
    "closes ARK-78",
  );
  const dependency = control("REF02");
  expect(
    lintLine(
      dependency,
      "REF02",
      dependency.body.replace("Depends on ARK-311.", "Depends on ARK-312."),
    ).reason,
  ).toContain("names ARK-312");
  expect(
    lintLine(
      dependency,
      "REF02",
      dependency.body.replace(
        "Merge order: ARK-311, then ARK-316.",
        "Merge order: ARK-316, then ARK-311.",
      ),
    ).reason,
  ).toContain("the ledger holds ARK-311, then ARK-316");

  // RISK02 and RISK03 skip when the diff holds no such file.
  expect(lintLine(good, "RISK02").result).toBe("skip");
  expect(lintLine(good, "RISK03").result).toBe("skip");

  // FMT01: the same wrapped text in a fence, a list, a quote and a table passes.
  const wrapped =
    "An MR body listed a bug that was already fixed, so reviewers chased a problem that\nwas gone and lost an afternoon on it before anyone saw that the finding was old.";
  const wrap = (text: string) =>
    good.body.replace(
      "An MR body listed a bug that was already fixed, so reviewers chased a problem that was gone.",
      text,
    );
  expect(lintLine(good, "FMT01", wrap(wrapped)).result).toBe("fail");
  expect(lintLine(good, "FMT01", wrap(`\`\`\`text\n${wrapped}\n\`\`\``)).result).toBe("pass");
  expect(
    lintLine(
      good,
      "FMT01",
      wrap(
        wrapped
          .split("\n")
          .map((line) => `- ${line}`)
          .join("\n"),
      ),
    ).result,
  ).toBe("pass");
  expect(
    lintLine(
      good,
      "FMT01",
      wrap(
        wrapped
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n"),
      ),
    ).result,
  ).toBe("pass");
  expect(
    lintLine(
      good,
      "FMT01",
      wrap(
        wrapped
          .split("\n")
          .map((line) => `| ${line} |`)
          .join("\n"),
      ),
    ).result,
  ).toBe("pass");

  // FMT02: each of the five known prefixes fails, built at run time from synthetic values.
  const prefixes = [
    "AKIA" + "0".repeat(16),
    githubToken,
    `glpat${"-"}${"0".repeat(20)}`,
    `xox${"b"}-${"0".repeat(12)}`,
    `-----BEGIN ${"PRIVATE"} KEY-----`,
  ];
  for (const secret of prefixes)
    expect({
      secret: secret.slice(0, 5),
      result: lintLine(good, "FMT02", `${good.body}\n${secret}\n`).result,
    }).toEqual({ secret: secret.slice(0, 5), result: "fail" });

  // STALE01: the body hash. A hash of another body fails, the hash of this body passes.
  expect(
    lintLine(good, "STALE01", good.body, { bodyHash: hashBody("another body") }).reason,
  ).toContain("body hash");
  expect(lintLine(good, "STALE01", good.body, { bodyHash: hashBody(good.body) }).result).toBe(
    "pass",
  );
});

const judgment: [string, RegExp][] = [
  ["TITLE01-imperative", /"fixed" is not imperative: use "fix"/],
  ["DIFF01", /names cli\/gate\.ts, which the diff does not change/],
  ["EVID01", /kind bug needs evidence that shows fail at base and pass at head/],
  ["EVID03", /claims ARK-T5, and results\/evidence\/ has no folder for it/],
  ["VAL02", /no backticked command or no Expect clause/],
  ["RISK01", /too vague/],
  ["SEC01", /no Security note/],
  ["ELI01", /describes the code, not the problem/],
  ["VOICE01", /names who did the work \(run lead, the human\)/],
];

test("ARK-T55 the good body warns on none of the nine judgment checks", () => {
  const good = lintOf(loadFixture("PROV01", "control"), { diff: "+a plain line\n" });
  for (const [id] of judgment)
    expect({ id, result: result(good, id).result }).not.toEqual({ id, result: "warn" });
});

for (const [id, reason] of judgment)
  test(`ARK-T55 ${id} warns, never fails, on its fixture and passes on its corrected control`, () => {
    const warned = result(lintOf(loadFixture(id, "fail")), id);
    expect({ id, result: warned.result }).toEqual({ id, result: "warn" });
    expect(warned.reason).toMatch(reason);
    expect(result(lintOf(loadFixture(id, "control")), id)).toMatchObject({ id, result: "pass" });
  });

test("ARK-T55 TITLE01-imperative warns on Fixes, VAL02 on a command with no Expect, EVID01 on perf, EVID03 on a head SHA that differs", () => {
  const good = loadFixture("PROV01", "control");
  expect(
    result(lintOf(good, { title: "ARK-316: Fixes stale MR bodies" }), "TITLE01-imperative").result,
  ).toBe("warn");
  const noExpect = good.body.replace(/^- \[ \] .*$/m, "- [ ] `bun test`");
  expect(result(lintOf(good, { body: noExpect }), "VAL02").reason).toContain("`bun test`");

  const perf = loadFixture("EVID01", "control");
  const perfLedger = baseLedger({ ticket: { kind: "perf" }, evidence: [] });
  expect(result(lintBody({ ...perf.input, ledger: perfLedger }), "EVID01").reason).toContain(
    "baseline.md and compare.md",
  );
  const named = perf.body.replace(
    "## How to verify",
    "Perf: `results/baseline.md` and `results/compare.md`.\n\n## How to verify",
  );
  expect(
    result(lintBody({ ...perf.input, ledger: perfLedger, body: named }), "EVID01").result,
  ).toBe("pass");

  const stale = loadFixture("EVID03", "control");
  const other = baseLedger({
    evidence: [
      { testCase: "ARK-T5", base: "fail", head: "pass", sha: "deadbee0000", screenshots: [] },
    ],
  });
  expect(result(lintBody({ ...stale.input, ledger: other }), "EVID03").reason).toContain(
    "the head result is for deadbee",
  );
});

const lines = (count: number, sensitive: string[] = [], floor = 0) =>
  baseLedger({
    repos: [{ shortstat: `1 file changed, ${count} insertions(+)` }],
    risk: { ...baseLedger().risk, sensitiveHits: sensitive },
    prWriting: {
      reviewers: [],
      tier_floor: floor,
      sensitive_paths: sensitive,
      one_way_paths: [],
      agent_authored: true,
    },
  });

test("ARK-T55 the tier follows the changed lines, a sensitive path, a raise with a reason and tier_floor", () => {
  const boundaries: [number, 0 | 1 | 2 | 3][] = [
    [20, 0],
    [21, 1],
    [149, 1],
    [150, 2],
    [399, 2],
    [400, 3],
  ];
  for (const [count, tier] of boundaries)
    expect({ count, tier: tierOfLedger(lines(count)).tier }).toEqual({ count, tier });

  // A sensitive path lifts a 5-line diff above tier 0 and names the path; no reason line is needed.
  const sensitive = tierOfLedger(lines(5, ["cli/gate.ts"]));
  expect(sensitive.tier).toBe(1);
  expect(sensitive.reason).toContain("cli/gate.ts");

  // The discretionary raise on a non-sensitive 5-line diff needs a reason line.
  expect(tierOfLedger(lines(5)).tier).toBe(0);
  expect(tierOfLedger(lines(5), "raise: parser change").tier).toBe(1);
  expect(tierOfLedger(lines(5), "").tier).toBe(0);

  // The floor lifts a small diff and never lowers a large one.
  expect(tierOfLedger(lines(5, [], 2)).tier).toBe(2);
  expect(tierOfLedger(lines(400, [], 1)).tier).toBe(3);
});

// --- ARK-T56 ----------------------------------------------------------------------------------

const goodBody = loadFixture("PROV01", "control").body;
const postedTitle = defaultTitle;

type HostName = "github" | "gitlab";

/** The fake host state of one branch: `bodies` are the open MRs on it. */
function postScenario(host: HostName, existingBody?: string) {
  const directory = mkdtempSync(join(tmpdir(), "pr-writing-post-"));
  const repo = directory.split("/").at(-1)!;
  const branch = "ark/ARK-316-x";
  const url =
    host === "github"
      ? `https://github.com/org/${repo}/pull/9`
      : `https://gitlab.com/org/${repo}/-/merge_requests/9`;
  const mergeRequest = { number: 9, url, head: branch, repo, body: existingBody ?? "" };
  const state = () =>
    existsSync(`${logFile}.state`) ? JSON.parse(readFileSync(`${logFile}.state`, "utf8")) : [];
  if (existingBody !== undefined) writeFileSync(`${logFile}.state`, JSON.stringify([mergeRequest]));
  const bodyFile = join(directory, "generated.md");
  /** Makes the directory a git repo: `main`, then the branch with one more commit that adds `added` to cli/a.ts. Returns its head. */
  const commitBranch = (added: string) => {
    git(directory, "init", "-b", "main");
    mkdirSync(join(directory, "cli"));
    writeFileSync(join(directory, "cli/a.ts"), "base\n");
    git(directory, "add", ".");
    git(directory, "commit", "-m", "base");
    git(directory, "checkout", "-b", branch);
    writeFileSync(join(directory, "cli/a.ts"), `${added}\n`);
    git(directory, "commit", "-am", "ARK-316: change");
    return git(directory, "rev-parse", "HEAD");
  };
  const post = (
    body: string,
    options: { reviewers?: string[]; dryRun?: boolean; ledger?: Ledger } = {},
  ) => {
    writeFileSync(bodyFile, body);
    const driven = drive<{ action: string }>("post", {
      host,
      directory,
      branch,
      base: "main",
      title: postedTitle,
      bodyFile,
      ledger: options.ledger ?? baseLedger(),
      reviewers: options.reviewers ?? [],
      dryRun: options.dryRun,
    });
    if (driven.error !== undefined) throw new Error(driven.error);
    return driven;
  };
  return { directory, mergeRequest, state, post, commitBranch };
}

const changedBody = goodBody.replace(
  "rebuilt from the run on every new head",
  "rebuilt from the run on every new head, always",
);
const withHumanText = (
  generated: string,
  before = "Hand written intro.\n\n- [x] Tested locally\n\n",
  after = "\n\nHand written footer.\n",
) => `${before}${generated}${after}`;

for (const host of ["github", "gitlab"] as HostName[]) {
  test(`ARK-T56 post creates one MR with the body from the file on ${host}`, () => {
    const { post, state } = postScenario(host);
    expect(post(goodBody).value!.action).toBe("created");
    expect(loggedCalls().filter((call) => call.argv.includes("create"))).toHaveLength(1);
    expect(state()).toHaveLength(1);
    expect(state()[0].body).toBe(goodBody);
  });

  test(`ARK-T56 post replaces only the text between the markers and keeps a human tick on ${host}`, () => {
    const { post, state } = postScenario(host, withHumanText(goodBody));
    expect(post(changedBody).value!.action).toBe("updated");
    expect(state()).toHaveLength(1);
    expect(state()[0].body).toBe(withHumanText(changedBody));
    expect(state()[0].body).toContain("- [x] Tested locally");
  });

  test(`ARK-T56 a failing host probe writes nothing and reports the failure on ${host}`, () => {
    process.env.FAKE_PROBE_FAIL = "1";
    const { post } = postScenario(host);
    expect(() => post(goodBody)).toThrow(/could not ask .* nothing was written/);
    expect(writeCalls()).toEqual([]);
  });

  test(`ARK-T56 an MR that appears between the two probes turns the create into an update on ${host}`, () => {
    const scenario = postScenario(host);
    process.env.FAKE_RACE_MR = JSON.stringify({
      ...scenario.mergeRequest,
      body: withHumanText(goodBody),
    });
    expect(scenario.post(changedBody).value!.action).toBe("updated");
    expect(loggedCalls().filter((call) => call.argv.includes("create"))).toHaveLength(0);
    expect(scenario.state()).toHaveLength(1);
    expect(scenario.state()[0].body).toBe(withHumanText(changedBody));
  });

  test(`ARK-T56 an MR whose body a person edits between the two probes keeps the edit on ${host}`, () => {
    const scenario = postScenario(host, withHumanText(goodBody));
    const edited = withHumanText(
      goodBody,
      "Edited while the post ran.\n\n- [x] Checked by hand\n\n",
    );
    process.env.FAKE_EDIT_BODY = edited;
    expect(scenario.post(changedBody).value!.action).toBe("updated");
    expect(scenario.state()).toHaveLength(1);
    expect(scenario.state()[0].body).toBe(
      withHumanText(changedBody, "Edited while the post ran.\n\n- [x] Checked by hand\n\n"),
    );
  });

  test(`ARK-T56 STALE01 refuses the post when the head changed after the ledger, and SEC01 only warns on ${host}`, () => {
    const stale = postScenario(host);
    const head = stale.commitBranch("changed");
    const current = baseLedger({ repos: [{ head }] });
    expect(() => stale.post(goodBody, { ledger: baseLedger() })).toThrow(
      /STALE01.*differs from the current head/,
    );
    expect(writeCalls()).toEqual([]);
    expect(stale.post(goodBody, { ledger: current }).value!.action).toBe("created");

    const secure = postScenario(host);
    const secureHead = secure.commitBranch("const key = process.env.API_TOKEN;");
    const posted = secure.post(goodBody, { ledger: baseLedger({ repos: [{ head: secureHead }] }) });
    expect(posted.value!.action).toBe("created");
    expect(posted.err.join("\n")).toMatch(/warning: SEC01/);
  });

  test(`ARK-T56 a lint fail in the generated region, or in the merged body outside the markers, refuses the post on ${host}`, () => {
    const leaky = goodBody.replace("Refs: ARK-316.", `Refs: ARK-316. Key ${githubToken}`);
    const create = postScenario(host);
    expect(() => create.post(leaky)).toThrow(/FMT02/);
    expect(writeCalls()).toEqual([]);

    const update = postScenario(host, withHumanText(goodBody));
    expect(() => update.post(leaky)).toThrow(/FMT02/);
    expect(writeCalls()).toEqual([]);

    // The replacement is clean, a person pasted the token outside the markers: the final body fails.
    const pasted = withHumanText(goodBody, `Pasted by hand: ${githubToken}\n\n`);
    const outside = postScenario(host, pasted);
    expect(() => outside.post(changedBody)).toThrow(/FMT02/);
    expect(outside.state()[0].body).toBe(pasted);
    expect(writeCalls()).toEqual([]);
  });

  test(`ARK-T56 the assignee is the token owner and reviewers never include the author on ${host}`, () => {
    const option = (call: LoggedCall, name: string) =>
      call.argv.includes(name) ? call.argv[call.argv.indexOf(name) + 1] : undefined;
    const run = (reviewers: string[]) => {
      logFile = join(mkdtempSync(join(tmpdir(), "pr-writing-log-")), "calls.ndjson");
      process.env.FAKE_LOG = logFile;
      const { post } = postScenario(host);
      const { err } = post(goodBody, { reviewers });
      const [call] = loggedCalls().filter((entry) => entry.argv.includes("create"));
      return {
        assignee: option(call, "--assignee"),
        reviewer: option(call, "--reviewer"),
        warned: err.some((line) => line.includes("only the author")),
      };
    };
    expect(run(["alice", "bob"])).toEqual({
      assignee: "cobekarhoff",
      reviewer: "alice,bob",
      warned: false,
    });
    expect(run(["cobekarhoff"])).toEqual({
      assignee: "cobekarhoff",
      reviewer: undefined,
      warned: true,
    });
    expect(run(["cobekarhoff", "alice"])).toEqual({
      assignee: "cobekarhoff",
      reviewer: "alice",
      warned: false,
    });
  });

  test(`ARK-T56 --dry-run prints the host call and writes nothing, for create and update on ${host}`, () => {
    const create = postScenario(host);
    const created = create.post(goodBody, { dryRun: true });
    expect(created.value!.action).toBe("dry-run");
    // Both probes are reads and are printed too, in order, before the write.
    const probe =
      host === "github"
        ? /dry-run: gh pr list --head/
        : /dry-run: glab api projects\/:fullpath\/merge_requests\?state=opened&source_branch=/;
    const lines = created.out.filter((line) => line.startsWith("dry-run:"));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(probe);
    expect(lines[1]).toMatch(probe);
    expect(lines[2]).toMatch(
      host === "github" ? /dry-run: gh pr create/ : /dry-run: glab mr create/,
    );
    expect(writeCalls()).toEqual([]);
    expect(create.state()).toEqual([]);

    const original = withHumanText(goodBody);
    const update = postScenario(host, original);
    const updated = update.post(changedBody, { dryRun: true });
    expect(updated.out.join("\n")).toMatch(
      host === "github" ? /dry-run: gh pr edit 9/ : /dry-run: glab mr update 9/,
    );
    expect(writeCalls()).toEqual([]);
    expect(update.state()[0].body).toBe(original);
  });

  test(`ARK-T56 an old body that quotes the markers inline and holds AKIA and Co-Authored-By words is replaced whole and lints clean on ${host}`, () => {
    const old =
      "Wraps the text in `<!-- pr-writing:begin -->` and `<!-- pr-writing:end -->` markers.\n\n- AC1: reject AKIA keys.\n- AC2: no Co-Authored-By trailer.\n";
    const { post, state } = postScenario(host, old);
    expect(post(goodBody).value!.action).toBe("updated");
    expect(state()[0].body).toBe(goodBody);
  });
}

// --- ARK-T58 ----------------------------------------------------------------------------------

const configBase = () => ({
  workspace: tmpdir(),
  ticket_source: "local",
  suites: [{ name: "s", level: "unit", repo: ".", command: "c", parser: "bun" }],
  roles: Object.fromEntries(
    ["implementer", "validator", "reviewer"].map((role) => [role, { harness: "h", model: "m" }]),
  ),
});

function loadWith(block: Record<string, unknown> | undefined) {
  tempArkHome();
  writeProject("demo", { ...configBase(), ...(block === undefined ? {} : { pr_writing: block }) });
  return loadConfig("demo").pr_writing;
}

const fullBlock = {
  reviewers: ["alice", "bob"],
  tier_floor: 1,
  sensitive_paths: ["cli/gate.ts"],
  one_way_paths: ["cli/events.ts"],
  agent_authored: false,
  title_prefix: "feat(TICKET): desc",
};

test("ARK-T58 a pr_writing block loads with its six keys, and defaults fill a partial or missing block", () => {
  expect(loadWith(fullBlock)).toEqual(fullBlock);
  const defaults = {
    reviewers: [],
    tier_floor: 0,
    sensitive_paths: [],
    one_way_paths: [],
    agent_authored: true,
  };
  expect(loadWith({ reviewers: ["alice"] })).toEqual({ ...defaults, reviewers: ["alice"] });
  expect(loadWith(undefined)).toEqual(defaults);
  expect(loadWith({ tier_floor: 0 }).tier_floor).toBe(0);
  expect(loadWith({ tier_floor: 3 }).tier_floor).toBe(3);
});

test("ARK-T58 a bad pr_writing value is refused with a message that names its key", () => {
  const bad: [string, unknown][] = [
    ["tier_floor", 5],
    ["tier_floor", -1],
    ["tier_floor", 1.5],
    ["tier_floor", "high"],
    ["reviewers", "alice"],
    ["reviewers", [1, 2]],
    ["sensitive_paths", "cli/*"],
    ["one_way_paths", {}],
    ["agent_authored", "yes"],
    ["title_prefix", 42],
  ];
  for (const [key, value] of bad) {
    tempArkHome();
    writeProject("demo", { ...configBase(), pr_writing: { ...fullBlock, [key]: value } });
    expect({ key, value, ...refusedLoad() }).toMatchObject({
      key,
      value,
      message: expect.stringContaining(`pr_writing.${key}`),
    });
  }
});

function refusedLoad(): { message: string } {
  try {
    loadConfig("demo");
  } catch (err) {
    return { message: (err as Error).message };
  }
  return { message: "loaded" };
}

// --- ARK-T45 ----------------------------------------------------------------------------------

const sensitiveConfig = {
  reviewers: [],
  tier_floor: 0,
  sensitive_paths: ["cli/gate.ts"],
  one_way_paths: ["cli/events.ts"],
  agent_authored: true,
};

const riskBase = {
  "README.md": "x\n",
  "cli/a.ts": "base\n",
  "cli/gate.ts": "base\n",
  "cli/events.ts": "base\n",
  "cli/old.ts": "base\n",
};
const withEvidence = { "ARK-T1": { base: "fail", head: "pass" } };

const reviewerBlock = (level: "low" | "high" | "medium", extra: string[] = []) => {
  const ratings =
    level === "low"
      ? ["good", "good", "good", "good"]
      : level === "high"
        ? ["poor", "poor", "poor", "poor"]
        : ["good", "decent", "poor", "poor"];
  return [
    "### P3: Naming\n",
    "## Merge risk",
    "",
    `- Verification: ${ratings[0]} - checked`,
    `- Alignment: ${ratings[1]} - checked`,
    `- Impact: ${ratings[2]} - checked`,
    `- Rollback cost: ${ratings[3]} - checked`,
    "- Door: one-way (recovery: restore events.ndjson from the run folder backup)",
    "- Blast radius: every run that reads events",
    ...extra,
    "",
  ].join("\n");
};

type RiskRow = { name: string; spec: RunSpec; scores: [number, number, number, number] };

/** One input changed from a baseline run that scores 1/1/1/1: all ACs passing and evidenced, nothing else. */
const baselineChanges = { "cli/a.ts": "changed\n" };
const riskRows: RiskRow[] = [
  { name: "baseline", spec: {}, scores: [1, 1, 1, 1] },
  {
    name: "an AC without evidence",
    spec: {
      criteria: [
        { id: "AC1", status: "passing", verifiedBy: ["ARK-T1"] },
        { id: "AC2", status: "passing", verifiedBy: ["ARK-T2"] },
      ],
    },
    scores: [2, 1, 1, 1],
  },
  {
    name: "an AC not passing",
    spec: {
      criteria: [
        { id: "AC1", status: "passing", verifiedBy: ["ARK-T1"] },
        { id: "AC2", status: "failing", verifiedBy: ["ARK-T1"] },
      ],
    },
    scores: [3, 1, 1, 1],
  },
  {
    name: "one unplanned source file",
    spec: {
      repos: [{ name: ".", base: riskBase, changes: { ...baselineChanges, "cli/b.ts": "b\n" } }],
    },
    scores: [1, 2, 1, 1],
  },
  {
    name: "three unplanned source files",
    spec: {
      repos: [
        {
          name: ".",
          base: riskBase,
          changes: { ...baselineChanges, "cli/b.ts": "b\n", "cli/c.ts": "c\n", "cli/d.ts": "d\n" },
        },
      ],
    },
    scores: [1, 3, 1, 1],
  },
  {
    name: "unplanned files under test/ and docs/",
    spec: {
      repos: [
        {
          name: ".",
          base: riskBase,
          changes: { ...baselineChanges, "test/x.test.ts": "t\n", "docs/y.md": "d\n" },
        },
      ],
    },
    scores: [1, 1, 1, 1],
  },
  {
    name: "one sensitive hit",
    spec: {
      where: "cli/a.ts, cli/gate.ts",
      repos: [{ name: ".", base: riskBase, changes: { ...baselineChanges, "cli/gate.ts": "g\n" } }],
    },
    scores: [1, 1, 2, 1],
  },
  {
    name: "a sensitive hit with interface callers",
    spec: {
      where: "cli/a.ts, cli/gate.ts",
      interfaces: [{ name: "gate", callers: ["cli/run.ts"] }],
      repos: [{ name: ".", base: riskBase, changes: { ...baselineChanges, "cli/gate.ts": "g\n" } }],
    },
    scores: [1, 1, 3, 1],
  },
  {
    name: "a one-way hit",
    spec: {
      where: "cli/a.ts, cli/events.ts",
      repos: [
        { name: ".", base: riskBase, changes: { ...baselineChanges, "cli/events.ts": "e\n" } },
      ],
    },
    scores: [1, 1, 1, 2],
  },
  {
    name: "a deleted file",
    spec: {
      where: "cli/a.ts, cli/old.ts",
      repos: [{ name: ".", base: riskBase, changes: { ...baselineChanges, "cli/old.ts": null } }],
    },
    scores: [1, 1, 1, 2],
  },
  {
    name: "a one-way hit and a deleted file",
    spec: {
      where: "cli/a.ts, cli/events.ts, cli/old.ts",
      repos: [
        {
          name: ".",
          base: riskBase,
          changes: { ...baselineChanges, "cli/events.ts": "e\n", "cli/old.ts": null },
        },
      ],
    },
    scores: [1, 1, 1, 3],
  },
];

test("ARK-T45 each isolated input scores only its own category good 1, decent 2 or poor 3", () => {
  for (const { name, spec, scores } of riskRows) {
    const ledger = makeRun({
      evidence: withEvidence,
      prWriting: sensitiveConfig,
      ...spec,
    }).ledger();
    const { verification, alignment, impact, rollback } = ledger.risk;
    expect({ name, scores: [verification, alignment, impact, rollback] }).toEqual({ name, scores });
  }
});

const mainChanges = {
  "cli/gate.ts": "g\n",
  "cli/events.ts": "e\n",
  "cli/old.ts": null,
  "cli/helpers.ts": "h\n",
  "test/x.test.ts": "t\n",
  "docs/y.md": "d\n",
};

function mainRun(spec: RunSpec = {}) {
  return makeRun({
    evidence: withEvidence,
    prWriting: sensitiveConfig,
    where: "cli/gate.ts, cli/events.ts, cli/old.ts",
    interfaces: [{ name: "gate", callers: ["cli/run.ts"] }],
    steps: [
      { id: "build", role: "implementer", repo: ".", needs: [] },
      { id: "review", role: "reviewer", repo: ".", needs: ["build"] },
    ],
    repos: [{ name: ".", base: riskBase, changes: mainChanges }],
    findings: {
      "review-1.md": reviewerBlock("high"),
      "review-2.md": reviewerBlock("low", [
        "- Not in plan: cli/helpers.ts - shared helper used by the gate change",
      ]),
    },
    ...spec,
  });
}

test("ARK-T45 the risk section shows script and reviewer levels, the higher wins, and lists door, blast radius and unplanned files", () => {
  const ledger = mainRun().ledger();
  expect(ledger.risk).toMatchObject({
    verification: 1,
    alignment: 2,
    impact: 3,
    rollback: 3,
    script: "medium",
    reviewer: "low",
    level: "medium",
  });
  const body = buildBody(ledger);
  const risk = body.split("## Risk and revert")[1].split("## ")[0];

  expect(risk).toMatch(/Merge risk: medium \(script medium, reviewer low\)\. The levels differ/);
  expect(risk).toContain("The higher level is shown");
  expect(risk).toMatch(/- Verification: good\./);
  expect(risk).toMatch(/- Alignment: decent/);
  expect(risk).toMatch(/- Impact: poor/);
  expect(risk).toMatch(/- Rollback cost: poor/);
  expect(risk).toMatch(
    /Door: one-way\. Recovery: restore events\.ndjson from the run folder backup/,
  );
  expect(risk).toMatch(/Blast radius: every run that reads events/);
  const unplanned = risk.split("Also changed, not in plan:")[1].split("```")[0];
  expect(unplanned).toContain("`cli/helpers.ts`: shared helper used by the gate change");
  expect(unplanned).not.toContain("test/x.test.ts");
  expect(unplanned).not.toContain("docs/y.md");
});

test("ARK-T45 the reviewer level comes from the latest findings file and wins when higher", () => {
  const swapped = mainRun({
    findings: {
      "review-1.md": reviewerBlock("low"),
      "review-2.md": reviewerBlock("high", [
        "- Not in plan: cli/helpers.ts - shared helper used by the gate change",
      ]),
    },
  }).ledger();
  expect(swapped.risk).toMatchObject({ script: "medium", reviewer: "high", level: "high" });
  expect(buildBody(swapped)).toContain("Merge risk: high (script medium, reviewer high)");

  const equal = mainRun({
    findings: {
      "review-2.md": reviewerBlock("medium", [
        "- Not in plan: cli/helpers.ts - shared helper used by the gate change",
      ]),
    },
  }).ledger();
  const equalRisk = buildBody(equal).split("## Risk and revert")[1];
  expect(equalRisk).toContain("Merge risk: medium (script medium, reviewer medium)");
  expect(equalRisk).not.toContain("The levels differ");
});

test("ARK-T45 the reviewer block comes from reviewer-step findings files only, never from a validator report or live-check file", () => {
  const ledger = mainRun({
    findings: {
      "review-1.md": reviewerBlock("high"),
      "review-2.md": reviewerBlock("low", [
        "- Not in plan: cli/helpers.ts - shared helper used by the gate change",
      ]),
      // Sorts after the review files by name, carries no block, and is not a file of the reviewer step.
      "pr-writing-tests.md": "# pr-writing-tests (validator)\n\n### P1: A product defect\n",
      "zz-live-check.md": "No findings.\n",
    },
  }).ledger();
  expect(ledger.risk).toMatchObject({ reviewer: "low", level: "medium" });
  expect(buildBody(ledger)).toContain("Merge risk: medium (script medium, reviewer low)");
  expect(
    lintBody({ body: buildBody(ledger), title: defaultTitle, ledger }).find(
      (c) => c.id === "RISK04",
    )!.result,
  ).toBe("pass");
});

test("ARK-T45 the script level is low below 1.5, medium to below 2.25, high from 2.25, at the tuples either side of each threshold", () => {
  const events = {
    where: "cli/a.ts, cli/events.ts, cli/old.ts",
    repos: [
      {
        name: ".",
        base: riskBase,
        changes: { ...baselineChanges, "cli/events.ts": "e\n", "cli/old.ts": null },
      },
    ],
  };
  const rows: [string, RunSpec, [number, number, number, number], Ledger["risk"]["script"]][] = [
    [
      "(1,1,3,1) 19/13",
      { evidence: withEvidence, prWriting: sensitiveConfig, ...events },
      [1, 1, 1, 3],
      "low",
    ],
    [
      "(1,1,2,3) 20/13",
      {
        evidence: withEvidence,
        prWriting: sensitiveConfig,
        where: "cli/a.ts, cli/old.ts",
        repos: [
          {
            name: ".",
            base: riskBase,
            changes: {
              ...baselineChanges,
              "cli/old.ts": null,
              "cli/b.ts": "b\n",
              "cli/c.ts": "c\n",
              "cli/d.ts": "d\n",
            },
          },
        ],
      },
      [1, 3, 1, 2],
      "medium",
    ],
    ["(1,3,3,2) 29/13", {}, [1, 2, 3, 3], "medium"],
  ];
  for (const [name, spec, [verification, alignment, impact, rollback], level] of rows) {
    const ledger = (Object.keys(spec).length === 0 ? mainRun() : makeRun(spec)).ledger();
    expect({
      name,
      scores: [
        ledger.risk.verification,
        ledger.risk.alignment,
        ledger.risk.impact,
        ledger.risk.rollback,
      ],
      level: ledger.risk.script,
    }).toEqual({ name, scores: [verification, alignment, impact, rollback], level });
  }
  // (2,3,2,2) 30/13: the main fixture with one AC without evidence and the one-way hit removed.
  const high = mainRun({
    criteria: [
      { id: "AC1", status: "passing", verifiedBy: ["ARK-T1"] },
      { id: "AC2", status: "passing", verifiedBy: ["ARK-T2"] },
    ],
    prWriting: { ...sensitiveConfig, one_way_paths: [] },
  }).ledger();
  expect(high.risk).toMatchObject({
    verification: 2,
    alignment: 2,
    impact: 3,
    rollback: 2,
    script: "high",
  });
});

test("ARK-T45 a run with no one-way hit shows Door: two-way", () => {
  const ledger = makeRun({ evidence: withEvidence, prWriting: sensitiveConfig }).ledger();
  expect(buildBody(ledger)).toMatch(/Door: two-way/);
});

test("ARK-T45 a file merged in from the target branch is neither listed as unplanned nor counted in the shortstat", () => {
  const run = makeRun();
  const repo = run.paths["."];
  const recordedBase = git(repo, "rev-parse", "HEAD~1");
  // main moves on after the branch point; the branch merges it, as `ark worktree sync` does.
  git(repo, "checkout", "-q", "main");
  writeFileSync(join(repo, "cli/main-only.ts"), "from main\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "main moves on");
  git(repo, "update-ref", "refs/remotes/origin/main", "main");
  git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(repo, "checkout", "-q", "ark/ARK-9-x");
  git(repo, "merge", "--no-ff", "-m", "Merge origin/main", "main");
  const events = join(run.directory, "events.ndjson");
  writeFileSync(
    events,
    readFileSync(events, "utf8").replace('"base":"main"', `"base":"${recordedBase}"`),
  );

  const ledger = run.ledger();
  expect(ledger.repos[0].files.map((file) => file.path)).toEqual(["cli/a.ts"]);
  expect(ledger.repos[0].shortstat).toMatch(/^1 file changed/);
  expect(ledger.risk.unplanned).toEqual([]);
  expect(buildBody(ledger)).not.toContain("main-only.ts");
});

// --- ARK-T46 ----------------------------------------------------------------------------------

type ReviewRun = {
  block: boolean;
  oneWay: boolean;
  recovery: boolean;
  unplanned: "none" | "no reason" | "all reasons";
  reviewerStep?: boolean;
};

function reviewedBody({ block, oneWay, recovery, unplanned, reviewerStep = true }: ReviewRun) {
  const lines = [
    "### P3: Naming",
    "",
    ...(block
      ? [
          "## Merge risk",
          "",
          "- Verification: good - ok",
          "- Alignment: good - ok",
          "- Impact: good - ok",
          "- Rollback cost: good - ok",
          `- Door: ${oneWay ? `one-way${recovery ? " (recovery: restore the file from git)" : ""}` : "two-way"}`,
          "- Blast radius: small",
          ...(unplanned === "all reasons"
            ? [
                "- Not in plan: cli/b.ts - used by the change",
                "- Not in plan: cli/c.ts - used by the change",
              ]
            : unplanned === "no reason"
              ? ["- Not in plan: cli/b.ts - used by the change"]
              : []),
          "",
        ]
      : []),
  ];
  const changes: Record<string, string> = {
    "cli/a.ts": "changed\n",
    ...(oneWay ? { "cli/events.ts": "e\n" } : {}),
    ...(unplanned === "none" ? {} : { "cli/b.ts": "b\n", "cli/c.ts": "c\n" }),
  };
  const run = makeRun({
    evidence: withEvidence,
    where: oneWay ? "cli/a.ts, cli/events.ts" : "cli/a.ts",
    prWriting: { ...sensitiveConfig, sensitive_paths: [] },
    steps: [
      { id: "build", role: "implementer", repo: ".", needs: [] },
      ...(reviewerStep ? [{ id: "review", role: "reviewer", repo: ".", needs: ["build"] }] : []),
    ],
    repos: [{ name: ".", base: riskBase, changes }],
    findings: reviewerStep ? { "review-1.md": lines.join("\n") } : {},
  });
  const ledger = run.ledger();
  return lintBody({ body: buildBody(ledger), title: defaultTitle, ledger }).find(
    (entry) => entry.id === "RISK04",
  )!;
}

test("ARK-T46 RISK04 fails when the latest findings file of the reviewer step has no Merge risk block", () => {
  expect(
    reviewedBody({ block: false, oneWay: false, recovery: false, unplanned: "none" }),
  ).toMatchObject({ result: "fail", reason: expect.stringContaining("no ## Merge risk block") });
});

test("ARK-T46 RISK04 fails when Door: one-way names no recovery", () => {
  expect(
    reviewedBody({ block: true, oneWay: true, recovery: false, unplanned: "none" }),
  ).toMatchObject({
    result: "fail",
    reason: expect.stringContaining("Door: one-way names no recovery"),
  });
});

test("ARK-T46 RISK04 fails when a file under Also changed, not in plan has no reason", () => {
  expect(
    reviewedBody({ block: true, oneWay: false, recovery: false, unplanned: "no reason" }),
  ).toMatchObject({
    result: "fail",
    reason: expect.stringContaining("an unplanned file has no reason"),
  });
});

test("ARK-T46 RISK04 passes a good body and does not require the block of a run with no reviewer step", () => {
  expect(
    reviewedBody({ block: true, oneWay: true, recovery: true, unplanned: "all reasons" }).result,
  ).toBe("pass");
  expect(
    reviewedBody({
      block: false,
      oneWay: false,
      recovery: false,
      unplanned: "none",
      reviewerStep: false,
    }).result,
  ).toBe("skip");
});

// --- ARK-T47 ----------------------------------------------------------------------------------

type EvidenceSpec = NonNullable<RunSpec["evidence"]>;

const evidenceWith = (shotsA: string[], shotsB: string[]): EvidenceSpec => ({
  "ARK-T1": { base: "fail", head: "pass", shots: shotsA },
  "ARK-T2": {
    base: "fail",
    head: "pass",
    sha: "feedbeefcafe0123456789abcdef0123456789ab",
    shots: shotsB,
  },
});

const evidenceSection = (body: string) => body.split("## Evidence")[1]?.split("\n## ")[0] ?? "";
const screenshotNames = (text: string) => text.match(/[^\s`,()]+\.png/g) ?? [];

/** The body of a run with evidence, with its lint on the same ledger. */
function evidenceBody(evidence: EvidenceSpec | null) {
  const ledger = makeRun({ evidence, prWriting: { ...sensitiveConfig, tier_floor: 1 } }).ledger();
  const body = buildBody(ledger);
  return {
    body,
    ledger,
    evid04: (text = body) =>
      result(lintBody({ body: text, title: defaultTitle, ledger }), "EVID04"),
  };
}

test("ARK-T47 the Evidence section has one line for each test case and one screenshot for each flow, five at most", () => {
  const sevenOverSix = evidenceBody(
    evidenceWith(
      ["login-1.png", "login-2.png", "search.png", "cart.png"],
      ["checkout.png", "profile.png", "logout.png"],
    ),
  );
  const section = evidenceSection(sevenOverSix.body);
  expect(section).toContain("`ARK-T1`: base fail, head pass @ abc1234");
  expect(section).toContain("`ARK-T2`: base fail, head pass @ feedbee");
  const shown = screenshotNames(section).map((path) => path.split("/").at(-1));
  expect(shown).toHaveLength(5);
  expect(new Set(shown.map((name) => name!.replace(/-\d+\.png$|\.png$/, ""))).size).toBe(5);
  expect(shown).toContain("login-1.png");
  expect(shown).not.toContain("login-2.png");
  expect(shown).not.toContain("search.png");
  expect(section).toMatch(/kept in the run folder and not uploaded/);

  const threeFlows = evidenceBody(
    evidenceWith(
      ["alpha-1.png", "alpha-2.png", "alpha-3.png", "beta-1.png", "beta-2.png"],
      ["gamma-1.png", "gamma-2.png"],
    ),
  );
  expect(
    screenshotNames(evidenceSection(threeFlows.body)).map((path) => path.split("/").at(-1)),
  ).toEqual(["alpha-1.png", "beta-1.png", "gamma-1.png"]);
});

test("ARK-T47 EVID04 passes the complete body, fails with no section, warns past five screenshots", () => {
  const { body, evid04 } = evidenceBody(
    evidenceWith(
      ["login-1.png", "login-2.png", "search.png", "cart.png"],
      ["checkout.png", "profile.png", "logout.png"],
    ),
  );
  expect(evid04().result).toBe("pass");

  const stripped = body.replace(/## Evidence[\s\S]*?(?=## How to verify)/, "");
  expect(evid04(stripped)).toMatchObject({
    result: "fail",
    reason: expect.stringContaining("no ## Evidence section"),
  });

  const naming = (count: number) =>
    body.replace(
      /^- Screenshots.*$/m,
      `- Screenshots, kept in the run folder and not uploaded: ${Array.from({ length: count }, (_, i) => `\`shot-${i}.png\``).join(", ")}`,
    );
  for (const [count, expected] of [
    [5, "pass"],
    [6, "warn"],
    [7, "warn"],
  ] as const)
    expect({ count, result: evid04(naming(count)).result }).toEqual({ count, result: expected });
});

test("ARK-T47 a run with no results/evidence/ needs no Evidence section", () => {
  const { body, evid04 } = evidenceBody(null);
  // The input has no Evidence section at all, so the result below is the exemption and not a heading that was found.
  const withoutSection = body.replace(/^## Evidence\n[\s\S]*?(?=^## )/m, "");
  expect(body).toContain("## Evidence");
  expect(withoutSection).not.toContain("## Evidence");
  expect(evid04(withoutSection)).toMatchObject({
    result: "skip",
    reason: "the run has no results/evidence/",
  });

  // The same input fails for a run that has evidence, so the skip comes from the missing folder.
  const ledger = evidenceBody(evidenceWith(["a.png"], ["b.png"])).ledger;
  expect(
    result(lintBody({ body: withoutSection, title: defaultTitle, ledger }), "EVID04").result,
  ).toBe("fail");
});

// --- ARK-T150, ARK-T151: one run, two repos, one branch name ----------------------------------

const scriptFile = (name: string) => join(root, "skills/pr-writing/scripts", `${name}.ts`);

function runScript(name: string, cwd: string, ...args: string[]) {
  const spawned = Bun.spawnSync(["bun", scriptFile(name), ...args], {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: spawned.exitCode,
    stdout: spawned.stdout.toString(),
    stderr: spawned.stderr.toString(),
  };
}

const readLedger = (directory: string) =>
  JSON.parse(readFileSync(join(directory, ".pr-writing", "ledger.json"), "utf8")).ledger;

/** Repo `a` on GitHub and repo `b` on GitLab, both on `ark/ARK-9-x`, each with its own MR template and token owner. */
function twoRepoRun() {
  const run = makeRun({
    summary: "Show units",
    repos: [
      { name: "repos/a", changes: { "cli/a.ts": "from a\n" } },
      { name: "repos/b", changes: { "cli/b.ts": "from b\n" } },
    ],
  });
  const a = realpathSync(run.paths["repos/a"]);
  const b = realpathSync(run.paths["repos/b"]);
  git(b, "remote", "set-url", "origin", "https://gitlab.com/org/b.git");
  mkdirSync(join(a, ".github"), { recursive: true });
  writeFileSync(
    join(a, ".github", "pull_request_template.md"),
    "## Summary\n\n## Alpha verification\n",
  );
  mkdirSync(join(b, ".gitlab", "merge_request_templates"), { recursive: true });
  writeFileSync(
    join(b, ".gitlab", "merge_request_templates", "b.md"),
    "## Description\n\n## Bravo verification\n",
  );
  process.env.FAKE_TOKEN_OWNERS = JSON.stringify({
    a: "owner-a",
    b: "owner-b",
  });
  return { ...run, a, b };
}

test("ARK-T150 gather.ts in each repo of a 2-repo run writes that repo's own host, token owner and template, and lint_body and post_mr use them", () => {
  const { directory, a, b } = twoRepoRun();
  const title = "ARK-9: Show units";

  // The second repo first: the result must not depend on the order.
  const emittedHosts: Record<string, string> = {};
  for (const repo of [b, a]) {
    const gathered = runScript("gather", repo, "--run-dir", directory);
    expect(gathered.code).toBe(0);
    emittedHosts[repo] = JSON.parse(gathered.stdout.trim().split("\n").pop() ?? "").host;
  }

  const expected = {
    [a]: {
      files: ["repos/a/cli/a.ts"],
      host: "github",
      owner: "owner-a",
      heading: "Alpha verification",
    },
    [b]: {
      files: ["repos/b/cli/b.ts"],
      host: "gitlab",
      owner: "owner-b",
      heading: "Bravo verification",
    },
  };
  for (const [repo, want] of Object.entries(expected)) {
    const ledger = readLedger(repo);
    expect(emittedHosts[repo]).toBe(want.host);
    expect(ledger.repos).toHaveLength(1);
    expect(ledger.repos[0].path).toBe(repo);
    expect(ledger.repos[0].files.map((file: { path: string }) => file.path)).toEqual(want.files);
    expect({ host: ledger.host, tokenOwner: ledger.tokenOwner }).toEqual({
      host: want.host,
      tokenOwner: want.owner,
    });
    expect(ledger.template.text).toContain(want.heading);
    // The generated body follows this repo's template only.
    const body = readFileSync(join(repo, ".pr-writing", "body.md"), "utf8");
    expect(body).toContain(want.heading);
    const other = repo === a ? expected[b].heading : expected[a].heading;
    expect(body).not.toContain(other);
  }

  for (const repo of [a, b]) {
    const linted = runScript("lint_body", repo, "--title", title);
    expect({ repo, code: linted.code, out: linted.stdout }).toMatchObject({
      repo,
      code: 0,
    });
    const posted = runScript("post_mr", repo, "--confirmed", "--title", title);
    expect({ repo, code: posted.code, err: posted.stderr }).toMatchObject({
      repo,
      code: 0,
    });
  }

  const created = writeCalls();
  expect(created.map((call) => [call.cwd, call.tool])).toEqual([
    [a, "gh"],
    [b, "glab"],
  ]);
});

test("ARK-T151 gather.ts refuses a directory that is not a worktree of the run and names it", () => {
  const { directory } = twoRepoRun();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "pr-writing-outside-")));
  git(outside, "init", "-b", "main");
  writeFileSync(join(outside, "x.ts"), "x\n");
  git(outside, "add", ".");
  git(outside, "commit", "-m", "base");
  git(outside, "checkout", "-b", "ark/ARK-9-x");
  writeFileSync(join(outside, "x.ts"), "y\n");
  git(outside, "commit", "-am", "ARK-9: change");
  git(outside, "remote", "add", "origin", "https://github.com/org/outside.git");
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "pr-writing-plain-")));

  for (const folder of [outside, plain]) {
    const refused = runScript("gather", folder, "--run-dir", directory);
    expect({ folder, code: refused.code }).not.toEqual({ folder, code: 0 });
    expect(refused.stderr + refused.stdout).toContain(folder);
    expect(existsSync(join(folder, ".pr-writing", "ledger.json"))).toBe(false);
  }
});
