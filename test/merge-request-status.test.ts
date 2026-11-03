import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent } from "../cli/events.ts";
import { planHash } from "../cli/plan.ts";
import {
  ark,
  recordEvaluation,
  tempArkHome,
  tempGitRepo,
  writeProject,
  writeTicket,
} from "./helpers.ts";

const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
});

const SINCE = "2026-11-01T00:00:00Z";
type Answers = Record<string, unknown>;
const GH_CORE = "https://github.com/example/core/pull";
const GL = "https://gitlab.com/example/app/-/merge_requests";

/** Fake gh and glab: each answers from `answers`, keyed by its exact argument list. A missing key fails with exit 1, like an unreachable host. */
function fakeHosts(answers: Answers) {
  const bin = mkdtempSync(join(tmpdir(), "ark-status-hosts-"));
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
  process.env.PATH = `${bin}:${originalPath}`;
}

function openRun(extra: { repo: string; url: string; number: number }[]) {
  tempArkHome();
  const workspace = tempGitRepo({
    "contract.test.ts":
      'import { expect, test } from "bun:test"; test("ARK-900-AC1 fixture", () => expect(2 + 2).toBe(4));\n',
  });
  const projectDirectory = writeProject("demo", {
    workspace,
    ticket_source: "local",
    round_budget: 1,
    suites: [
      {
        name: "integration",
        level: "integration",
        repo: ".",
        command: "bun test --reporter=junit --reporter-outfile={report}",
        parser: "bun",
      },
    ],
    roles: {
      implementer: { harness: "omp", model: "test" },
      validator: { harness: "omp", model: "test" },
      reviewer: { harness: "omp", model: "test" },
    },
  });
  const ticketFile = writeTicket("demo", "ARK-900", [{ id: "ARK-900-AC1", text: "Fixture works" }]);
  const runId = ark("run", "start", ticketFile, "--project", "demo").out.trim();
  const directory = join(projectDirectory, "runs", runId);
  const steps = ["implementer", "validator", "reviewer"].map((role) => ({
    id: role,
    role,
    repo: ".",
    needs: [],
    criteria: ["ARK-900-AC1"],
  }));
  writeFileSync(join(directory, "plan.yml"), JSON.stringify({ steps }));
  recordEvaluation(directory);
  appendEvent(directory, "plan.checked", {
    valid: true,
    problems: [],
    plan_hash: planHash(directory),
    steps,
  });
  ark("gate", "record", runId, "plan", "approve");
  ark("worktree", "create", runId);
  ark("run", "step", runId, "implementer", "start");
  ark("run", "step", runId, "implementer", "finish");
  appendEvent(directory, "merge_request.opened", {
    repo: ".",
    url: `${GH_CORE}/1`,
    number: 1,
  });
  for (const merge of extra) {
    appendEvent(directory, "worktree.created", {
      repo: merge.repo,
      path: workspace,
      branch: "main",
    });
    appendEvent(directory, "merge_request.opened", merge);
  }
  return runId;
}

const ghView = (url: string, view: object) => ({
  [`gh pr view ${url} --json state,statusCheckRollup,mergeable`]: view,
});
const ghComments = (
  owner: string,
  repo: string,
  number: number,
  pulls: object[],
  issues: object[],
) => ({
  [`gh api repos/${owner}/${repo}/pulls/${number}/comments --paginate`]: pulls,
  [`gh api repos/${owner}/${repo}/issues/${number}/comments --paginate`]: issues,
});
const glView = (number: number, view: object) => ({
  [`glab mr view ${number} --output json`]: view,
});
const open = { state: "OPEN", mergeable: "MERGEABLE" };
const merge = (repo: string, url: string, number: number) => ({
  repo,
  url,
  number,
});

test("ARK-200-AC1 status prints ci passed, failed, running and none, and --json lists each failed check with its URL", () => {
  const runId = openRun([
    merge("running", "https://github.com/example/run/pull/2", 2),
    merge("none", "https://github.com/example/none/pull/3", 3),
    merge("failing", "https://github.com/example/fail/pull/4", 4),
    merge("gitlab", `${GL}/5`, 5),
  ]);
  fakeHosts({
    ...ghView(`${GH_CORE}/1`, {
      ...open,
      statusCheckRollup: [
        { name: "build", conclusion: "SUCCESS" },
        { name: "docs", conclusion: "SKIPPED" },
      ],
    }),
    ...ghView("https://github.com/example/run/pull/2", {
      ...open,
      statusCheckRollup: [
        { name: "build", conclusion: "SUCCESS" },
        { name: "slow", conclusion: null, state: "PENDING" },
      ],
    }),
    ...ghView("https://github.com/example/none/pull/3", {
      ...open,
      statusCheckRollup: [],
    }),
    ...ghView("https://github.com/example/fail/pull/4", {
      ...open,
      statusCheckRollup: [
        {
          name: "lint",
          conclusion: "FAILURE",
          detailsUrl: "https://ci.example/lint",
        },
        { name: "slow", conclusion: null, state: "PENDING" },
        { name: "build", conclusion: "SUCCESS" },
      ],
    }),
    ...glView(5, {
      state: "opened",
      has_conflicts: false,
      head_pipeline: { id: 42, status: "failed" },
    }),
    "glab api projects/:id/pipelines/42/jobs?scope[]=failed --paginate": [
      { name: "gl-test", web_url: "https://gitlab.com/example/app/-/jobs/9" },
    ],
  });

  const plain = ark("merge-request", "status", runId);
  expect(plain.code).toBe(0);
  expect(plain.out.trim().split("\n")).toEqual([
    `.  open  ${GH_CORE}/1  ci: passed`,
    "running  open  https://github.com/example/run/pull/2  ci: running",
    "none  open  https://github.com/example/none/pull/3  ci: none",
    "failing  open  https://github.com/example/fail/pull/4  ci: failed  checks failing: lint",
    `gitlab  open  ${GL}/5  ci: failed  checks failing: gl-test`,
  ]);

  const json = JSON.parse(ark("merge-request", "status", runId, "--json").out);
  expect(json.map((entry: { ci: string }) => entry.ci)).toEqual([
    "passed",
    "running",
    "none",
    "failed",
    "failed",
  ]);
  expect(json[3].failedChecks).toEqual([{ name: "lint", url: "https://ci.example/lint" }]);
  expect(json[4].failedChecks).toEqual([
    { name: "gl-test", url: "https://gitlab.com/example/app/-/jobs/9" },
  ]);
  expect(json[0].failedChecks).toEqual([]);
});

test("ARK-200-AC2 --since lists only human comments after the time, from GitHub and GitLab, and without --since lists none", () => {
  const runId = openRun([merge("gitlab", `${GL}/5`, 5)]);
  const user = (login: string, type = "User") => ({ login, type });
  fakeHosts({
    ...ghView(`${GH_CORE}/1`, { ...open, statusCheckRollup: [] }),
    "gh api user --jq .login": "ark-user",
    ...ghComments(
      "example",
      "core",
      1,
      [
        {
          user: user("maria"),
          path: "src/status.ts",
          line: 42,
          body: "Should this fall back\nto unknown?",
          html_url: "https://github.com/example/core/pull/1#discussion_r1",
          created_at: "2026-11-02T10:00:00Z",
        },
        {
          user: user("old-timer"),
          path: "a.ts",
          line: 1,
          body: "before the time",
          html_url: "https://github.com/example/core/pull/1#discussion_r0",
          created_at: "2026-10-31T23:59:59Z",
        },
        {
          user: user("ark-user"),
          path: "a.ts",
          line: 2,
          body: "my own agent",
          html_url: "https://github.com/example/core/pull/1#discussion_r2",
          created_at: "2026-11-02T11:00:00Z",
        },
      ],
      [
        {
          user: user("general-gary"),
          body: "Please rebase",
          html_url: "https://github.com/example/core/pull/1#issuecomment-3",
          created_at: "2026-11-01T09:00:00Z",
        },
        {
          user: user("codecov", "Bot"),
          body: "coverage report",
          html_url: "https://github.com/example/core/pull/1#issuecomment-4",
          created_at: "2026-11-02T12:00:00Z",
        },
        {
          user: user("dependabot[bot]"),
          body: "bump",
          html_url: "https://github.com/example/core/pull/1#issuecomment-5",
          created_at: "2026-11-02T12:00:00Z",
        },
      ],
    ),
    ...glView(5, {
      state: "opened",
      has_conflicts: false,
      head_pipeline: null,
    }),
    "glab api user": { username: "ark-user" },
    "glab api projects/:id/merge_requests/5/notes?per_page=100 --paginate": [
      {
        id: 77,
        system: false,
        author: { username: "lena" },
        position: { new_path: "lib/x.ts", new_line: 7 },
        body: "Nit here",
        created_at: "2026-11-03T08:00:00Z",
      },
      {
        id: 78,
        system: true,
        author: { username: "lena" },
        body: "added 1 commit",
        created_at: "2026-11-03T08:01:00Z",
      },
      {
        id: 79,
        system: false,
        author: { username: "project_bot", bot: true },
        body: "pipeline report",
        created_at: "2026-11-03T08:02:00Z",
      },
      {
        id: 80,
        system: false,
        author: { username: "ark-user" },
        body: "agent note",
        created_at: "2026-11-03T08:03:00Z",
      },
    ],
  });

  const withSince = ark("merge-request", "status", runId, "--since", SINCE);
  expect(withSince.code).toBe(0);
  expect(withSince.out.trim().split("\n")).toEqual([
    `.  open  ${GH_CORE}/1  ci: none`,
    "  @general-gary  (general)  Please rebase  https://github.com/example/core/pull/1#issuecomment-3",
    "  @maria  src/status.ts:42  Should this fall back to unknown?  https://github.com/example/core/pull/1#discussion_r1",
    `gitlab  open  ${GL}/5  ci: none`,
    `  @lena  lib/x.ts:7  Nit here  ${GL}/5#note_77`,
  ]);

  const json = JSON.parse(ark("merge-request", "status", runId, "--since", SINCE, "--json").out);
  expect(json[0].comments).toEqual([
    {
      author: "general-gary",
      path: null,
      line: null,
      body: "Please rebase",
      url: "https://github.com/example/core/pull/1#issuecomment-3",
      createdAt: "2026-11-01T09:00:00Z",
    },
    {
      author: "maria",
      path: "src/status.ts",
      line: 42,
      body: "Should this fall back\nto unknown?",
      url: "https://github.com/example/core/pull/1#discussion_r1",
      createdAt: "2026-11-02T10:00:00Z",
    },
  ]);

  const without = ark("merge-request", "status", runId);
  expect(without.out).not.toContain("@");
  expect(JSON.parse(ark("merge-request", "status", runId, "--json").out)[0].comments).toEqual([]);
});

test("ARK-200-AC2 --since with an unparseable time is refused", () => {
  const runId = openRun([]);
  fakeHosts({});
  const result = ark("merge-request", "status", runId, "--since", "yesterday-ish");
  expect(result.code).toBe(1);
  expect(result.err).toContain("--since");
});

test("ARK-200-AC3 status prints conflict for a conflicting GitHub MR and a GitLab MR with conflicts, and not for a clean MR", () => {
  const runId = openRun([
    merge("gh-conflict", "https://github.com/example/c/pull/2", 2),
    merge("gl-conflict", `${GL}/3`, 3),
  ]);
  fakeHosts({
    ...ghView(`${GH_CORE}/1`, { ...open, statusCheckRollup: [] }),
    ...ghView("https://github.com/example/c/pull/2", {
      state: "OPEN",
      mergeable: "CONFLICTING",
      statusCheckRollup: [],
    }),
    ...glView(3, { state: "opened", has_conflicts: true, head_pipeline: null }),
  });
  const lines = ark("merge-request", "status", runId).out.trim().split("\n");
  expect(lines).toEqual([
    `.  open  ${GH_CORE}/1  ci: none`,
    "gh-conflict  open  https://github.com/example/c/pull/2  ci: none  conflict",
    `gl-conflict  open  ${GL}/3  ci: none  conflict`,
  ]);
  const json = JSON.parse(ark("merge-request", "status", runId, "--json").out);
  expect(json.map((entry: { conflict: boolean }) => entry.conflict)).toEqual([false, true, true]);
});

test("ARK-200-AC4 a failed gh or glab call prints unknown for that value, exits 0, and leaves the other MRs printing normally", () => {
  const runId = openRun([
    merge("gh-down", "https://github.com/example/d/pull/2", 2),
    merge("gl-jobs-down", `${GL}/3`, 3),
  ]);
  fakeHosts({
    ...ghView(`${GH_CORE}/1`, {
      ...open,
      statusCheckRollup: [{ name: "build", conclusion: "SUCCESS" }],
    }),
    // no answer for the gh-down view
    ...glView(3, {
      state: "opened",
      has_conflicts: false,
      head_pipeline: { id: 42, status: "failed" },
    }),
    // no answer for the pipeline jobs; no answer for `glab api user`
  });
  const result = ark("merge-request", "status", runId, "--since", SINCE);
  expect(result.code).toBe(0);
  expect(result.out.trim().split("\n")).toEqual([
    `.  open  ${GH_CORE}/1  ci: passed`,
    "  comments: unknown",
    "gh-down  unknown  https://github.com/example/d/pull/2  ci: unknown  conflict: unknown",
    "  comments: unknown",
    `gl-jobs-down  open  ${GL}/3  ci: unknown`,
    "  comments: unknown",
  ]);
  const json = JSON.parse(ark("merge-request", "status", runId, "--json").out);
  expect(json.map((entry: { ci: string }) => entry.ci)).toEqual(["passed", "unknown", "unknown"]);
  expect(json[1]).toMatchObject({ state: "unknown", conflict: null });
});
