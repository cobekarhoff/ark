import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requiredLiterals } from "../cli/merge-request.ts";
import { buildBody } from "../skills/pr-writing/lib/body.ts";
import { buildLedger } from "../skills/pr-writing/lib/ledger.ts";
import { repoGraph } from "../cli/plan.ts";
import {
  ark,
  recordEvaluation,
  tempArkHome,
  tempGitRepo,
  writeProject,
  writeEvidenceFile,
  writeTicket,
} from "./helpers";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

const fixtures = resolve(import.meta.dir, "fixtures/merge-request");
const run = "2026-10-29-ARK-900-1";

type Host = "github" | "gitlab";
type LoggedCall = { tool: string; cwd: string; argv: string[]; body?: string };

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function commit(worktree: string, name: string) {
  writeFileSync(join(worktree, `${name}.txt`), name);
  git(worktree, "add", "-A");
  git(worktree, "commit", "-m", name);
}

let logFile = "";

beforeEach(() => {
  logFile = join(mkdtempSync(join(tmpdir(), "ark-fake-log-")), "calls.ndjson");
  process.env.FAKE_LOG = logFile;
  delete process.env.FAKE_GLAB_BLOCK_FAIL;
  delete process.env.FAKE_NUMBERS;
  delete process.env.FAKE_CREATE_FAIL_AT;
  process.env.PATH = `${fixtures}:${(process.env.PATH ?? "")
    .split(":")
    .filter((entry) => entry !== fixtures)
    .join(":")}`;
});

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
const optionValue = (call: LoggedCall, option: string) => call.argv[call.argv.indexOf(option) + 1];

type PlanStep = { id: string; role: string; repo: string; needs: string[]; criteria: string[] };
type Shape = { names: string[]; steps: PlanStep[]; repos?: unknown[]; noCommits: string[] };

const planStep = (
  id: string,
  repo: string,
  needs: string[],
  criteria: string[],
  role = "implementer",
) => ({
  id,
  role,
  repo,
  harness: "claude",
  model: "claude-sonnet",
  needs,
  criteria,
});
const edge = (repo: string, kind: string, pin: string) => ({
  repo,
  kind,
  pin,
  evidence: "file.txt:1",
});

// Three repos. The plan lists app first, and the repos block holds the edge app to core. app-impl also needs
// core-impl, which agrees. docs gets no commits.
const twoRepoShape: Shape = {
  names: ["core", "app", "docs"],
  steps: [
    planStep("app-impl", "repos/app", ["core-impl"], ["ARK-900-AC2"]),
    planStep("core-impl", "repos/core", [], ["ARK-900-AC1"]),
    planStep("docs-impl", "repos/docs", [], []),
  ],
  repos: [
    { repo: "repos/core", why: "units", depends_on: [] },
    { repo: "repos/app", why: "shows units", depends_on: [edge("repos/core", "api", "units@v1")] },
    { repo: "repos/docs", why: "docs", depends_on: [] },
  ],
  noCommits: ["docs"],
};

// Three repos with commits. The step needs run against the repos block: validate (platform) needs bump-reports and
// review-core (core) needs validate, so the needs alone put reports first and core last; the edges say core first.
const claraShape: Shape = {
  names: ["core", "platform", "reports"],
  steps: [
    planStep("impl-core", "repos/core", [], ["ARK-900-AC1"]),
    planStep("bump-platform", "repos/platform", [], ["ARK-900-AC2"]),
    planStep("bump-reports", "repos/reports", [], ["ARK-900-AC2"]),
    planStep("validate", "repos/platform", ["bump-reports"], ["ARK-900-AC2"], "validator"),
    planStep("review-core", "repos/core", ["validate"], ["ARK-900-AC1"], "reviewer"),
  ],
  repos: [
    { repo: "repos/core", why: "client", depends_on: [] },
    {
      repo: "repos/platform",
      why: "calls core",
      depends_on: [edge("repos/core", "package", "core>=1")],
    },
    {
      repo: "repos/reports",
      why: "calls core and platform",
      depends_on: [
        edge("repos/core", "package", "core>=1"),
        edge("repos/platform", "api", "openapi@v3"),
      ],
    },
  ],
  noCommits: [],
};

function scenario(
  hosts: Record<"core" | "app", Host>,
  testPassed = true,
  manual: string[] = [],
  config: Record<string, unknown> = {},
  shape: Shape = twoRepoShape,
) {
  tempArkHome();
  const workspace = mkdtempSync(join(tmpdir(), "ark-workspace-"));
  const projectDirectory = writeProject("demo", {
    workspace,
    ticket_source: "local",
    suites: [{ name: "e2e", level: "e2e", repo: ".", command: "true", parser: "bun" }],
    // One changed line is tier 0, which allows three prose lines: too few for a two-repo body.
    pr_writing: { tier_floor: 1 },
    roles: {
      implementer: { harness: "claude", model: "claude-sonnet" },
      validator: { harness: "codex", model: "gpt-codex" },
      reviewer: { harness: "codex", model: "gpt-codex" },
    },
    ...config,
  });
  const ticketFile = writeTicket(
    "demo",
    "ARK-900",
    [
      { id: "ARK-900-AC1", text: "Core exports units", manual: manual.includes("ARK-900-AC1") },
      { id: "ARK-900-AC2", text: "App shows units", manual: manual.includes("ARK-900-AC2") },
    ],
    "Show units",
  );
  const runDirectory = join(projectDirectory, "runs", run);
  mkdirSync(runDirectory, { recursive: true });
  copyFileSync(ticketFile, join(runDirectory, "ticket.md"));
  for (const id of manual) writeEvidenceFile(runDirectory, id);

  const { steps } = shape;
  if (steps.some((planned) => planned.role === "reviewer")) {
    mkdirSync(join(runDirectory, "findings"), { recursive: true });
    writeFileSync(
      join(runDirectory, "findings", "review-core.md"),
      [
        "No findings.",
        "",
        "## Merge risk",
        "",
        "- Verification: good — tested",
        "- Alignment: good — in plan",
        "- Impact: good — small",
        "- Rollback cost: good — revert",
        "- Door: two-way",
        "- Blast radius: three repos",
        ...shape.names.map((name) => `- Not in plan: repos/${name}/${name}.txt — fixture commit`),
        "",
        "Verdict: accepted",
        "",
      ].join("\n"),
    );
  }
  writeFileSync(
    join(runDirectory, "plan.yml"),
    JSON.stringify({ steps, repos: shape.repos, test_cases: [] }),
  );

  const worktrees: Record<string, string> = {};
  const bares: Record<string, string> = {};
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
  events.push(
    ...steps
      .filter((planned) => planned.role === "reviewer")
      .map((planned) => ({
        type: "step.started",
        data: { step: planned.id, role: planned.role, repo: planned.repo, round: 1 },
      })),
  );
  for (const name of shape.names) {
    const source = join(workspace, "repos", name);
    mkdirSync(join(workspace, "repos"), { recursive: true });
    renameSync(tempGitRepo(), source);
    const base = "main"; // tempGitRepo inits on main
    const host: Host = name === "app" ? hosts.app : hosts.core;
    // A local bare repo whose path names the host: `git fetch` and `git push` work offline and `remote get-url` still reads as the host.
    const bare = join(
      mkdtempSync(join(tmpdir(), "ark-origin-")),
      host === "github" ? "github.com" : "gitlab.com",
      "org",
      `${name}.git`,
    );
    mkdirSync(bare, { recursive: true });
    git(bare, "init", "--bare");
    git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
    git(source, "remote", "add", "origin", bare);
    git(source, "push", "origin", "main");
    git(source, "remote", "set-head", "origin", "main");
    const configured = (config.repos as Record<string, { base?: string }> | undefined)?.[
      `repos/${name}`
    ]?.base;
    if (configured !== undefined) git(source, "push", "origin", `main:refs/heads/${configured}`);
    const worktree = join(mkdtempSync(join(tmpdir(), "ark-worktree-")), name);
    git(source, "worktree", "add", "-b", `ark/${run}`, worktree, base);
    if (!shape.noCommits.includes(name)) commit(worktree, name);
    worktrees[name] = worktree;
    bares[name] = bare;
    events.push({
      type: "worktree.created",
      data: { repo: `repos/${name}`, path: worktree, branch: `ark/${run}`, base },
    });
  }
  events.push({
    type: "test.completed",
    data: {
      passed: testPassed,
      heads: Object.fromEntries(
        Object.entries(worktrees).map(([name, path]) => [
          `repos/${name}`,
          git(path, "rev-parse", "HEAD"),
        ]),
      ),
      suites: [{ name: "e2e", level: "e2e", passed: testPassed }],
      criteria: { "ARK-900-AC1": "passing", "ARK-900-AC2": "passing" },
    },
  });
  writeFileSync(
    join(runDirectory, "events.ndjson"),
    events
      .map((event, i) => JSON.stringify({ seq: i + 1, time: "2026-10-29T00:00:00.000Z", ...event }))
      .join("\n") + "\n",
  );
  return { runDirectory, worktrees, bares, workspace };
}

const openedEvents = (runDirectory: string) =>
  readFileSync(join(runDirectory, "events.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.type === "merge_request.opened");

test(
  "ARK-T48 merge-request open pushes and posts one ready MR per repo on GitHub in dependency order, with the run title and body",
  () => {
    const { runDirectory, bares } = scenario({ core: "github", app: "github" });
    const result = ark("merge-request", "open", run);
    expect(result.code).toBe(0);

    // One pull request per repo with commits, core before app although the plan lists app first.
    const opened = created();
    expect(opened.map((call) => call.tool)).toEqual(["gh", "gh"]);
    expect(opened.map((call) => call.cwd.split("/").at(-1))).toEqual(["core", "app"]);
    expect(optionValue(opened[0], "--head")).toBe(`ark/${run}`);
    expect(optionValue(opened[0], "--title")).toBe("ARK-900: Show units");

    // The run branch reached each origin; docs had no commits and opened nothing.
    expect(git(bares.core, "rev-parse", "--verify", `refs/heads/ark/${run}`)).toMatch(
      /^[0-9a-f]{40}$/,
    );
    expect(git(bares.app, "rev-parse", "--verify", `refs/heads/ark/${run}`)).toMatch(
      /^[0-9a-f]{40}$/,
    );
    expect(
      Bun.spawnSync(["git", "rev-parse", "--verify", `refs/heads/ark/${run}`], { cwd: bares.docs })
        .exitCode,
    ).not.toBe(0);

    const [coreBody, appBody] = opened.map((call) => call.body);
    expect(coreBody).toContain("ARK-900");
    expect(appBody).toContain("ARK-900");
    expect(`${coreBody}${appBody}`).not.toContain("Core exports units");
    expect(coreBody).not.toContain("Depends on");
    expect(appBody).toContain("Depends on #1");

    expect(openedEvents(runDirectory).map((event) => event.data)).toEqual([
      {
        repo: "repos/core",
        url: "https://github.com/org/core/pull/1",
        number: 1,
        order: 1,
        waits_for: [],
      },
      {
        repo: "repos/app",
        url: "https://github.com/org/app/pull/2",
        number: 2,
        order: 2,
        waits_for: [1],
      },
    ]);

    // Rerun with no new head: no new pull request, no new event, no body write.
    const rerun = ark("merge-request", "open", run);
    expect(rerun.code).toBe(0);
    expect(created()).toHaveLength(2);
    expect(edited()).toHaveLength(0);
    expect(openedEvents(runDirectory)).toHaveLength(2);

    // No call merged, approved or set auto-merge.
    for (const call of calls()) {
      expect(call.argv.join(" ")).not.toMatch(/\bmerge\b|\bapprove\b|--auto/);
    }
  },
  { timeout: 30_000 },
);

test(
  "ARK-T49 merge-request open uses glab on GitLab, writes `Depends on !N` and a native dependency",
  () => {
    const { runDirectory } = scenario({ core: "gitlab", app: "gitlab" });
    expect(ark("merge-request", "open", run).code).toBe(0);

    const opened = created();
    expect(opened.map((call) => call.tool)).toEqual(["glab", "glab"]);
    expect(optionValue(opened[1], "--source-branch")).toBe(`ark/${run}`);
    expect(opened[1].body).toContain("Depends on !1");
    expect(openedEvents(runDirectory).map((event) => event.data.url)).toEqual([
      "https://gitlab.com/org/core/-/merge_requests/1",
      "https://gitlab.com/org/app/-/merge_requests/2",
    ]);

    const block = calls().find((call) => call.argv.join(" ").includes("/blocks"));
    expect(block?.argv).toEqual([
      "api",
      "--method",
      "POST",
      "projects/:fullpath/merge_requests/2/blocks?blocking_merge_request_id=9001",
    ]);
    for (const call of calls())
      expect(call.argv.join(" ")).not.toMatch(
        /\/merge\b|\/approve\b|\bapprove\b|--auto|--when-pipeline/,
      );
  },
  { timeout: 30_000 },
);

test(
  "ARK-T50 a refused native GitLab dependency still opens the MR with the Depends on line",
  () => {
    process.env.FAKE_GLAB_BLOCK_FAIL = "1";
    const { runDirectory } = scenario({ core: "gitlab", app: "gitlab" });
    expect(ark("merge-request", "open", run).code).toBe(0);
    expect(created()[1].body).toContain("Depends on !1");
    expect(openedEvents(runDirectory)).toHaveLength(2);
  },
  { timeout: 30_000 },
);

test(
  "ARK-T51 each repo uses the host of its own remote",
  () => {
    scenario({ core: "github", app: "gitlab" });
    expect(ark("merge-request", "open", run).code).toBe(0);
    const opened = created();
    expect(opened.map((call) => call.tool)).toEqual(["gh", "glab"]);
    expect(opened[1].body).toContain("Depends on !1");
  },
  { timeout: 30_000 },
);

const claraHosts: Record<"core" | "app", Host> = { core: "gitlab", app: "gitlab" };
const claraEvents = [
  {
    repo: "repos/core",
    url: "https://gitlab.com/org/core/-/merge_requests/412",
    number: 412,
    order: 1,
    waits_for: [],
  },
  {
    repo: "repos/platform",
    url: "https://gitlab.com/org/platform/-/merge_requests/88",
    number: 88,
    order: 2,
    waits_for: [412],
  },
  {
    repo: "repos/reports",
    url: "https://gitlab.com/org/reports/-/merge_requests/31",
    number: 31,
    order: 3,
    waits_for: [412, 88],
  },
];

test(
  "ARK-T107 merge-request open follows the repos graph against the step needs and records order and waits_for",
  () => {
    process.env.FAKE_NUMBERS = "[412, 88, 31]";
    const { runDirectory } = scenario(
      claraHosts,
      true,
      [],
      { pr_writing: { tier_floor: 2 } },
      claraShape,
    );
    const result = ark("merge-request", "open", run);
    expect(result.code, result.err).toBe(0);
    expect(created().map((call) => call.cwd.split("/").at(-1))).toEqual([
      "core",
      "platform",
      "reports",
    ]);
    expect(openedEvents(runDirectory).map((event) => event.data)).toEqual(claraEvents);
    expect(result.out.trim().split("\n")).toEqual([
      "1  repos/core  !412  https://gitlab.com/org/core/-/merge_requests/412",
      "2  repos/platform  !88  https://gitlab.com/org/platform/-/merge_requests/88  waits for !412",
      "3  repos/reports  !31  https://gitlab.com/org/reports/-/merge_requests/31  waits for !412, !88",
    ]);
  },
  { timeout: 30_000 },
);

test(
  "ARK-T107 merge-request open opens the MRs of the playbook plan shape, whose step needs alone make a repo cycle",
  () => {
    process.env.FAKE_NUMBERS = "[412, 88, 31]";
    // The bump steps need impl-core as in the playbook; review-core needs validate. By step needs core waits for
    // platform and platform waits for core. The repos block holds the real edges only.
    const steps = claraShape.steps.map((planned) =>
      planned.id.startsWith("bump-") ? { ...planned, needs: ["impl-core"] } : planned,
    );
    const { runDirectory } = scenario(
      claraHosts,
      true,
      [],
      { pr_writing: { tier_floor: 2 } },
      { ...claraShape, steps },
    );
    const result = ark("merge-request", "open", run);
    expect(result.err).not.toContain("dependency cycle between repos");
    expect(result.code, result.err).toBe(0);
    expect(openedEvents(runDirectory).map((event) => event.data)).toEqual(claraEvents);
  },
  { timeout: 30_000 },
);

test(
  "ARK-T107 a resumed merge-request open records the same order and waits_for and opens no MR twice",
  () => {
    process.env.FAKE_NUMBERS = "[412, 88, 31]";
    process.env.FAKE_CREATE_FAIL_AT = "2";
    const { runDirectory } = scenario(
      claraHosts,
      true,
      [],
      { pr_writing: { tier_floor: 2 } },
      claraShape,
    );
    expect(ark("merge-request", "open", run).code).toBe(1);
    expect(openedEvents(runDirectory).map((event) => event.data)).toEqual([claraEvents[0]]);

    delete process.env.FAKE_CREATE_FAIL_AT;
    const resumed = ark("merge-request", "open", run);
    expect(resumed.code, resumed.err).toBe(0);
    expect(openedEvents(runDirectory).map((event) => event.data)).toEqual(claraEvents);
    expect(created()).toHaveLength(3);
  },
  { timeout: 30_000 },
);

test(
  "ARK-T107 a plan with no repos list takes the order from step needs, and an event with no order still loads",
  () => {
    const { runDirectory } = scenario(
      { core: "github", app: "github" },
      true,
      [],
      {},
      { ...twoRepoShape, repos: undefined },
    );
    expect(ark("merge-request", "open", run).code).toBe(0);
    expect(created().map((call) => call.cwd.split("/").at(-1))).toEqual(["core", "app"]);
    expect(
      openedEvents(runDirectory).map((event) => [event.data.order, event.data.waits_for]),
    ).toEqual([
      [1, []],
      [2, [1]],
    ]);

    // An event written before ARK-336 has neither field.
    const file = join(runDirectory, "events.ndjson");
    writeFileSync(
      file,
      readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const event = JSON.parse(line);
          if (event.type === "merge_request.opened") {
            delete event.data.order;
            delete event.data.waits_for;
          }
          return JSON.stringify(event);
        })
        .join("\n") + "\n",
    );
    const status = ark("status", run);
    expect(status.code, status.err).toBe(0);
    expect(status.out).toContain("https://github.com/org/core/pull/1");
    const rerun = ark("merge-request", "open", run);
    expect(rerun.code, rerun.err).toBe(0);
    expect(created()).toHaveLength(2);
  },
  { timeout: 30_000 },
);

test(
  "ARK-155-AC6 refuses when the last test run failed",
  () => {
    const { runDirectory } = scenario({ core: "github", app: "github" }, false);
    const result = ark("merge-request", "open", run);
    expect(result.code).toBe(1);
    expect(result.err).toContain("did not pass");
    expect(calls()).toHaveLength(0);
    expect(openedEvents(runDirectory)).toHaveLength(0);
  },
  { timeout: 30_000 },
);

test(
  "ARK-155-AC6 refuses when a worktree head moved after the test run, and names the repo",
  () => {
    const { worktrees } = scenario({ core: "github", app: "github" });
    commit(worktrees.app, "late-change");
    const result = ark("merge-request", "open", run);
    expect(result.code).toBe(1);
    expect(result.err).toContain("repos/app");
    expect(calls()).toHaveLength(0);
  },
  { timeout: 30_000 },
);

test("ARK-155-AC2 merge order follows needs across repos, ties by first appearance, same plan same order", () => {
  const step = (id: string, repo: string, needs: string[] = []) => ({
    id,
    repo,
    needs,
    criteria: [],
  });
  const plan = {
    steps: [
      step("web-1", "web", ["api-1"]),
      step("docs-1", "docs"),
      step("api-1", "api", ["lib-1"]),
      step("lib-1", "lib"),
      step("web-2", "web", ["web-1"]),
    ],
  };
  expect(repoGraph(plan).order).toEqual(["docs", "lib", "api", "web"]);
  expect(repoGraph(structuredClone(plan)).order).toEqual(repoGraph(plan).order);
});

test("ARK-155-AC2 merge order refuses a dependency cycle between repos", () => {
  const plan = {
    steps: [
      { id: "a-1", repo: "a", needs: ["b-1"], criteria: [] },
      { id: "b-1", repo: "b", needs: ["a-2"], criteria: [] },
      { id: "a-2", repo: "a", needs: [], criteria: [] },
    ],
  };
  expect(() => repoGraph(plan)).toThrow(/cycle.*a, b/);
});

test("ARK-155-AC7 no source under cli/ runs a merge, approve or auto-merge command", () => {
  const forbidden =
    /\b(pr|mr)["',\s]+(merge|approve)\b|--auto\b|--approve\b|--when-pipeline-succeeds|merge_requests\/[^"'`]*\/(merge|approve)\b/;
  const sources = [
    ...new Bun.Glob("**/*.ts").scanSync({
      cwd: resolve(import.meta.dir, "../cli"),
      absolute: true,
    }),
  ];
  expect(sources.length).toBeGreaterThan(0);
  for (const source of sources)
    expect({ source, match: readFileSync(source, "utf8").match(forbidden)?.[0] }).toEqual({
      source,
      match: undefined,
    });
});

// One real repo with a real suite, run through plan check, worktree create and ark test.
function testedRun() {
  tempArkHome();
  const workspace = tempGitRepo({
    "ac.test.ts": `import { test } from "bun:test"; test("ARK-900-AC1 works", () => {});\n`,
  });
  const bare = join(mkdtempSync(join(tmpdir(), "ark-origin-")), "github.com", "org", "core.git");
  mkdirSync(bare, { recursive: true });
  git(bare, "init", "--bare");
  git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
  git(workspace, "remote", "add", "origin", bare);
  git(workspace, "push", "origin", "main");
  git(workspace, "remote", "set-head", "origin", "main");
  writeProject("demo", {
    workspace,
    ticket_source: "local",
    suites: [
      {
        name: "e2e",
        level: "e2e",
        repo: ".",
        command: "bun test --reporter=junit --reporter-outfile={report} ./ac.test.ts",
        parser: "bun",
      },
    ],
    roles: {
      implementer: { harness: "claude", model: "claude-sonnet" },
      validator: { harness: "codex", model: "gpt-codex" },
      reviewer: { harness: "codex", model: "gpt-codex" },
    },
  });
  const ticket = writeTicket("demo", "ARK-900", [{ id: "ARK-900-AC1", text: "It works" }]);
  const runId = ark("run", "start", ticket, "--project", "demo").out.trim();
  const runDirectory = join(process.env.ARK_HOME as string, "projects", "demo", "runs", runId);
  recordEvaluation(runDirectory);
  writeFileSync(
    join(runDirectory, "plan.yml"),
    JSON.stringify({
      design: { interfaces: [{ name: "fixture plan", callers: ["ark test"] }] },
      summary: {
        why: "Fixture.",
        changes: [{ criterion: "ARK-900-AC1", where: "tests", now: "None.", fix: "A test." }],
      },
      steps: [
        {
          id: "build",
          role: "implementer",
          repo: ".",
          harness: "claude",
          model: "claude-sonnet",
          needs: [],
          criteria: ["ARK-900-AC1"],
        },
      ],
      test_cases: [
        {
          id: "proves-ARK-900-AC1",
          criterion: "ARK-900-AC1",
          level: "e2e",
          given: [],
          when: ["run it"],
          // oxlint-disable-next-line unicorn/no-thenable -- plan test-case field `then: string[]`, not a Promise-like
          then: ["it works"],
          expected: "it works",
        },
      ],
    }),
  );
  for (const args of [
    ["plan", "check", runId],
    ["gate", "record", runId, "plan", "approve"],
    ["worktree", "create", runId, "."],
    ["test", runId],
  ]) {
    const result = ark(...args);
    if (result.code !== 0) throw new Error(`${args.join(" ")} failed: ${result.out}${result.err}`);
  }
  return { runId, runDirectory, bare, worktree: join(runDirectory, "workspace") };
}

test(
  "ARK-287-AC4 refuses a head that changed since the test with the run id in the next command, then opens after a passing ark test",
  () => {
    const { runId, runDirectory, bare, worktree } = testedRun();
    const tested = git(worktree, "rev-parse", "HEAD");
    commit(worktree, "late-change");
    const now = git(worktree, "rev-parse", "HEAD");
    const eventsBefore = readFileSync(join(runDirectory, "events.ndjson"), "utf8");

    const refused = ark("merge-request", "open", runId);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("repo .");
    expect(refused.err).toContain(`tested ${tested.slice(0, 8)}`);
    expect(refused.err).toContain(`now ${now.slice(0, 8)}`);
    expect(refused.err.trim().endsWith(`run ark test ${runId} again`)).toBe(true);
    expect(calls()).toHaveLength(0);
    expect(readFileSync(join(runDirectory, "events.ndjson"), "utf8")).toBe(eventsBefore);
    expect(
      Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", "refs/heads/ark/ARK-900"], {
        cwd: bare,
      }).exitCode,
    ).not.toBe(0);
    expect(git(bare, "branch", "--list", "ark/*")).toBe("");

    expect(ark("test", runId).code).toBe(0);
    const reopened = ark("merge-request", "open", runId);
    expect(reopened.code, reopened.err).toBe(0);
    expect(created()).toHaveLength(1);
    expect(openedEvents(runDirectory)).toHaveLength(1);
    expect(readFileSync(join(runDirectory, "events.ndjson"), "utf8")).not.toContain(
      '"gate":"escalation"',
    );
  },
  { timeout: 60_000 },
);

test(
  "ARK-283-AC4 merge-request open names each manual criterion without ok, opens no MR, and opens normally after ok",
  () => {
    const manual = ["ARK-900-AC1", "ARK-900-AC2"];
    const { runDirectory, bares } = scenario({ core: "github", app: "github" }, true, manual);

    const refused = ark("merge-request", "open", run);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("ARK-900/AC1");
    expect(refused.err).toContain("ARK-900/AC2");
    expect(calls()).toEqual([]);
    expect(openedEvents(runDirectory)).toEqual([]);
    // Nothing was pushed either.
    expect(
      Bun.spawnSync(["git", "rev-parse", "--verify", `refs/heads/ark/${run}`], { cwd: bares.core })
        .exitCode,
    ).not.toBe(0);

    // A problem answer is not ok; only the unanswered or problem criteria are named.
    expect(ark("gate", "record", run, "manual", "ARK-900/AC1", "ok").code).toBe(0);
    expect(ark("gate", "record", run, "manual", "ARK-900/AC2", "problem").code).toBe(0);
    const partial = ark("merge-request", "open", run);
    expect(partial.code).toBe(1);
    expect(partial.err).toContain("ARK-900/AC2");
    expect(partial.err).not.toContain("ARK-900/AC1");
    expect(created()).toEqual([]);

    expect(ark("gate", "record", run, "manual", "ARK-900/AC2", "ok").code).toBe(0);
    const opened = ark("merge-request", "open", run);
    expect(opened.code).toBe(0);
    expect(created().map((call) => call.tool)).toEqual(["gh", "gh"]);
    expect(openedEvents(runDirectory)).toHaveLength(2);
  },
  { timeout: 30_000 },
);

/** Fake git, gh and glab that append their arguments to one file; git then runs the real git. */
function fakeHostTools(): string {
  const realGit = Bun.which("git") as string;
  const directory = mkdtempSync(join(tmpdir(), "ark-fake-tools-"));
  const calls = join(directory, "calls.log");
  writeFileSync(calls, "");
  for (const tool of ["git", "gh", "glab"])
    writeFileSync(
      join(directory, tool),
      `#!/bin/sh\necho "${tool} $*" >> "${calls}"\n${tool === "git" ? `exec "${realGit}" "$@"` : "exit 1"}\n`,
      { mode: 0o755 },
    );
  process.env.PATH = `${directory}:${process.env.PATH}`;
  return calls;
}

const none = { merge_requests: "none" };

test(
  "ARK-295-AC2 merge-request open exits 1 for a none project before any git, gh or glab runs",
  () => {
    const { runDirectory, bares } = scenario({ core: "github", app: "github" }, true, [], none);
    const toolCalls = fakeHostTools();
    const result = ark("merge-request", "open", run);
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      `project demo has merge_requests: none: close the run with ark run close ${run} handed_off`,
    );
    expect(readFileSync(toolCalls, "utf8")).toBe("");
    expect(calls()).toEqual([]);
    expect(openedEvents(runDirectory)).toEqual([]);
    expect(
      Bun.spawnSync(["git", "rev-parse", "--verify", `refs/heads/ark/${run}`], { cwd: bares.core })
        .exitCode,
    ).not.toBe(0);
  },
  { timeout: 30_000 },
);

test(
  "ARK-295-AC2 merge-request open still pushes and opens for a project with merge_requests open",
  () => {
    const { runDirectory, bares } = scenario({ core: "github", app: "github" }, true, [], {
      merge_requests: "open",
    });
    const result = ark("merge-request", "open", run);
    expect(result.code).toBe(0);
    expect(git(bares.core, "rev-parse", "--verify", `refs/heads/ark/${run}`)).toBeTruthy();
    expect(openedEvents(runDirectory)).toHaveLength(2);
  },
  { timeout: 30_000 },
);

test(
  "ARK-295-AC3 merge-request status prints merge requests: none for a none project and calls no gh or glab",
  () => {
    scenario({ core: "github", app: "github" }, true, [], none);
    const toolCalls = fakeHostTools();
    const result = ark("merge-request", "status", run);
    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe("merge requests: none");
    expect(readFileSync(toolCalls, "utf8")).toBe("");
    expect(calls()).toEqual([]);
  },
  { timeout: 30_000 },
);

for (const subcommand of ["open", "status"]) {
  test(
    `ARK-295-AC2 ARK-295-AC3 merge-request ${subcommand} refuses a none project with an invalid unrelated field before any git, gh or glab runs`,
    () => {
      const { bares } = scenario({ core: "github", app: "github" }, true, [], {
        ...none,
        concurrency: 0,
      });
      const toolCalls = fakeHostTools();
      const result = ark("merge-request", subcommand, run);
      expect(result.code).toBe(1);
      expect(result.err).toContain("concurrency must be an integer >= 1");
      expect(readFileSync(toolCalls, "utf8")).toBe("");
      expect(calls()).toEqual([]);
      expect(
        Bun.spawnSync(["git", "rev-parse", "--verify", `refs/heads/ark/${run}`], {
          cwd: bares.core,
        }).exitCode,
      ).not.toBe(0);
    },
    { timeout: 30_000 },
  );
}

/** Rewrites the events of a scenario run in place; `change` gets each parsed event and returns it. */
function rewriteEvents(
  runDirectory: string,
  change: (event: { type: string; data: Record<string, any> }) => unknown,
) {
  const file = join(runDirectory, "events.ndjson");
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  writeFileSync(
    file,
    lines.map((line) => JSON.stringify(change(JSON.parse(line)))).join("\n") + "\n",
  );
}

/** Replaces the text of one AC in the run's ticket.md (the text is a JSON string there). */
function setCriterionText(runDirectory: string, id: string, text: string) {
  const file = join(runDirectory, "ticket.md");
  const lines = readFileSync(file, "utf8").split("\n");
  const at = lines.findIndex((line) => line === `  - id: ${id}`) + 1;
  lines[at] = `    text: ${JSON.stringify(text)}`;
  writeFileSync(file, lines.join("\n"));
}

test(
  "ARK-302-AC2 refuses when a criterion is missing or failing in the last test.completed, names each, opens nothing",
  () => {
    const { runDirectory } = scenario({ core: "github", app: "github" });
    // passed stays true: the refusal must come from the per-AC status, not the suite verdict.
    rewriteEvents(runDirectory, (event) => {
      if (event.type === "test.completed") event.data.criteria = { "ARK-900-AC1": "failing" };
      return event;
    });
    const refused = ark("merge-request", "open", run);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("ARK-900/AC1 (failing)");
    expect(refused.err).toContain("ARK-900/AC2 (missing)");
    expect(calls()).toHaveLength(0);
    expect(openedEvents(runDirectory)).toHaveLength(0);
  },
  { timeout: 30_000 },
);

test(
  "ARK-302-AC2 a manual criterion that is not passing does not block opening",
  () => {
    const { runDirectory } = scenario({ core: "github", app: "github" }, true, ["ARK-900-AC2"]);
    expect(ark("gate", "record", run, "manual", "ARK-900/AC2", "ok").code).toBe(0);
    rewriteEvents(runDirectory, (event) => {
      if (event.type === "test.completed")
        event.data.criteria = { "ARK-900-AC1": "passing", "ARK-900-AC2": "manual ok" };
      return event;
    });
    expect(ark("merge-request", "open", run).code).toBe(0);
  },
  { timeout: 30_000 },
);

test(
  "ARK-296-AC4 merge-request open passes repos.<repo>.base to gh --base and glab --target-branch",
  () => {
    scenario({ core: "github", app: "gitlab" }, true, [], {
      repos: { "repos/core": { base: "release/9" }, "repos/app": { base: "release/9.1.0" } },
    });
    expect(ark("merge-request", "open", run).code).toBe(0);
    const [gh, glab] = created();
    expect([gh.tool, optionValue(gh, "--base")]).toEqual(["gh", "release/9"]);
    expect(gh.argv.slice(0, 2)).toEqual(["pr", "create"]);
    expect([glab.tool, optionValue(glab, "--target-branch")]).toEqual(["glab", "release/9.1.0"]);
    expect(glab.argv.slice(0, 2)).toEqual(["mr", "create"]);
  },
  { timeout: 30_000 },
);

test(
  "ARK-302-AC3 refuses an AC string that no tracked file holds, names the AC and the string, and accepts one that exists",
  () => {
    const { runDirectory, worktrees } = scenario({ core: "github", app: "github" });
    // `core` and `# test` are tracked at head (core.txt, README.md); the string of AC2 is in no worktree at head.
    setCriterionText(runDirectory, "ARK-900-AC1", "Core writes `core` and `# test`");
    setCriterionText(runDirectory, "ARK-900-AC2", "App shows `absent-string-xyz` and `core`");
    // An untracked file holding the string is not tracked, so it does not count.
    writeFileSync(join(worktrees.app, "scratch.txt"), "absent-string-xyz");

    const refused = ark("merge-request", "open", run);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("ARK-900/AC2 `absent-string-xyz`");
    expect(refused.err).not.toContain("ARK-900/AC1");
    expect(refused.err).not.toContain("`core`");
    expect(refused.err).not.toContain("`# test`");
    expect(calls()).toHaveLength(0);

    setCriterionText(runDirectory, "ARK-900-AC2", "App shows `core`");
    expect(ark("merge-request", "open", run).code).toBe(0);
  },
  { timeout: 30_000 },
);

test(
  "ARK-302-AC3 accepts an AC string that only an untouched repo of the workspace holds",
  () => {
    const { runDirectory, workspace } = scenario({ core: "github", app: "github" });
    // `lib` has no run worktree: it is only linked into the mirror.
    renameSync(tempGitRepo({ "lib.txt": "lib-only-literal" }), join(workspace, "repos/lib"));
    setCriterionText(runDirectory, "ARK-900-AC1", "Core reads `lib-only-literal`");
    expect(ark("merge-request", "open", run).code).toBe(0);

    setCriterionText(runDirectory, "ARK-900-AC1", "Core reads `absent-everywhere`");
    const refused = ark("merge-request", "open", run);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("ARK-900/AC1 `absent-everywhere`");
  },
  { timeout: 30_000 },
);

test(
  "ARK-307-AC1 counts a path string as present when it names a tracked file or folder, refuses a missing path and a lone slash",
  () => {
    const { runDirectory, workspace, worktrees } = scenario({ core: "github", app: "github" });
    renameSync(
      tempGitRepo({
        "scripts/check_knowledge_docs.py": "x",
        ".claude/skills/config/SKILL.md": "y",
      }),
      join(workspace, "repos/lib"),
    );
    // An untracked file is not at head, so it does not count.
    writeFileSync(join(worktrees.app, "untracked.py"), "x");
    setCriterionText(
      runDirectory,
      "ARK-900-AC1",
      "Reads `scripts/check_knowledge_docs.py` and `.claude/skills/config/`",
    );
    expect(ark("merge-request", "open", run).code).toBe(0);

    setCriterionText(
      runDirectory,
      "ARK-900-AC1",
      "Reads `scripts/check_knowledge_docs.py`, `scripts/missing.py`, `untracked.py` and `/`",
    );
    const refused = ark("merge-request", "open", run);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("AC string in no tracked file at head:");
    expect(refused.err).toContain("`scripts/missing.py`");
    expect(refused.err).toContain("`untracked.py`");
    expect(refused.err).toContain("`/`");
    expect(refused.err).not.toContain("check_knowledge_docs");
  },
  { timeout: 30_000 },
);

test(
  "ARK-307-AC2 refuses a not: string that names a tracked file or folder",
  () => {
    const { runDirectory, workspace } = scenario({ core: "github", app: "github" });
    renameSync(
      tempGitRepo({ "scripts/old.py": "x", "docs/old/page.md": "y" }),
      join(workspace, "repos/lib"),
    );
    setCriterionText(
      runDirectory,
      "ARK-900-AC1",
      "Removes `not:scripts/old.py` and `not:docs/old/`",
    );
    const refused = ark("merge-request", "open", run);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("AC string still in a tracked file at head:");
    expect(refused.err).toContain("`scripts/old.py`");
    expect(refused.err).toContain("`docs/old/`");

    setCriterionText(runDirectory, "ARK-900-AC1", "Removes `not:scripts/gone.py` and `not:/`");
    expect(ark("merge-request", "open", run).code).toBe(0);
  },
  { timeout: 30_000 },
);

test(
  "ARK-307-AC1 refuses a required string that is only a slash",
  () => {
    const { runDirectory } = scenario({ core: "github", app: "github" });
    setCriterionText(runDirectory, "ARK-900-AC1", "Reads `/`");
    const refused = ark("merge-request", "open", run);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("AC string in no tracked file at head:");
    expect(refused.err).toContain("`/`");
  },
  { timeout: 30_000 },
);

test(
  "ARK-305-AC1 skips placeholder, glob, dots, file:line, own id and every string of a manual AC, refuses only the real missing string",
  () => {
    const { runDirectory } = scenario({ core: "github", app: "github" }, true, ["ARK-900-AC2"]);
    expect(ark("gate", "record", run, "manual", "ARK-900/AC2", "ok").code).toBe(0);
    setCriterionText(
      runDirectory,
      "ARK-900-AC1",
      "Skips `repos/<repo>/`, `src/**/*.md`, `docs/more/...`, `core.txt:38`, `ARK-900-AC1 works`, `test_ARK_900_AC1_*`",
    );
    setCriterionText(runDirectory, "ARK-900-AC2", "A person sees `manual-only-absent`");
    expect(ark("merge-request", "open", run).code).toBe(0);

    setCriterionText(runDirectory, "ARK-900-AC1", "Skips `repos/<repo>/` and needs `real-missing`");
    const refused = ark("merge-request", "open", run);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(
      "AC string in no tracked file at head: ARK-900/AC1 `real-missing`",
    );
    expect(refused.err).not.toContain("repos/<repo>/");
    expect(refused.err).not.toContain("manual-only-absent");
  },
  { timeout: 30_000 },
);

test(
  "ARK-305-AC2 refuses a not: string that a tracked file still holds, passes an absent one, and counts not: alone as no literal",
  () => {
    const { runDirectory } = scenario({ core: "github", app: "github" });
    // `core` is tracked at head (core.txt), `gone-everywhere` is in no file.
    setCriterionText(runDirectory, "ARK-900-AC1", "Removes `not:core`");
    const refused = ark("merge-request", "open", run);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("AC string still in a tracked file at head: ARK-900/AC1 `core`");
    expect(refused.err).not.toContain("not:");
    expect(calls()).toHaveLength(0);
    expect(openedEvents(runDirectory)).toHaveLength(0);

    setCriterionText(
      runDirectory,
      "ARK-900-AC1",
      "Removes `not:gone-everywhere` and writes `not:`",
    );
    expect(ark("merge-request", "open", run).code).toBe(0);

    // The same text without the prefix is a required string again.
    setCriterionText(runDirectory, "ARK-900-AC1", "Writes `gone-everywhere`");
    const required = ark("merge-request", "open", run);
    expect(required.code).toBe(1);
    expect(required.err).toContain(
      "AC string in no tracked file at head: ARK-900/AC1 `gone-everywhere`",
    );
  },
  { timeout: 30_000 },
);

// Fixture: test/fixtures/merge-request/sqc-1-criteria.md
test(
  "ARK-305-AC3 a run with the SQC-1 ACs opens when every listed string is tracked and refuses naming only a deleted one",
  () => {
    const text = readFileSync(join(fixtures, "sqc-1-criteria.md"), "utf8");
    const frontmatter = Bun.YAML.parse(text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "") as {
      acceptance_criteria: { id: string; text: string; manual?: boolean }[];
    };
    const literals = new Map(
      frontmatter.acceptance_criteria.map(({ id, text, manual }) => [
        id,
        requiredLiterals({ id, text, manual: manual === true }),
      ]),
    );
    const required = [...literals.values()].flatMap((entry) => entry.required);
    const removed = [...literals.values()].flatMap((entry) => entry.removed);
    expect(literals.get("SQC-1-AC7")).toEqual({ required: [], removed: [] });
    for (const literal of [
      "## Finding the knowledge base",
      "uv run check-knowledge-docs",
      "Paths are relative to the workspace root",
    ])
      expect(required).toContain(literal);
    for (const literal of required) {
      expect(literal).not.toMatch(/[<*]|\.\.\.|:\d+$|^not:/);
      expect(literal).not.toMatch(/SQC[-_]1[-_]AC/);
    }
    expect(literals.get("SQC-1-AC6")?.removed).toEqual([
      "docs/00-master-reference.md",
      "docs/architecture/",
      "docs/references/",
      "docs/workflows/",
      "docs/operations/",
      "docs/templates/",
    ]);
    expect(frontmatter.acceptance_criteria.find(({ id }) => id === "SQC-1-AC6")?.text).toContain(
      "(N docs)",
    );

    // The command boundary: a run whose ticket holds these ACs.
    const { runDirectory, worktrees } = scenario({ core: "github", app: "github" }, true, [
      "SQC-1-AC7",
    ]);
    const ids = frontmatter.acceptance_criteria.map(({ id }) => id);
    writeFileSync(join(runDirectory, "ticket.md"), text);
    rewriteEvents(runDirectory, (event) => {
      if (event.type === "run.started") event.data.criteria = ids;
      return event;
    });
    expect(ark("gate", "record", run, "manual", "SQC-1-AC7", "ok").code).toBe(0);
    const commitLiterals = (kept: string[]) => {
      writeFileSync(join(worktrees.core, "literals.txt"), kept.join("\n") + "\n");
      git(worktrees.core, "add", "-A");
      git(worktrees.core, "commit", "-m", "literals");
      rewriteEvents(runDirectory, (event) => {
        if (event.type === "test.completed") {
          event.data.heads["repos/core"] = git(worktrees.core, "rev-parse", "HEAD");
          event.data.criteria = Object.fromEntries(
            ids.map((id) => [id, id === "SQC-1-AC7" ? "manual ok" : "passing"]),
          );
        }
        return event;
      });
    };
    expect(removed.length).toBeGreaterThan(0);

    commitLiterals(required);
    const opened = ark("merge-request", "open", run);
    expect(opened.err).not.toContain("AC string");
    expect(opened.code).toBe(0);

    const deleted = "uv run check-knowledge-docs";
    commitLiterals(required.filter((literal) => literal !== deleted));
    const refused = ark("merge-request", "open", run);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(`\`${deleted}\``);
    expect(refused.err.match(/AC string in no tracked file at head: /g)).toHaveLength(1);
    for (const literal of required.filter((literal) => literal !== deleted))
      expect(refused.err).not.toContain(`\`${literal}\``);
  },
  { timeout: 60_000 },
);

test(
  "ARK-302-AC6 a perf run refuses a missing baseline.md and an empty compare.md, names each, and opens once both have content",
  () => {
    const { runDirectory } = scenario({ core: "github", app: "github" });
    rewriteEvents(runDirectory, (event) => {
      if (event.type === "run.started") event.data.kind = "perf";
      return event;
    });
    mkdirSync(join(runDirectory, "results"), { recursive: true });
    writeFileSync(join(runDirectory, "results/compare.md"), "");

    const refused = ark("merge-request", "open", run);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("results/baseline.md");
    expect(refused.err).toContain("results/compare.md");
    expect(calls()).toHaveLength(0);

    writeFileSync(join(runDirectory, "results/baseline.md"), "p95 120 ms\n");
    const half = ark("merge-request", "open", run);
    expect(half.code).toBe(1);
    expect(half.err).not.toContain("results/baseline.md");
    expect(half.err).toContain("results/compare.md");

    writeFileSync(join(runDirectory, "results/compare.md"), "p95 80 ms\n");
    expect(ark("merge-request", "open", run).code).toBe(0);
  },
  { timeout: 30_000 },
);

test(
  "ARK-296-AC4 a repo with no base keeps the origin/HEAD target while a configured repo uses its base",
  () => {
    const { worktrees } = scenario({ core: "github", app: "gitlab" }, true, [], {
      repos: { "repos/app": { base: "release/9" } },
    });
    git(worktrees.core, "push", "origin", "main:refs/heads/develop");
    git(worktrees.core, "fetch", "origin");
    git(worktrees.core, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
    expect(ark("merge-request", "open", run).code).toBe(0);
    const [gh, glab] = created();
    expect(optionValue(gh, "--base")).toBe("develop");
    expect(optionValue(glab, "--target-branch")).toBe("release/9");
  },
  { timeout: 30_000 },
);

test(
  "ARK-305-AC5 a plain absent string is still refused by merge-request open",
  () => {
    const { runDirectory } = scenario({ core: "github", app: "github" });
    setCriterionText(runDirectory, "ARK-900-AC1", "Needs `absent-string-xyz`");
    const refused = ark("merge-request", "open", run);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(
      "AC string in no tracked file at head: ARK-900/AC1 `absent-string-xyz`",
    );
  },
  { timeout: 30_000 },
);

const fixedFinding = "Session fallback can present an obsolete model";

/** The run lead's fix of a P0: a later review file that says `No findings.`. */
function closeFinding(runDirectory: string) {
  writeFileSync(join(runDirectory, "findings", "review-2.md"), "No findings.\n");
}

test(
  "ARK-T57 merge-request open posts a ready MR from the ledger, then updates its body after a fixed P0 and a new head",
  () => {
    const { runId, runDirectory, worktree } = testedRun();
    // The branch needs a commit ahead of its base before it has an MR; ark test then records that head.
    commit(worktree, "feature");
    expect(ark("test", runId).code).toBe(0);
    mkdirSync(join(runDirectory, "findings"), { recursive: true });
    writeFileSync(join(runDirectory, "findings", "review-1.md"), `### P0: ${fixedFinding}\n`);

    // First open: the plan gate answer is the go-ahead, so there is no --confirmed flag. Before evidence.
    const first = ark("merge-request", "open", runId);
    expect(first.code, first.err).toBe(0);
    const [createCall] = created();
    expect(createCall.argv).not.toContain("--draft");
    expect(createCall.argv).not.toContain("--confirmed");
    const before = createCall.body!;
    expect(before).toContain(`P0 open: ${fixedFinding}`);
    expect(JSON.parse(readFileSync(join(runDirectory, "state.json"), "utf8")).phase).toBe(
      "merge_requests_open",
    );
    expect(edited()).toHaveLength(0);

    // The P0 is fixed in a new commit, a later review says `No findings.`, and ark test records the new head.
    commit(worktree, "fix-p0");
    closeFinding(runDirectory);
    expect(ark("test", runId).code).toBe(0);
    const second = ark("merge-request", "open", runId);
    expect(second.code, second.err).toBe(0);
    expect(second.out).not.toContain("already open");
    expect(created()).toHaveLength(1);
    const [update] = edited();
    expect(edited()).toHaveLength(1);
    const after = update.body!;
    expect(after).not.toContain(fixedFinding);
    expect(after).toContain("<!-- pr-writing:begin -->");
    expect(after).not.toBe(before);

    // No new head: the third run changes nothing.
    const third = ark("merge-request", "open", runId);
    expect(third.code, third.err).toBe(0);
    expect(edited()).toHaveLength(1);
    expect(created()).toHaveLength(1);
  },
  { timeout: 120_000 },
);

test(
  "ARK-T57 with two open MRs a new head updates both bodies and drops the fixed P0 from each",
  () => {
    const { runDirectory, worktrees } = scenario({ core: "github", app: "github" });
    mkdirSync(join(runDirectory, "findings"), { recursive: true });
    writeFileSync(join(runDirectory, "findings", "review-1.md"), `### P0: ${fixedFinding}\n`);
    expect(ark("merge-request", "open", run).code).toBe(0);
    expect(created()).toHaveLength(2);
    for (const call of created()) expect(call.body).toContain(fixedFinding);

    // A new head in each repo, as ark test records it: one test.completed event with the new heads.
    for (const [name, path] of Object.entries(worktrees))
      if (name !== "docs") commit(path, `${name}-fix`);
    closeFinding(runDirectory);
    const eventsFile = join(runDirectory, "events.ndjson");
    const events = readFileSync(eventsFile, "utf8").split("\n").filter(Boolean);
    const lastTest = JSON.parse(events.filter((line) => line.includes('"test.completed"')).at(-1)!);
    const heads = Object.fromEntries(
      Object.entries(worktrees).map(([name, path]) => [
        `repos/${name}`,
        git(path, "rev-parse", "HEAD"),
      ]),
    );
    writeFileSync(
      eventsFile,
      `${events.join("\n")}\n${JSON.stringify({ ...lastTest, seq: events.length + 1, data: { ...lastTest.data, heads } })}\n`,
    );

    const refreshed = ark("merge-request", "open", run);
    expect(refreshed.code, refreshed.err).toBe(0);
    expect(refreshed.out).not.toContain("already open");
    expect(created()).toHaveLength(2);
    expect(edited()).toHaveLength(2);
    for (const call of edited()) expect(call.body).not.toContain(fixedFinding);
  },
  { timeout: 60_000 },
);

test(
  "ARK-T38 two repos with different templates and host logins each get their own template, provenance handle, assignee and reviewer",
  () => {
    const { worktrees } = scenario({ core: "github", app: "github" }, true, [], {
      pr_writing: { tier_floor: 1, reviewers: ["alice", "bob"] },
    });
    const templates: Record<string, string> = {
      core: "## Summary\n\n## Changes\n\n## Testing\n",
      app: "## Context\n\n## Verification\n",
    };
    for (const name of ["core", "app"]) {
      mkdirSync(join(worktrees[name], ".github"), { recursive: true });
      writeFileSync(join(worktrees[name], ".github/pull_request_template.md"), templates[name]);
      commit(worktrees[name], `${name}-template`);
    }
    // The test run recorded the heads before the template commits: record the new ones, as ark test does.
    const eventsFile = join(process.env.ARK_HOME!, "projects/demo/runs", run, "events.ndjson");
    const lines = readFileSync(eventsFile, "utf8").split("\n").filter(Boolean);
    const lastTest = JSON.parse(lines.filter((line) => line.includes('"test.completed"')).at(-1)!);
    const heads = Object.fromEntries(
      Object.entries(worktrees).map(([name, path]) => [
        `repos/${name}`,
        git(path, "rev-parse", "HEAD"),
      ]),
    );
    writeFileSync(
      eventsFile,
      `${lines.join("\n")}\n${JSON.stringify({ ...lastTest, seq: lines.length + 1, data: { ...lastTest.data, heads } })}\n`,
    );

    process.env.FAKE_TOKEN_OWNERS = JSON.stringify({ core: "alice", app: "bob" });
    try {
      const opened = ark("merge-request", "open", run);
      expect(opened.code, opened.err).toBe(0);
    } finally {
      delete process.env.FAKE_TOKEN_OWNERS;
    }
    const byRepo = (name: string) => created().find((call) => call.cwd.endsWith(`/${name}`))!;
    const core = byRepo("core");
    const app = byRepo("app");

    expect(core.body).toContain("## Summary");
    expect(core.body).not.toContain("## Context");
    expect(app.body).toContain("## Context");
    expect(app.body).not.toContain("## Summary");

    expect(core.body).toContain("on behalf of @alice");
    expect(app.body).toContain("on behalf of @bob");

    expect(optionValue(core, "--assignee")).toBe("alice");
    expect(optionValue(app, "--assignee")).toBe("bob");
    expect(optionValue(core, "--reviewer")).toBe("bob");
    expect(optionValue(app, "--reviewer")).toBe("alice");
  },
  { timeout: 60_000 },
);

test(
  "ARK-T43 ARK-328/AC1 the merge request has the UI/UX checks block only for web_ui",
  () => {
    scenario({ core: "github", app: "github" });
    expect(ark("merge-request", "open", run).code).toBe(0);
    for (const call of created()) expect(optionValue(call, "--body")).not.toContain("UI/UX");
  },
  { timeout: 30_000 },
);

test(
  "ARK-T160 ark merge-request open on a run with 3 repos runs rev-parse HEAD at most once for each repo and each ledger git query once for each repo",
  () => {
    process.env.FAKE_NUMBERS = "[412, 88, 31]";
    const { runDirectory, worktrees } = scenario(
      claraHosts,
      true,
      [],
      { pr_writing: { tier_floor: 2 } },
      claraShape,
    );
    // A shim in front of git logs `<cwd>\t<args>` and runs the real git.
    const shim = mkdtempSync(join(tmpdir(), "ark-git-shim-"));
    const gitLog = join(shim, "git.log");
    writeFileSync(
      join(shim, "git"),
      `#!/bin/sh\nprintf '%s\\t%s\\n' "$PWD" "$*" >> "${gitLog}"\nexec /usr/bin/git "$@"\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${shim}:${process.env.PATH}`;
    const result = ark("merge-request", "open", run);
    expect(result.code, result.err).toBe(0);
    expect(created()).toHaveLength(3);

    const gitCalls = readFileSync(gitLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t") as [string, string]);
    for (const [name, worktree] of Object.entries(worktrees)) {
      const own = gitCalls.filter(([cwd]) => realpathSync(cwd) === realpathSync(worktree));
      const count = (args: string) => own.filter(([, argv]) => argv === args).length;
      expect(count("rev-parse HEAD"), `${name} rev-parse HEAD`).toBe(1);
      expect(count("remote get-url origin"), `${name} remote get-url origin`).toBeLessThanOrEqual(
        1,
      );
      expect(
        own.filter(([, argv]) => argv.startsWith("merge-base")).length,
        `${name} merge-base`,
      ).toBeLessThanOrEqual(1);
      // Every ledger query, the base-ref probe included, runs once for each repo.
      for (const query of [
        "rev-parse --verify --quiet origin/main",
        "diff --shortstat origin/main...HEAD",
      ])
        expect(count(query), `${name} ${query}`).toBeLessThanOrEqual(1);
    }

    // Each repo's single head read is its real head: the ledger of each MR body names it, and the heads differ.
    const heads = Object.values(worktrees).map((path) => git(path, "rev-parse", "HEAD"));
    expect(new Set(heads).size).toBe(3);
    expect(
      openedEvents(runDirectory).filter((e) => e.type === "merge_request.opened"),
    ).toHaveLength(3);
  },
  { timeout: 30_000 },
);

/** Replaces the data of the last `test.completed` event: the counts a real `ark test` would have recorded. */
function recordCounts(runDirectory: string, counts: Record<string, unknown>, drop: string[] = []) {
  const file = join(runDirectory, "events.ndjson");
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const index = lines.findLastIndex((line) => JSON.parse(line).type === "test.completed");
  const event = JSON.parse(lines[index]!);
  for (const key of ["passed_count", "skipped", "base_skipped", "deleted", ...drop])
    delete event.data[key];
  Object.assign(event.data, counts);
  lines[index] = JSON.stringify(event);
  writeFileSync(file, `${lines.join("\n")}\n`);
}

const testsLines = (body: string) =>
  body.split("\n").filter((line) => /^\s*- (Tests|Deleted):/.test(line));

test(
  "ARK-T200 the merge request body shows a Tests line with passed, skipped (and the base count) and deleted, lists each deleted title, and stays deterministic",
  () => {
    const { runId, runDirectory, worktree } = testedRun();
    commit(worktree, "feature");
    expect(ark("test", runId).code).toBe(0);
    const posted = () => (edited().at(-1) ?? created()[0]!).body!;
    const open = () => {
      const result = ark("merge-request", "open", runId);
      expect(result.code, result.err).toBe(0);
      return posted();
    };

    // (a) one deleted test
    recordCounts(runDirectory, {
      passed_count: 42,
      skipped: 3,
      base_skipped: 2,
      deleted: [{ file: "cli/merge-request.test.ts", name: "rejects a stale head" }],
    });
    const a = open();
    expect(testsLines(a)).toEqual([
      "- Tests: 42 passed, 3 skipped (base 2), 1 deleted",
      "  - Deleted: `cli/merge-request.test.ts` rejects a stale head",
    ]);

    // (b) clean: a zero count, no Deleted bullet
    recordCounts(runDirectory, { passed_count: 42, skipped: 0, base_skipped: 0, deleted: [] });
    expect(testsLines(open())).toEqual(["- Tests: 42 passed, 0 skipped (base 0), 0 deleted"]);

    // (c) unsorted input, a duplicate title once per copy, a title with backticks and a pipe, one with no file
    recordCounts(runDirectory, {
      passed_count: 5,
      skipped: 0,
      base_skipped: 0,
      deleted: [
        { file: "b.test.ts", name: "dup" },
        { file: "a.test.ts", name: "has `tick` | pipe" },
        { file: "b.test.ts", name: "dup" },
        { name: "no file" },
      ],
    });
    const c = open();
    expect(testsLines(c)).toEqual([
      "- Tests: 5 passed, 0 skipped (base 0), 4 deleted",
      "  - Deleted: no file",
      "  - Deleted: `a.test.ts` has \\`tick\\` \\| pipe",
      "  - Deleted: `b.test.ts` dup",
      "  - Deleted: `b.test.ts` dup",
    ]);

    // (e) an old event: no Tests line, no n/a
    recordCounts(runDirectory, {});
    const e = open();
    expect(testsLines(e)).toEqual([]);
    expect(e).not.toContain("n/a");
  },
  { timeout: 120_000 },
);

test(
  "ARK-T200 a quick or absent test result gives a Tests line without base claims or no line, and the same events give the same body",
  () => {
    const { runDirectory, worktree } = testedRun();
    const heads = { ".": git(worktree, "rev-parse", "HEAD") };
    const body = () => buildBody(buildLedger({ runFolder: runDirectory, heads }));

    // (d) quick: passed and skipped at head only
    recordCounts(runDirectory, { passed_count: 42, skipped: 3 }, ["mode"]);
    const events = join(runDirectory, "events.ndjson");
    writeFileSync(events, readFileSync(events, "utf8").replace('"mode":"full"', '"mode":"quick"'));
    const d = body();
    expect(testsLines(d)).toEqual([
      "- Tests: 42 passed, 3 skipped (no base count, deleted not counted)",
    ]);
    expect(body()).toBe(d);

    // (f) no test.completed event at all
    writeFileSync(
      events,
      readFileSync(events, "utf8")
        .split("\n")
        .filter((line) => !line.includes('"test.completed"'))
        .join("\n"),
    );
    expect(testsLines(body())).toEqual([]);
  },
  { timeout: 120_000 },
);

/**
 * A two-repo GitHub scenario with `app` after `core`. Every scenario origin is a local bare repo with the host in its
 * path, so `git fetch` and `git push` work offline.
 */
function fetchableScenario() {
  const shape: Shape = {
    names: ["core", "app"],
    steps: [
      planStep("core-impl", "repos/core", [], ["ARK-900-AC1"]),
      planStep("app-impl", "repos/app", ["core-impl"], ["ARK-900-AC2"]),
    ],
    noCommits: [],
  };
  return scenario({ core: "github", app: "github" }, true, [], {}, shape);
}

/** One commit on origin's main that changes `file`, as another contributor would push it. */
function advanceTarget(bare: string, file: string, content: string) {
  const clone = mkdtempSync(join(tmpdir(), "ark-target-clone-"));
  git(clone, "clone", bare, ".");
  git(clone, "config", "user.name", "Ark Test");
  git(clone, "config", "user.email", "ark@example.com");
  writeFileSync(join(clone, file), content);
  git(clone, "add", "-A");
  git(clone, "commit", "-m", `target ${file}`);
  git(clone, "push", "origin", "main");
}

/** Records the current worktree heads as the tested heads, as a passing `ark test` after the last commit would. */
function testedAtHead(runDirectory: string, worktrees: Record<string, string>) {
  rewriteEvents(runDirectory, (event) => {
    if (event.type === "test.completed")
      event.data.heads = Object.fromEntries(
        Object.entries(worktrees).map(([name, path]) => [
          `repos/${name}`,
          git(path, "rev-parse", "HEAD"),
        ]),
      );
    return event;
  });
}

/** HEAD, status and every local ref but the fetched `origin/*`. */
const worktreeSnapshot = (worktree: string) => ({
  head: git(worktree, "rev-parse", "HEAD"),
  status: git(worktree, "status", "--porcelain"),
  refs: git(worktree, "for-each-ref", "--format=%(refname) %(objectname)")
    .split("\n")
    .filter((line) => !line.startsWith("refs/remotes/origin/")),
});

const pushedBranches = (bare: string) => git(bare, "for-each-ref", "refs/heads/ark");

test(
  "ARK-T239 ark merge-request open refuses a repo whose head conflicts with origin's target after a fetch, changes no file or ref, and passes the same branch once a merge commit repairs it",
  () => {
    // core: the branch and origin's main change the same line. app: origin's main moved on a different file.
    const { runDirectory, worktrees, bares } = fetchableScenario();
    writeFileSync(join(worktrees.core, "README.md"), "branch\n");
    git(worktrees.core, "commit", "-am", "branch edit");
    advanceTarget(bares.core, "README.md", "target\n");
    advanceTarget(bares.app, "target.txt", "target\n");
    testedAtHead(runDirectory, worktrees);
    const before = worktreeSnapshot(worktrees.core);

    // the check is a merge of the head into origin/main that changes no file and no ref (git merge-tree)
    const refused = ark("merge-request", "open", run);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("repos/core");
    expect(refused.err).toContain("--merge");
    expect(pushedBranches(bares.core)).toBe("");
    expect(pushedBranches(bares.app)).toBe("");
    expect(created()).toHaveLength(0);
    expect(worktreeSnapshot(worktrees.core)).toEqual(before);

    // the merge step: no `ark worktree sync`, the fetch of the failed open already holds origin/main
    git(worktrees.core, "fetch", "origin");
    Bun.spawnSync(["git", "merge", "origin/main"], { cwd: worktrees.core });
    writeFileSync(join(worktrees.core, "README.md"), "merged\n");
    git(worktrees.core, "commit", "-am", "merge origin/main");
    testedAtHead(runDirectory, worktrees);

    const opened = ark("merge-request", "open", run);
    expect(opened.code, opened.err).toBe(0);
    expect(pushedBranches(bares.core)).toContain(`refs/heads/ark/${run}`);
    expect(pushedBranches(bares.app)).toContain(`refs/heads/ark/${run}`);
    expect(created()).toHaveLength(2);
  },
  { timeout: 60_000 },
);

test(
  "ARK-T239 merge-request open refuses when the merge check itself errors, shows git's text and pushes nothing",
  () => {
    // a branch with no common ancestor with origin/main: git merge-tree fails with an error that is not a conflict
    const { runDirectory, worktrees, bares } = fetchableScenario();
    const root = git(
      worktrees.core,
      "commit-tree",
      "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      "-m",
      "unrelated",
    );
    git(worktrees.core, "reset", "--hard", root);
    testedAtHead(runDirectory, worktrees);

    const refused = ark("merge-request", "open", run);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("unrelated histories");
    expect(pushedBranches(bares.core)).toBe("");
    expect(pushedBranches(bares.app)).toBe("");
    expect(created()).toHaveLength(0);
  },
  { timeout: 60_000 },
);
