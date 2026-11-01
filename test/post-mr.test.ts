import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, readEvents } from "../cli/events.ts";
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

function openRun() {
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
  const started = ark("run", "start", ticketFile, "--project", "demo");
  expect(started.code).toBe(0);
  const runId = started.out.trim();
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
  expect(ark("gate", "record", runId, "plan", "approve").code).toBe(0);
  expect(ark("worktree", "create", runId).code).toBe(0);
  expect(ark("run", "step", runId, "implementer", "start").code).toBe(0);
  expect(ark("run", "step", runId, "implementer", "finish").code).toBe(0);
  appendEvent(directory, "merge_request.opened", {
    repo: ".",
    url: "https://github.com/example/core/pull/1",
    number: 1,
  });
  return { runId, directory, workspace };
}

test("ARK-208-AC1 post-MR validator and reviewer steps persist starts, finishes and real suite results", () => {
  const { runId, directory } = openRun();
  for (const role of ["validator", "reviewer"]) {
    expect(ark("run", "step", runId, role, "start").code).toBe(0);
    expect(readEvents(directory).at(-1)).toMatchObject({
      type: "step.started",
      data: { step: role, role },
    });
    expect(ark("run", "step", runId, role, "finish").code).toBe(0);
    expect(readEvents(directory).at(-1)).toMatchObject({
      type: "step.finished",
      data: { step: role, outcome: "succeeded" },
    });
  }
  const result = ark("test", runId);
  expect(result.code).toBe(0);
  expect(readEvents(directory).at(-1)).toMatchObject({
    type: "test.completed",
    data: { passed: true, criteria: { "ARK-900-AC1": "passing" } },
  });
  expect(ark("status", runId).out).toContain("phase: merge_requests_open");
});

test("ARK-208-AC2 every post-MR implementer round needs a fresh escalation answer, including beyond budget", () => {
  const { runId, directory } = openRun();
  for (const round of [2, 3]) {
    const before = readEvents(directory);
    const refused = ark("run", "step", runId, "implementer", "start");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("record gate escalation");
    expect(readEvents(directory)).toEqual(before);
    expect(ark("gate", "record", runId, "escalation", "one_more_round").code).toBe(0);
    expect(ark("run", "step", runId, "implementer", "start").code).toBe(0);
    expect(readEvents(directory).at(-1)).toMatchObject({
      type: "step.started",
      data: { step: "implementer", round },
    });
    expect(ark("run", "step", runId, "implementer", "finish").code).toBe(0);
  }
});

function emulateHosts(workspace: string, failJobs = false) {
  const executableDirectory = mkdtempSync(join(tmpdir(), "ark-check-hosts-"));
  const github = join(executableDirectory, "gh");
  writeFileSync(
    github,
    `#!/usr/bin/env bun
const number = process.argv[4].split("/").at(-1);
console.log(JSON.stringify({ state: "OPEN", statusCheckRollup: number === "1" ? [
  { name: "linux-test", conclusion: "FAILURE" },
  { context: "legacy-lint", state: "ERROR" },
  { name: "passing-build", conclusion: "SUCCESS" },
  { name: "pending-build", conclusion: null, state: "PENDING" }
] : [{ name: "other-repo-test", conclusion: "TIMED_OUT" }] }));
`,
  );
  const gitlab = join(executableDirectory, "glab");
  writeFileSync(
    gitlab,
    `#!/usr/bin/env bun
if (process.argv[2] === "mr") {
  console.log(JSON.stringify({ state: "opened", head_pipeline: { id: 42 }, pipeline: { id: 41 } }));
} else if (process.argv[3] === "projects/:id/pipelines/42/jobs?scope[]=failed") {
  ${failJobs ? 'console.error("pipeline access denied"); process.exit(1);' : 'console.log(JSON.stringify([{ name: "gitlab-test" }, { name: "gitlab-lint" }]));'}
} else { console.error("unknown host request"); process.exit(1); }
`,
  );
  chmodSync(github, 0o755);
  chmodSync(gitlab, 0o755);
  process.env.PATH = `${executableDirectory}:${originalPath}`;
  return [
    { repo: "github-other", url: "https://github.com/example/other/pull/2", number: 2 },
    { repo: "gitlab", url: "https://gitlab.com/example/app/-/merge_requests/3", number: 3 },
  ].map((mergeRequest) => ({ ...mergeRequest, workspace }));
}

test("ARK-208-AC3 status attributes GitHub checks and GitLab head-pipeline job failures to each MR", () => {
  const { runId, directory, workspace } = openRun();
  for (const mergeRequest of emulateHosts(workspace)) {
    appendEvent(directory, "worktree.created", {
      repo: mergeRequest.repo,
      path: workspace,
      branch: "main",
    });
    appendEvent(directory, "merge_request.opened", mergeRequest);
  }
  const before = readEvents(directory);
  const result = ark("merge-request", "status", runId);
  expect(result.code).toBe(0);
  expect(result.out.trim().split("\n")).toEqual([
    ".  open  https://github.com/example/core/pull/1  checks failing: linux-test, legacy-lint",
    "github-other  open  https://github.com/example/other/pull/2  checks failing: other-repo-test",
    "gitlab  open  https://gitlab.com/example/app/-/merge_requests/3  checks failing: gitlab-test, gitlab-lint",
  ]);
  expect(readEvents(directory)).toEqual(before);
});

test("ARK-208-AC3 status preserves host errors rather than treating unavailable checks as passing", () => {
  const { runId, directory, workspace } = openRun();
  const mergeRequest = emulateHosts(workspace, true).find(
    (candidate) => candidate.repo === "gitlab",
  )!;
  appendEvent(directory, "worktree.created", {
    repo: mergeRequest.repo,
    path: workspace,
    branch: "main",
  });
  appendEvent(directory, "merge_request.opened", mergeRequest);
  const result = ark("merge-request", "status", runId);
  expect(result.code).toBe(1);
  expect(result.err).toContain("pipeline access denied");
  expect(result.out).not.toContain("gitlab  open");
});

test("ARK-208-AC4 run-lead orders MR checks, repair verification and sync before its final report", () => {
  const playbook = readFileSync(
    join(import.meta.dir, "../skills/ark/playbooks/run-lead.md"),
    "utf8",
  );
  expect(playbook).toMatch(
    /ark merge-request open <run>[\s\S]*`ark merge-request status <run>`[\s\S]*`gh pr checks <url>`[\s\S]*`ark test <run>`[\s\S]*`ark worktree sync <run>`[\s\S]*`worker_done`/,
  );
});
