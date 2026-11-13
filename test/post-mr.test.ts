import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  workspaceWithRepos,
  writeTicket,
} from "./helpers.ts";
import { installFakeOrca, removeFakeOrca } from "./fake-orca.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

const originalPath = process.env.PATH;
afterEach(() => {
  removeFakeOrca();
  process.env.PATH = originalPath;
});

/** A building run; every step in plan.yml starts its worker through the fake Orca (ARK-359). */
function openRun(withMergeRequest = true) {
  tempArkHome();
  installFakeOrca();
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
    harness: "omp",
    model: "test",
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
  if (withMergeRequest)
    appendEvent(directory, "merge_request.opened", {
      repo: ".",
      url: "https://github.com/example/core/pull/1",
      number: 1,
    });
  return { runId, directory, workspace };
}

test("ARK-T221 post-MR validator and reviewer steps persist starts, finishes and real suite results", () => {
  const { runId, directory } = openRun();
  for (const role of ["validator", "reviewer"]) {
    expect(ark("run", "step", runId, role, "start").code).toBe(0);
    expect(readEvents(directory).at(-2)).toMatchObject({
      type: "step.started",
      data: { step: role, role },
    });
    if (role === "reviewer")
      Bun.spawnSync(
        [
          "git",
          "-c",
          "user.name=Ark",
          "-c",
          "user.email=ark@example.com",
          "commit",
          "--allow-empty",
          "-qm",
          "work",
        ],
        { cwd: deriveState(readEvents(directory)).worktrees[0]!.path },
      );
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
    data: { passed: true, criteria: { "ARK-900/AC1": "passing" } },
  });
  expect(ark("status", runId).out).toContain("phase: merge_requests_open");
});

test("ARK-T222 every post-MR implementer round needs a fresh escalation answer, including beyond budget", () => {
  const { runId, directory } = openRun();
  for (const round of [2, 3]) {
    const before = readEvents(directory);
    const refused = ark("run", "step", runId, "implementer", "start");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("record gate escalation");
    expect(readEvents(directory)).toEqual(before);
    expect(ark("gate", "record", runId, "escalation", "one_more_round").code).toBe(0);
    expect(ark("run", "step", runId, "implementer", "start").code).toBe(0);
    expect(readEvents(directory).at(-2)).toMatchObject({
      type: "step.started",
      data: { step: "implementer", round },
    });
    expect(ark("run", "step", runId, "implementer", "finish").code).toBe(0);
  }
});

test("ARK-T223 an escalation answer survives ark test after an MR is open and the next implementer start uses it up", () => {
  const { runId, directory } = openRun();
  expect(ark("gate", "record", runId, "escalation", "one_more_round").code).toBe(0);
  expect(ark("test", runId).code).toBe(0);
  expect(readEvents(directory).at(-1)?.type).toBe("test.completed");
  const answers = () => readEvents(directory).filter((event) => event.type === "gate.answered");
  const answered = answers().length;

  expect(ark("run", "step", runId, "implementer", "start").code).toBe(0);
  expect(answers()).toHaveLength(answered);
  expect(readEvents(directory).at(-2)).toMatchObject({
    type: "step.started",
    data: { step: "implementer", round: 2 },
  });
  expect(ark("run", "step", runId, "implementer", "finish").code).toBe(0);

  const before = readEvents(directory);
  const refused = ark("run", "step", runId, "implementer", "start");
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("record gate escalation");
  expect(readEvents(directory)).toEqual(before);
});

test("ARK-287-AC1 before any MR is open a test.completed event still clears the escalation answer", () => {
  const { runId, directory } = openRun(false);
  const failedTest = () =>
    appendEvent(directory, "test.completed", {
      passed: false,
      heads: {},
      suites: [],
      criteria: { "ARK-900-AC1": "failing" },
    });
  failedTest();
  expect(ark("status", runId).out).toContain("phase: escalation");
  expect(ark("gate", "record", runId, "escalation", "one_more_round").code).toBe(0);
  expect(ark("run", "step", runId, "implementer", "start").code).toBe(0);
  expect(ark("run", "step", runId, "implementer", "finish").code).toBe(0);
  expect(ark("status", runId).out).toContain("phase: building");
  failedTest();
  expect(ark("status", runId).out).toContain("phase: escalation");
});

function emulateHosts(workspace: string, failJobs = false) {
  const executableDirectory = mkdtempSync(join(tmpdir(), "ark-check-hosts-"));
  const github = join(executableDirectory, "gh");
  writeFileSync(
    github,
    `#!/usr/bin/env bun
const number = process.argv[4].split("/").at(-1);
console.log(JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: number === "1" ? [
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
  console.log(JSON.stringify({ state: "opened", has_conflicts: false, head_pipeline: { id: 42, status: "failed" }, pipeline: { id: 41 } }));
} else if (process.argv[3] === "projects/:id/pipelines/42/jobs?scope[]=failed") {
  ${failJobs ? 'console.error("pipeline access denied"); process.exit(1);' : 'console.log(JSON.stringify([{ name: "gitlab-test" }, { name: "gitlab-lint" }]));'}
} else { console.error("unknown host request"); process.exit(1); }
`,
  );
  chmodSync(github, 0o755);
  chmodSync(gitlab, 0o755);
  process.env.PATH = `${executableDirectory}:${originalPath}`;
  return [
    {
      repo: "github-other",
      url: "https://github.com/example/other/pull/2",
      number: 2,
    },
    {
      repo: "gitlab",
      url: "https://gitlab.com/example/app/-/merge_requests/3",
      number: 3,
    },
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
    ".  open  https://github.com/example/core/pull/1  ci: failed  checks failing: linux-test, legacy-lint",
    "github-other  open  https://github.com/example/other/pull/2  ci: failed  checks failing: other-repo-test",
    "gitlab  open  https://gitlab.com/example/app/-/merge_requests/3  ci: failed  checks failing: gitlab-test, gitlab-lint",
  ]);
  expect(readEvents(directory)).toEqual(before);
});

test("ARK-208-AC3 status prints ci: failed when the GitLab pipeline failed, never passed", () => {
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
  expect(result.code).toBe(0);
  expect(result.out.trim().split("\n")).toEqual([
    ".  open  https://github.com/example/core/pull/1  ci: failed  checks failing: linux-test, legacy-lint",
    "gitlab  open  https://gitlab.com/example/app/-/merge_requests/3  ci: failed",
  ]);
});

// A submodule lives on a local bare remote: git refuses the file transport unless told.
function git(directory: string, ...args: string[]): string {
  const result = Bun.spawnSync(
    ["git", "-c", "protocol.file.allow=always", "-C", directory, ...args],
    {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Ark Test",
        GIT_AUTHOR_EMAIL: "ark@example.com",
        GIT_COMMITTER_NAME: "Ark Test",
        GIT_COMMITTER_EMAIL: "ark@example.com",
      },
    },
  );
  expect(result.exitCode, `git ${args.join(" ")}: ${result.stderr.toString()}`).toBe(0);
  return result.stdout.toString().trim();
}

/**
 * Repo `lib` (the upstream) and repo `app` (holds lib as the submodule libs/lib), each with a bare remote. The run has
 * the bump step `bump-lib`, done: libs/lib points at the head of the lib branch. Both MRs are open: !41 of lib, !87 of app.
 */
function submoduleRun() {
  tempArkHome();
  installFakeOrca(); // each plan step starts its worker through Orca (ARK-359)
  const workspace = workspaceWithRepos(["app", "lib"]);
  const root = mkdtempSync(join(tmpdir(), "ark-remotes-"));
  const libRemote = join(root, "lib.git");
  const appRemote = join(root, "app.git");
  for (const remote of [libRemote, appRemote])
    git(root, "init", "--bare", "-q", "-b", "main", remote);
  const libRepo = join(workspace, "lib");
  const appRepo = join(workspace, "app");
  git(libRepo, "remote", "add", "origin", libRemote);
  git(libRepo, "push", "-q", "origin", "main");
  writeFileSync(
    join(appRepo, "contract.test.ts"),
    'import { expect, test } from "bun:test"; test("ARK-900-AC1 fixture", () => expect(2 + 2).toBe(4));\n',
  );
  git(appRepo, "submodule", "add", "-q", libRemote, "libs/lib");
  git(appRepo, "add", "-A");
  git(appRepo, "commit", "-q", "-m", "hold lib as a submodule");
  git(appRepo, "remote", "add", "origin", appRemote);
  git(appRepo, "push", "-q", "origin", "main");
  for (const repo of [libRepo, appRepo]) git(repo, "remote", "set-head", "origin", "main");

  const projectDirectory = writeProject("demo", {
    workspace,
    ticket_source: "local",
    round_budget: 1,
    suites: [
      {
        name: "integration",
        level: "integration",
        repo: "app",
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
  const step = (id: string, role: string, repo: string, needs: string[]) => ({
    id,
    role,
    harness: "omp",
    model: "test",
    repo,
    needs,
    criteria: ["ARK-900-AC1"],
  });
  const steps = [
    step("impl-lib", "implementer", "lib", []),
    step("bump-lib", "implementer", "app", ["impl-lib"]),
    step("validate", "validator", "app", ["bump-lib"]),
    step("review", "reviewer", "app", ["validate"]),
  ];
  writeFileSync(
    join(directory, "plan.yml"),
    JSON.stringify({
      steps,
      repos: [
        { repo: "lib", why: "the library", depends_on: [] },
        {
          repo: "app",
          why: "the consumer",
          depends_on: [
            {
              repo: "lib",
              kind: "submodule",
              pin: "libs/lib",
              evidence: ".gitmodules:1",
              bump: "bump-lib",
            },
          ],
        },
      ],
    }),
  );
  recordEvaluation(directory);
  appendEvent(directory, "plan.checked", {
    valid: true,
    problems: [],
    plan_hash: planHash(directory),
    steps,
  });
  expect(ark("gate", "record", runId, "plan", "approve").code).toBe(0);
  expect(ark("worktree", "create", runId).code).toBe(0);
  const worktrees = deriveState(readEvents(directory)).worktrees;
  const libTree = worktrees.find((worktree) => worktree.repo === "lib")!;
  const appTree = worktrees.find((worktree) => worktree.repo === "app")!;
  const finish = (stepId: string) => {
    expect(ark("run", "step", runId, stepId, "start").code).toBe(0);
    expect(ark("run", "step", runId, stepId, "finish").code).toBe(0);
  };

  // impl-lib: one commit on the lib branch, pushed so that the submodule can fetch it
  writeFileSync(join(libTree.path, "feature.txt"), "the change\n");
  git(libTree.path, "add", "-A");
  git(libTree.path, "commit", "-q", "-m", "the change");
  const branchHead = git(libTree.path, "rev-parse", "HEAD");
  git(libTree.path, "push", "-q", "origin", libTree.branch);
  finish("impl-lib");
  // bump-lib: libs/lib points at the head of the lib branch
  const submodule = join(appTree.path, "libs/lib");
  git(appTree.path, "submodule", "update", "--init", "-q", "libs/lib");
  git(submodule, "fetch", "-q", libTree.path, branchHead);
  git(submodule, "checkout", "-q", "--detach", branchHead);
  git(appTree.path, "commit", "-q", "-am", "point libs/lib at the lib branch");
  finish("bump-lib");

  appendEvent(directory, "merge_request.opened", {
    repo: "lib",
    url: "https://gitlab.com/example/lib/-/merge_requests/41",
    number: 41,
    order: 1,
    waits_for: [],
  });
  appendEvent(directory, "merge_request.opened", {
    repo: "app",
    url: "https://gitlab.com/example/app/-/merge_requests/87",
    number: 87,
    order: 2,
    waits_for: [41],
  });
  return {
    runId,
    directory,
    root,
    libRemote,
    appRemote,
    libTree,
    appTree,
    submodule,
    branchHead,
    finish,
  };
}

test("ARK-T142 after the upstream MR squash merges, the refresh moves the submodule to the merged commit and the push carries it", () => {
  const { runId, root, libRemote, appRemote, libTree, appTree, submodule, branchHead, finish } =
    submoduleRun();
  // The host squash-merges the lib branch: the commit on main differs from the branch head.
  const host = join(root, "host");
  git(root, "clone", "-q", libRemote, host);
  git(host, "merge", "--squash", `origin/${libTree.branch}`);
  git(host, "commit", "-q", "-m", "the change (squashed)");
  const merged = git(host, "rev-parse", "HEAD");
  git(host, "push", "-q", "origin", "main");
  expect(merged).not.toBe(branchHead);
  const answers = {
    "glab mr view 41 --output json": {
      state: "merged",
      merge_commit_sha: null,
      squash_commit_sha: merged,
    },
    "glab mr view 87 --output json": { state: "opened", has_conflicts: false },
  };

  // the host cannot answer: the refresh stops and the pointer stays
  fakeHosts({});
  const refused = ark("bump", "refresh", runId, "bump-lib");
  expect(refused.code).not.toBe(0);
  expect(git(submodule, "rev-parse", "HEAD")).toBe(branchHead);

  fakeHosts(answers);
  const before = ark("merge-request", "status", runId);
  expect(before.out).toContain("  waits for !41 (merged)");
  expect(before.out).toContain(`points at upstream branch ${branchHead.slice(0, 8)}`);

  const refreshed = ark("bump", "refresh", runId, "bump-lib");
  expect(refreshed.code, refreshed.err).toBe(0);
  expect(refreshed.out).toContain(`refreshed bump-lib to ${merged.slice(0, 8)}`);
  expect(git(submodule, "rev-parse", "HEAD")).toBe(merged);
  expect(git(appTree.path, "ls-tree", "HEAD", "libs/lib")).toContain(merged);
  expect(ark("merge-request", "status", runId).out).toContain(`refreshed to ${merged.slice(0, 8)}`);

  finish("validate");
  finish("review");
  const tested = ark("test", runId);
  expect(tested.code, tested.out + tested.err).toBe(0);
  const synced = ark("worktree", "sync", runId);
  expect(synced.code, synced.err).toBe(0);
  expect(git(appRemote, "rev-parse", appTree.branch)).toBe(git(appTree.path, "rev-parse", "HEAD"));
  expect(git(appRemote, "ls-tree", appTree.branch, "libs/lib")).toContain(merged);
});

test("ARK-T142 refreshing a fast-forward merge records the event and makes no commit", () => {
  const { runId, directory, appTree, submodule, branchHead } = submoduleRun();
  // a fast-forward merge: the merged commit is the branch head, already pinned
  fakeHosts({
    "glab mr view 41 --output json": {
      state: "merged",
      merge_commit_sha: branchHead,
    },
  });
  const head = git(appTree.path, "rev-parse", "HEAD");
  const refreshed = ark("bump", "refresh", runId, "bump-lib");
  expect(refreshed.code, refreshed.err).toBe(0);
  expect(refreshed.out).toContain(`refreshed bump-lib to ${branchHead.slice(0, 8)}`);
  expect(git(appTree.path, "rev-parse", "HEAD")).toBe(head);
  expect(git(submodule, "rev-parse", "HEAD")).toBe(branchHead);
  const events = readEvents(directory).filter((event) => event.type === "bump.refreshed");
  expect(events.map((event) => event.data)).toEqual([{ step: "bump-lib", value: branchHead }]);
});

test("ARK-T142 the refresh commit holds only the gitlink, and unrelated staged work stays staged", () => {
  const { runId, root, libRemote, libTree, appTree, branchHead } = submoduleRun();
  const host = join(root, "host");
  git(root, "clone", "-q", libRemote, host);
  git(host, "merge", "--squash", `origin/${libTree.branch}`);
  git(host, "commit", "-q", "-m", "the change (squashed)");
  const merged = git(host, "rev-parse", "HEAD");
  git(host, "push", "-q", "origin", "main");
  expect(merged).not.toBe(branchHead);
  fakeHosts({
    "glab mr view 41 --output json": {
      state: "merged",
      squash_commit_sha: merged,
    },
  });
  writeFileSync(join(appTree.path, "unrelated.txt"), "work in progress\n");
  git(appTree.path, "add", "unrelated.txt");

  const refreshed = ark("bump", "refresh", runId, "bump-lib");
  expect(refreshed.code, refreshed.err).toBe(0);
  expect(git(appTree.path, "show", "--name-only", "--format=", "HEAD")).toBe("libs/lib");
  expect(git(appTree.path, "diff", "--cached", "--name-only")).toBe("unrelated.txt");
});

test("ARK-T142 bump refresh refuses a step that is not a bump step and records nothing", () => {
  const { runId, directory } = openRun();
  const refused = ark("bump", "refresh", runId, "implementer", "--to", "1.0.0");
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("implementer is not a bump step of the plan");
  expect(readEvents(directory).some((event) => event.type === "bump.refreshed")).toBe(false);
});
