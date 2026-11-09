import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent, deriveState, readEvents } from "../cli/events.ts";
import { planHash } from "../cli/plan.ts";
import {
  ark,
  fakeHosts,
  recordEvaluation,
  tempArkHome,
  tempGitRepo,
  writeProject,
  writeTicket,
} from "./helpers.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
});

const SINCE = "2026-11-01T00:00:00Z";
const GH_CORE = "https://github.com/example/core/pull";
const GL = "https://gitlab.com/example/app/-/merge_requests";

/** Opens a run with the "." MR. `options.plan` adds fields to plan.yml; `options.downstream` replaces the "." MR. */
function openRun(
  extra: { repo: string; url: string; number: number }[],
  options: { plan?: object; downstream?: object } = {},
) {
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
  writeFileSync(join(directory, "plan.yml"), JSON.stringify({ steps, ...options.plan }));
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
  appendEvent(
    directory,
    "merge_request.opened",
    options.downstream ?? { repo: ".", url: `${GH_CORE}/1`, number: 1 },
  );
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
          body: `Please rebase ${"onto main ".repeat(12)}`,
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
    `  @general-gary  (general)  Please rebase ${"onto main ".repeat(12).trim()}  https://github.com/example/core/pull/1#issuecomment-3`,
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
      body: `Please rebase ${"onto main ".repeat(12)}`,
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

test("ARK-200-AC4 a failed gh call prints unknown for that value, a failed glab jobs call on a failed pipeline still prints ci failed, and the other MRs print normally", () => {
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
    `gl-jobs-down  open  ${GL}/3  ci: failed`,
    "  comments: unknown",
  ]);
  const json = JSON.parse(ark("merge-request", "status", runId, "--json").out);
  expect(json.map((entry: { ci: string }) => entry.ci)).toEqual(["passed", "unknown", "failed"]);
  expect(json[2].failedChecks).toEqual([]);
  expect(json[1]).toMatchObject({ state: "unknown", conflict: null });
});

const UPSTREAM = merge("core", `${GL}/2`, 2);
const PACKAGE_PIN = "clara-core>=0.0.5rc3,<1.0";
const bumpEdge = (kind: string, pin: string) => ({
  repo: "core",
  kind,
  pin,
  evidence: "pyproject.toml:14",
  bump: "bump-lib",
});

/** A GitLab run whose "." MR (!1) waits for the MR of repo core (!2) and whose plan has one bump step for the edge. */
function bumpRun(kind: string, pin: string, upstream: object) {
  const runId = openRun([UPSTREAM], {
    downstream: { repo: ".", url: `${GL}/1`, number: 1, waits_for: [2] },
    plan: {
      repos: [
        { repo: "core", why: "the library", depends_on: [] },
        { repo: ".", why: "the consumer", depends_on: [bumpEdge(kind, pin)] },
      ],
    },
  });
  fakeHosts({ ...glView(1, { state: "opened", has_conflicts: false }), ...glView(2, upstream) });
  return runId;
}
const statusLines = (runId: string) => {
  const result = ark("merge-request", "status", runId);
  expect(result.code, result.err).toBe(0);
  return result.out.trim().split("\n");
};
const packageBump = (state: string) =>
  `  bump bump-lib  package core  pin ${PACKAGE_PIN}  ${state}`;

test("ARK-T137 status prints the live state of each upstream MR under the MR that waits for it", () => {
  const runId = bumpRun("package", PACKAGE_PIN, { state: "merged" });
  expect(statusLines(runId)).toContain("  waits for !2 (merged)");
});

test("ARK-T137 status prints unknown for an upstream MR when the host call fails", () => {
  const runId = bumpRun("package", PACKAGE_PIN, { state: "merged" });
  // the host answers the downstream MR only: the call for !2 exits 1
  fakeHosts(glView(1, { state: "opened", has_conflicts: false }));
  expect(statusLines(runId)).toContain("  waits for !2 (unknown)");
});

test("ARK-T137 equal MR numbers in two repos print one wait line, for the upstream of the plan edge", () => {
  const other = "https://github.com/example/other/pull/2";
  const runId = openRun([UPSTREAM, merge("other", other, 2)], {
    downstream: { repo: ".", url: `${GL}/1`, number: 1, waits_for: [2] },
    plan: {
      repos: [
        { repo: "core", why: "the library", depends_on: [] },
        { repo: "other", why: "unrelated", depends_on: [] },
        { repo: ".", why: "the consumer", depends_on: [bumpEdge("package", PACKAGE_PIN)] },
      ],
    },
  });
  fakeHosts({
    ...glView(1, { state: "opened", has_conflicts: false }),
    ...glView(2, { state: "merged" }),
    ...ghView(other, { state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: [] }),
  });
  const waits = statusLines(runId).filter((line) => line.includes("waits for !"));
  expect(waits).toEqual(["  waits for !2 (merged)"]);
});

test("ARK-T137 a GitHub MR prints the wait with a literal ! and the upstream state", () => {
  const upstream = "https://github.com/example/core/pull/2";
  const runId = openRun([merge("core", upstream, 2)], {
    downstream: { repo: ".", url: `${GH_CORE}/1`, number: 1, waits_for: [2] },
    plan: {
      repos: [
        { repo: "core", why: "the library", depends_on: [] },
        { repo: ".", why: "the consumer", depends_on: [bumpEdge("package", PACKAGE_PIN)] },
      ],
    },
  });
  fakeHosts({
    ...ghView(`${GH_CORE}/1`, { ...open, statusCheckRollup: [] }),
    ...ghView(upstream, { state: "MERGED", mergeable: "UNKNOWN", statusCheckRollup: [] }),
  });
  expect(statusLines(runId)).toContain("  waits for !2 (merged)");
});

test("ARK-T138 status shows a submodule bump that points at the upstream branch head", () => {
  const runId = bumpRun("submodule", "libs/lib", { state: "opened" });
  const directory = join(process.env.ARK_HOME!, "projects", "demo", "runs", runId);
  const downstream = deriveState(readEvents(directory)).worktrees.find(
    (worktree) => worktree.repo === ".",
  )!;
  const branchHead = "1234567890abcdef1234567890abcdef12345678";
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", downstream.path, ...args]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  };
  git("update-index", "--add", "--cacheinfo", `160000,${branchHead},libs/lib`);
  git("commit", "-m", "point libs/lib at the upstream branch");
  expect(statusLines(runId)).toContain(
    "  bump bump-lib  submodule core  pin libs/lib  points at upstream branch 12345678",
  );
});

test("ARK-T139 status shows a package bump that waits for the upstream merge", () => {
  const runId = bumpRun("package", PACKAGE_PIN, { state: "opened" });
  const lines = statusLines(runId);
  expect(lines).toContain("  waits for !2 (open)");
  expect(lines).toContain(packageBump("waits for upstream merge"));
});

test("ARK-T140 status shows a package bump that waits for the upstream publish", () => {
  const runId = bumpRun("package", PACKAGE_PIN, { state: "merged" });
  expect(statusLines(runId)).toContain(packageBump("waits for upstream publish"));
});

test("ARK-T141 status shows a refreshed bump with the recorded value", () => {
  const runId = bumpRun("package", PACKAGE_PIN, { state: "merged" });
  const refreshed = ark("bump", "refresh", runId, "bump-lib", "--to", "0.0.6rc1");
  expect(refreshed.code, refreshed.err).toBe(0);
  expect(refreshed.out).toContain("refreshed bump-lib to 0.0.6rc1");
  expect(statusLines(runId)).toContain(packageBump("refreshed to 0.0.6rc1"));
});
