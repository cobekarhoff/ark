import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mergeOrder } from "../cli/merge-request";
import { reactSkill, requiredUiSkills } from "../cli/ui-skills";
import {
  ark,
  recordEvaluation,
  tempArkHome,
  tempGitRepo,
  writeProject,
  writeTicket,
} from "./helpers";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

const fixtures = resolve(import.meta.dir, "fixtures/merge-request");
const run = "2026-10-29-ARK-900-1";

type Host = "github" | "gitlab";
type LoggedCall = { tool: string; cwd: string; argv: string[] };

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
const optionValue = (call: LoggedCall, option: string) => call.argv[call.argv.indexOf(option) + 1];

// Three repos. The plan lists app first, but app needs core. docs gets no commits.
function scenario(
  hosts: Record<"core" | "app", Host>,
  testPassed = true,
  manual: string[] = [],
  config: Record<string, unknown> = {},
) {
  tempArkHome();
  const projectDirectory = writeProject("demo", {
    workspace: tmpdir(),
    ticket_source: "local",
    suites: [{ name: "e2e", level: "e2e", repo: ".", command: "true", parser: "bun" }],
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

  const step = (id: string, repo: string, needs: string[], criteria: string[]) => ({
    id,
    role: "implementer",
    repo,
    harness: "claude",
    model: "claude-sonnet",
    needs,
    criteria,
  });
  const steps = [
    step("app-impl", "repos/app", ["core-impl"], ["ARK-900-AC2"]),
    step("core-impl", "repos/core", [], ["ARK-900-AC1"]),
    step("docs-impl", "repos/docs", [], []),
  ];
  writeFileSync(join(runDirectory, "plan.yml"), JSON.stringify({ steps, test_cases: [] }));

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
  for (const name of ["core", "app", "docs"]) {
    const source = tempGitRepo();
    const base = git(source, "branch", "--show-current");
    const bare = mkdtempSync(join(tmpdir(), "ark-bare-"));
    git(bare, "init", "--bare");
    const host: Host = name === "app" ? hosts.app : hosts.core;
    // `remote get-url` reports the host URL; pushes go to the local bare repo.
    git(
      source,
      "remote",
      "add",
      "origin",
      `https://${host === "github" ? "github.com" : "gitlab.com"}/org/${name}.git`,
    );
    git(source, "config", "remote.origin.pushurl", bare);
    const worktree = join(mkdtempSync(join(tmpdir(), "ark-worktree-")), name);
    git(source, "worktree", "add", "-b", `ark/${run}`, worktree, base);
    if (name !== "docs") commit(worktree, name);
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
  return { runDirectory, worktrees, bares };
}

/** Adds an evaluation of `surfaces`, skills on every plan step and a reviewer step with `findings`. */
function uiRun(surfaces: string[], findings?: string) {
  const setup = scenario({ core: "github", app: "github" });
  // The run is past planning, so the evaluation goes in right after run.started, as the real order has it.
  const eventsFile = join(setup.runDirectory, "events.ndjson");
  const lines = readFileSync(eventsFile, "utf8").split("\n").filter(Boolean);
  lines.splice(
    1,
    0,
    JSON.stringify({
      time: "2026-10-29T00:00:00.000Z",
      type: "evaluation.recorded",
      data: { blockers: [], risks: [], surfaces },
    }),
  );
  writeFileSync(
    eventsFile,
    lines.map((line, i) => JSON.stringify({ ...JSON.parse(line), seq: i + 1 })).join("\n") + "\n",
  );
  const plan = JSON.parse(readFileSync(join(setup.runDirectory, "plan.yml"), "utf8"));
  plan.steps[0].skills = [...requiredUiSkills, reactSkill];
  plan.steps[1].skills = requiredUiSkills;
  plan.steps.push({ ...plan.steps[1], id: "ui-review", role: "reviewer", needs: [] });
  writeFileSync(join(setup.runDirectory, "plan.yml"), JSON.stringify(plan));
  if (findings !== undefined) {
    mkdirSync(join(setup.runDirectory, "findings"), { recursive: true });
    writeFileSync(join(setup.runDirectory, "findings", "ui-review.md"), findings);
  }
  return setup;
}

const openedEvents = (runDirectory: string) =>
  readFileSync(join(runDirectory, "events.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.type === "merge_request.opened");

test(
  "ARK-155-AC1 ARK-155-AC2 ARK-155-AC3 ARK-155-AC4 ARK-155-AC5 GitHub: pushes, opens in dependency order, writes events",
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
    expect(git(bares.core, "rev-parse", "--verify", `refs/heads/ark/${run}`)).toBeTruthy();
    expect(git(bares.app, "rev-parse", "--verify", `refs/heads/ark/${run}`)).toBeTruthy();
    expect(
      Bun.spawnSync(["git", "rev-parse", "--verify", `refs/heads/ark/${run}`], { cwd: bares.docs })
        .exitCode,
    ).not.toBe(0);

    const coreBody = optionValue(opened[0], "--body");
    const appBody = optionValue(opened[1], "--body");
    expect(coreBody).toContain("ARK-900 Show units");
    expect(coreBody).toContain("ARK-900-AC1: Core exports units");
    expect(coreBody).not.toContain("ARK-900-AC2");
    expect(coreBody).not.toContain("Depends on");
    expect(appBody).toContain("ARK-900-AC2: App shows units");
    expect(appBody).not.toContain("ARK-900-AC1");
    expect(appBody).toContain("Depends on #1");

    expect(openedEvents(runDirectory).map((event) => event.data)).toEqual([
      { repo: "repos/core", url: "https://github.com/org/core/pull/1", number: 1 },
      { repo: "repos/app", url: "https://github.com/org/app/pull/2", number: 2 },
    ]);

    // Rerun: no new pull request, no new event.
    const rerun = ark("merge-request", "open", run);
    expect(rerun.code).toBe(0);
    expect(created()).toHaveLength(2);
    expect(openedEvents(runDirectory)).toHaveLength(2);

    // ARK-155-AC7 at runtime: no call merged, approved or set auto-merge.
    for (const call of calls()) {
      expect(call.argv.join(" ")).not.toMatch(/\bmerge\b|\bapprove\b|--auto/);
    }
  },
  { timeout: 30_000 },
);

test(
  "ARK-155-AC1 ARK-155-AC3 GitLab: uses glab, `Depends on !N` and a native dependency",
  () => {
    const { runDirectory } = scenario({ core: "gitlab", app: "gitlab" });
    expect(ark("merge-request", "open", run).code).toBe(0);

    const opened = created();
    expect(opened.map((call) => call.tool)).toEqual(["glab", "glab"]);
    expect(optionValue(opened[1], "--source-branch")).toBe(`ark/${run}`);
    expect(optionValue(opened[1], "--description")).toContain("Depends on !1");
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
  "ARK-155-AC3 GitLab: a refused native dependency still opens the merge request with the description line",
  () => {
    process.env.FAKE_GLAB_BLOCK_FAIL = "1";
    const { runDirectory } = scenario({ core: "gitlab", app: "gitlab" });
    expect(ark("merge-request", "open", run).code).toBe(0);
    expect(optionValue(created()[1], "--description")).toContain("Depends on !1");
    expect(openedEvents(runDirectory)).toHaveLength(2);
  },
  { timeout: 30_000 },
);

test(
  "ARK-155-AC1 ARK-155-AC3 each repo uses the host of its own remote",
  () => {
    scenario({ core: "github", app: "gitlab" });
    expect(ark("merge-request", "open", run).code).toBe(0);
    const opened = created();
    expect(opened.map((call) => call.tool)).toEqual(["gh", "glab"]);
    expect(optionValue(opened[1], "--description")).toContain("Depends on !1");
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

test("ARK-155-AC2 mergeOrder follows needs across repos, ties by first appearance, same plan same order", () => {
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
  expect(mergeOrder(plan)).toEqual(["docs", "lib", "api", "web"]);
  expect(mergeOrder(structuredClone(plan))).toEqual(mergeOrder(plan));
});

test("ARK-155-AC2 mergeOrder refuses a dependency cycle between repos", () => {
  const plan = {
    steps: [
      { id: "a-1", repo: "a", needs: ["b-1"], criteria: [] },
      { id: "b-1", repo: "b", needs: ["a-2"], criteria: [] },
      { id: "a-2", repo: "a", needs: [], criteria: [] },
    ],
  };
  expect(() => mergeOrder(plan)).toThrow(/cycle.*a, b/);
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

const findingsFile = `# Findings

### P1: Button has no focus ring
- **File:** src/button.tsx
- **Line:** 12
- **Skill:** ${requiredUiSkills.at(-1)}
- **Rule:** Interactive elements need visible focus

### P2: Off-by-one in pager
- **File:** src/pager.ts
- **Line:** 40
`;

test(
  "ARK-279-AC7 the description has the UI/UX checks section with the skills and the skill finding",
  () => {
    uiRun(["web_ui"], findingsFile);
    expect(ark("merge-request", "open", run).code).toBe(0);
    for (const call of created()) {
      const body = optionValue(call, "--body");
      expect(body).toContain("\n\n## UI/UX checks\n\n");
      expect(body).toContain(`Skills applied: ${[...requiredUiSkills, reactSkill].join(", ")}`);
      expect(body).toContain(
        `- P1 Button has no focus ring (${requiredUiSkills.at(-1)}: Interactive elements need visible focus, src/button.tsx:12)`,
      );
      expect(body).not.toContain("Off-by-one");
      expect(body).not.toContain("No UI/UX findings.");
    }
  },
  { timeout: 30_000 },
);

test(
  "ARK-279-AC7 with no skill finding the description has the No UI/UX findings. bullet",
  () => {
    uiRun(["web_ui"], "### P2: Off-by-one in pager\n- **File:** src/pager.ts\n- **Line:** 40\n");
    expect(ark("merge-request", "open", run).code).toBe(0);
    const body = optionValue(created()[0], "--body");
    expect(body).toContain("## UI/UX checks");
    expect(body).toContain("- No UI/UX findings.");
  },
  { timeout: 30_000 },
);

test(
  "ARK-279-AC8 Surfaces none: no UI/UX checks heading and the description is unchanged",
  () => {
    uiRun(["none"], findingsFile);
    expect(ark("merge-request", "open", run).code).toBe(0);
    const [core, app] = created().map((call) => optionValue(call, "--body"));
    expect(core).toBe(
      "Ticket: ARK-900 Show units\n\nAcceptance criteria this repo serves:\n- ARK-900-AC1: Core exports units",
    );
    expect(app).toBe(
      "Ticket: ARK-900 Show units\n\nAcceptance criteria this repo serves:\n- ARK-900-AC2: App shows units\n\nDepends on #1",
    );
    expect(`${core}${app}`).not.toContain("UI/UX");
  },
  { timeout: 30_000 },
);

// One real repo with a real suite, run through plan check, worktree create and ark test.
function testedRun() {
  tempArkHome();
  const workspace = tempGitRepo({
    "ac.test.ts": `import { test } from "bun:test"; test("ARK-900-AC1 works", () => {});\n`,
  });
  const bare = mkdtempSync(join(tmpdir(), "ark-bare-"));
  git(bare, "init", "--bare");
  git(workspace, "remote", "add", "origin", "https://github.com/org/core.git");
  git(workspace, "config", "remote.origin.pushurl", bare);
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
    expect(git(bare, "branch", "--list")).toBe("");

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
    expect(refused.err).toContain("ARK-900-AC1");
    expect(refused.err).toContain("ARK-900-AC2");
    expect(calls()).toEqual([]);
    expect(openedEvents(runDirectory)).toEqual([]);
    // Nothing was pushed either.
    expect(
      Bun.spawnSync(["git", "rev-parse", "--verify", `refs/heads/ark/${run}`], { cwd: bares.core })
        .exitCode,
    ).not.toBe(0);

    // A problem answer is not ok; only the unanswered or problem criteria are named.
    expect(ark("gate", "record", run, "manual", "ARK-900-AC1", "ok").code).toBe(0);
    expect(ark("gate", "record", run, "manual", "ARK-900-AC2", "problem").code).toBe(0);
    const partial = ark("merge-request", "open", run);
    expect(partial.code).toBe(1);
    expect(partial.err).toContain("ARK-900-AC2");
    expect(partial.err).not.toContain("ARK-900-AC1");
    expect(created()).toEqual([]);

    expect(ark("gate", "record", run, "manual", "ARK-900-AC2", "ok").code).toBe(0);
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
