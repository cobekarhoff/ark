import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

const roles = {
  implementer: { harness: "claude", model: "claude-sonnet" },
  validator: { harness: "codex", model: "gpt-codex" },
  reviewer: { harness: "codex", model: "gpt-codex" },
};

function gitOutput(directory: string, ...args: string[]): string {
  return Bun.spawnSync(["git", "-C", directory, ...args])
    .stdout.toString()
    .trim();
}

/** A meta-repo: root files, repos/a, and a nested repos/b/c. The root is not a git repo. */
function tempMetaWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "ark-meta-"));
  writeFileSync(join(workspace, "AGENTS.md"), "workspace rules\n");
  writeFileSync(join(workspace, "compose.yml"), "services: {}\n");
  writeFileSync(join(workspace, ".DS_Store"), "");
  for (const repo of ["repos/a", "repos/b/c"]) {
    mkdirSync(dirname(join(workspace, repo)), { recursive: true });
    renameSync(tempGitRepo({ "readme.txt": repo }), join(workspace, repo));
  }
  return workspace;
}

/** Starts a run in a project whose workspace is `workspace`. Returns the run id and the run folder. */
function startRun(
  workspace: string,
  criteriaIds = ["FAKE-1-AC1"],
  title = "Ticket FAKE-1",
): { runId: string; runDirectory: string } {
  const arkHome = tempArkHome();
  writeProject("demo", {
    workspace,
    ticket_source: "local",
    suites: [{ name: "unit", level: "unit", repo: ".", command: "true", parser: "bun" }],
    roles,
  });
  const ticket = writeTicket(
    "demo",
    "FAKE-1",
    criteriaIds.map((id) => ({ id, text: `criterion ${id}` })),
    title,
  );
  const started = ark("run", "start", ticket, "--project", "demo");
  const runId = started.out.match(/\d{4}-\d{2}-\d{2}-FAKE-1-\d+/)![0];
  const runDirectory = join(arkHome, "projects", "demo", "runs", runId);
  recordEvaluation(runDirectory);
  return { runId, runDirectory };
}

function addRemote(workspace: string): void {
  const remote = mkdtempSync(join(tmpdir(), "ark-remote-"));
  const initialized = Bun.spawnSync(["git", "init", "--bare", "-b", "main", remote]);
  if (initialized.exitCode !== 0) throw new Error(initialized.stderr.toString());
  for (const args of [
    ["remote", "add", "origin", remote],
    ["push", "-u", "origin", "main"],
    ["remote", "set-head", "origin", "main"],
  ]) {
    const result = Bun.spawnSync(["git", "-C", workspace, ...args]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }
}

function approveAndOpenMergeRequest(runDirectory: string, openMergeRequest = true): void {
  writeFileSync(join(runDirectory, "plan.yml"), "steps: []\n");
  recordEvaluation(runDirectory);
  appendEvent(runDirectory, "plan.checked", {
    valid: true,
    problems: [],
    plan_hash: planHash(runDirectory),
    steps: [],
  });
  appendEvent(runDirectory, "gate.answered", { gate: "plan", answer: "approve" });
  if (!openMergeRequest) return;
  appendEvent(runDirectory, "merge_request.opened", {
    repo: ".",
    url: "https://example.com/mr/1",
    number: 1,
  });
}

function closeRun(
  runId: string,
  runDirectory: string,
  outcome: string,
): { out: string; code: number } {
  if (outcome === "abandoned" || outcome === "merged") approveAndOpenMergeRequest(runDirectory);
  const result = ark("run", "close", runId, outcome);
  return { out: result.out, code: result.code };
}

function createdEvents(runDirectory: string) {
  return readFileSync(join(runDirectory, "events.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((event) => event.type === "worktree.created");
}

describe("workspace mirror", () => {
  test("ARK-154-AC1 a meta-repo run mirrors the workspace: named repo is a worktree, everything else a symlink", () => {
    const workspace = tempMetaWorkspace();
    const { runId, runDirectory } = startRun(workspace);
    const result = ark("worktree", "create", runId, "repos/a");
    expect(result.code).toBe(0);

    const mirror = join(runDirectory, "workspace");
    const worktree = join(mirror, "repos/a");
    expect(lstatSync(worktree).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(worktree, ".git")).isFile()).toBe(true);
    expect(gitOutput(worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "ark/FAKE-1-ticket-fake-1",
    );

    expect(readlinkSync(join(mirror, "repos/b/c"))).toBe(join(workspace, "repos/b/c"));
    expect(lstatSync(join(mirror, "repos/b")).isSymbolicLink()).toBe(false);
    expect(readlinkSync(join(mirror, "AGENTS.md"))).toBe(join(workspace, "AGENTS.md"));
    expect(readlinkSync(join(mirror, "compose.yml"))).toBe(join(workspace, "compose.yml"));
    expect(lstatSync(join(mirror, "repos")).isSymbolicLink()).toBe(false);
    expect(existsSync(join(mirror, ".DS_Store"))).toBe(false);

    expect(createdEvents(runDirectory)).toEqual([
      expect.objectContaining({
        data: {
          repo: "repos/a",
          path: worktree,
          branch: "ark/FAKE-1-ticket-fake-1",
          base: gitOutput(join(workspace, "repos/a"), "rev-parse", "HEAD"),
        },
      }),
    ]);
  });

  test("ARK-154-AC1 a nested repo becomes a worktree at its usual path", () => {
    const workspace = tempMetaWorkspace();
    const { runId, runDirectory } = startRun(workspace);
    expect(ark("worktree", "create", runId, "repos/b/c").code).toBe(0);

    const mirror = join(runDirectory, "workspace");
    expect(lstatSync(join(mirror, "repos/b/c/.git")).isFile()).toBe(true);
    expect(lstatSync(join(mirror, "repos/a")).isSymbolicLink()).toBe(true);
  });

  test("ARK-154-AC1 a single-repo workspace gets one worktree and no symlinks", () => {
    const workspace = tempGitRepo({ "AGENTS.md": "rules\n", "src/main.txt": "x" });
    const { runId, runDirectory } = startRun(workspace);
    expect(ark("worktree", "create", runId, ".").code).toBe(0);

    const mirror = join(runDirectory, "workspace");
    expect(lstatSync(join(mirror, ".git")).isFile()).toBe(true);
    expect(lstatSync(join(mirror, "AGENTS.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(mirror, "src/main.txt"), "utf8")).toBe("x");
    expect(gitOutput(mirror, "rev-parse", "--abbrev-ref", "HEAD")).toBe("ark/FAKE-1-ticket-fake-1");
  });

  test("ARK-154-AC1 with no repos named, the repos of the last valid plan are used", () => {
    const workspace = tempMetaWorkspace();
    const { runId, runDirectory } = startRun(workspace);
    expect(ark("worktree", "create", runId).code).toBe(1);

    const plan = {
      design: { interfaces: [{ name: "fixture plan", callers: ["ark worktree create"] }] },
      summary: {
        why: "Select repositories for the worktree.",
        changes: [
          {
            criterion: "FAKE-1-AC1",
            where: "workspace",
            now: "The fixture plan names no summary.",
            fix: "The valid plan selects the nested repository.",
          },
        ],
      },
      steps: [
        {
          id: "build",
          role: "implementer",
          repo: "repos/b/c",
          harness: "claude",
          model: "claude-sonnet",
          needs: [],
          criteria: ["FAKE-1-AC1"],
        },
      ],
      test_cases: [
        {
          id: "proves-ac1",
          criterion: "FAKE-1-AC1",
          level: "e2e",
          given: [],
          when: ["run it"],
          // oxlint-disable-next-line unicorn/no-thenable -- plan test-case field `then: string[]`, not a Promise-like
          then: ["it works"],
          expected: "it works",
        },
      ],
    };
    writeFileSync(join(runDirectory, "plan.yml"), JSON.stringify(plan));
    expect(ark("plan", "check", runId).code).toBe(0);
    expect(ark("worktree", "create", runId).code).toBe(0);

    expect(lstatSync(join(runDirectory, "workspace/repos/b/c/.git")).isFile()).toBe(true);
    expect(lstatSync(join(runDirectory, "workspace/repos/a")).isSymbolicLink()).toBe(true);
  });

  test("ARK-154-AC2 running again keeps existing worktrees, creates missing ones and refuses unknown repos", () => {
    const workspace = tempMetaWorkspace();
    const { runId, runDirectory } = startRun(workspace);
    const mirror = join(runDirectory, "workspace");
    expect(ark("worktree", "create", runId, "repos/a").code).toBe(0);
    writeFileSync(join(mirror, "repos/a/scratch.txt"), "work in progress");

    const again = ark("worktree", "create", runId, "repos/a", "repos/b/c");
    expect(again.code).toBe(0);
    expect(readFileSync(join(mirror, "repos/a/scratch.txt"), "utf8")).toBe("work in progress");
    expect(lstatSync(join(mirror, "repos/b/c/.git")).isFile()).toBe(true);
    expect(createdEvents(runDirectory).map((event) => event.data.repo)).toEqual([
      "repos/a",
      "repos/b/c",
    ]);

    const unknown = ark("worktree", "create", runId, "repos/nope");
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("repos/nope");
  });

  test("ARK-154-AC2 an unknown repo among valid ones creates nothing", () => {
    const workspace = tempMetaWorkspace();
    const { runId, runDirectory } = startRun(workspace);
    const result = ark("worktree", "create", runId, "repos/a", "repos/nope");
    expect(result.code).toBe(1);
    expect(existsSync(join(runDirectory, "workspace/repos/a"))).toBe(false);
    expect(createdEvents(runDirectory)).toEqual([]);
  });

  test("ARK-154-AC4 walking up from a worktree finds the workspace AGENTS.md through the mirror", () => {
    const workspace = tempMetaWorkspace();
    const { runId, runDirectory } = startRun(workspace);
    expect(ark("worktree", "create", runId, "repos/b/c").code).toBe(0);

    let directory = join(runDirectory, "workspace/repos/b/c");
    while (!existsSync(join(directory, "AGENTS.md"))) directory = dirname(directory);

    const found = join(directory, "AGENTS.md");
    expect(directory).toBe(join(runDirectory, "workspace"));
    expect(lstatSync(found).isSymbolicLink()).toBe(true);
    expect(realpathSync(found)).toBe(realpathSync(join(workspace, "AGENTS.md")));
    expect(readFileSync(found, "utf8")).toBe("workspace rules\n");
  });
});
describe("ARK-167 worktree lifecycle", () => {
  test("ARK-167-AC1 worktree branches use a lowercase title slug capped at 40 characters", () => {
    const workspace = tempGitRepo();
    const { runId, runDirectory } = startRun(
      workspace,
      ["FAKE-1-AC1"],
      "A VERY Long, Mixed-Case Ticket Title! With punctuation and more than forty characters",
    );

    expect(ark("worktree", "create", runId, ".").code).toBe(0);
    const branch = gitOutput(join(runDirectory, "workspace"), "branch", "--show-current");
    expect(branch).toBe("ark/FAKE-1-a-very-long-mixed-case-ticket-title-with");
    expect(branch).not.toContain("2026-");
    expect(branch.slice("ark/FAKE-1-".length)).toHaveLength(40);
  });

  test("ARK-167-AC1 later runs append their run number to the branch", () => {
    const workspace = tempGitRepo();
    const first = startRun(workspace, ["FAKE-1-AC1"], "Useful Ticket");
    expect(ark("run", "close", first.runId, "aborted").code).toBe(0);

    const ticket = writeTicket(
      "demo",
      "FAKE-1",
      [{ id: "FAKE-1-AC1", text: "criterion FAKE-1-AC1" }],
      "Useful Ticket",
    );
    const started = ark("run", "start", ticket, "--project", "demo");
    const secondRunId = started.out.trim();
    const secondRunDirectory = join(
      process.env.ARK_HOME as string,
      "projects",
      "demo",
      "runs",
      secondRunId,
    );
    expect(ark("worktree", "create", secondRunId, ".").code).toBe(0);
    expect(gitOutput(join(secondRunDirectory, "workspace"), "branch", "--show-current")).toBe(
      "ark/FAKE-1-useful-ticket-2",
    );
  });

  test("ARK-167-AC2 closing an abandoned run removes a clean worktree and its branch", () => {
    const workspace = tempGitRepo();
    const { runId, runDirectory } = startRun(workspace);
    expect(ark("worktree", "create", runId, ".").code).toBe(0);
    const path = join(runDirectory, "workspace");
    const branch = gitOutput(path, "branch", "--show-current");

    const closed = closeRun(runId, runDirectory, "abandoned");
    expect(closed.code).toBe(0);
    expect(existsSync(path)).toBe(false);
    expect(gitOutput(workspace, "branch", "--list", branch)).toBe("");
  });

  test("ARK-167-AC2 closing keeps dirty worktrees and merged branches outside the target", () => {
    const workspace = tempGitRepo();
    addRemote(workspace);
    const { runId, runDirectory } = startRun(workspace);
    expect(ark("worktree", "create", runId, ".").code).toBe(0);
    const path = join(runDirectory, "workspace");
    const branch = gitOutput(path, "branch", "--show-current");
    writeFileSync(join(path, "uncommitted.txt"), "dirty\n");
    const dirtyClose = closeRun(runId, runDirectory, "aborted");
    expect(dirtyClose.out).toContain("kept     .");
    expect(dirtyClose.out).toContain("uncommitted changes");
    expect(existsSync(path)).toBe(true);
    expect(gitOutput(workspace, "rev-parse", "--verify", `refs/heads/${branch}`)).not.toBe("");

    const anotherTicket = writeTicket("demo", "FAKE-1", [
      { id: "FAKE-1-AC1", text: "criterion FAKE-1-AC1" },
    ]);
    const anotherStarted = ark("run", "start", anotherTicket, "--project", "demo");
    const anotherRunId = anotherStarted.out.trim();
    const anotherRunDirectory = join(
      process.env.ARK_HOME as string,
      "projects",
      "demo",
      "runs",
      anotherRunId,
    );
    expect(ark("worktree", "create", anotherRunId, ".").code).toBe(0);
    const unmergedPath = join(anotherRunDirectory, "workspace");
    writeFileSync(join(unmergedPath, "committed.txt"), "branch-only change\n");
    const staged = Bun.spawnSync(["git", "-C", unmergedPath, "add", "committed.txt"]);
    expect(staged.exitCode).toBe(0);
    const committed = Bun.spawnSync([
      "git",
      "-C",
      unmergedPath,
      "commit",
      "-m",
      "branch-only change",
    ]);
    expect(committed.exitCode).toBe(0);
    const unmergedBranch = gitOutput(unmergedPath, "branch", "--show-current");
    const unmergedClose = closeRun(anotherRunId, anotherRunDirectory, "merged");
    expect(unmergedClose.out).toContain("kept     .");
    expect(unmergedClose.out).toContain("branch is not in main");
    expect(existsSync(unmergedPath)).toBe(true);
    expect(gitOutput(workspace, "rev-parse", "--verify", `refs/heads/${unmergedBranch}`)).not.toBe(
      "",
    );
  });
});

/** A workspace that is not a repo and holds the repos `a` and `b`. */
function tempTwoRepoWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "ark-two-"));
  for (const repo of ["a", "b"])
    renameSync(tempGitRepo({ "readme.txt": repo }), join(workspace, repo));
  return workspace;
}

/** A workspace that is a repo and holds the nested repo `repos/x`. */
function tempRootWithNestedWorkspace(): string {
  const workspace = tempGitRepo({ "AGENTS.md": "rules\n" });
  mkdirSync(join(workspace, "repos"));
  renameSync(tempGitRepo({ "readme.txt": "x" }), join(workspace, "repos/x"));
  return workspace;
}

/** Same as `startRun` but records no evaluation: the caller moves the run to the phase it needs. */
function startFreshRun(): { runId: string; runDirectory: string } {
  const arkHome = tempArkHome();
  writeProject("demo", {
    workspace: tempGitRepo(),
    ticket_source: "local",
    suites: [{ name: "unit", level: "unit", repo: ".", command: "true", parser: "bun" }],
    roles,
  });
  const ticket = writeTicket("demo", "FAKE-1", [{ id: "FAKE-1-AC1", text: "criterion" }]);
  const runId = ark("run", "start", ticket, "--project", "demo").out.trim();
  return { runId, runDirectory: join(arkHome, "projects", "demo", "runs", runId) };
}

describe("ARK-276 anchor worktree", () => {
  test("ARK-276-AC2 anchor of a root-repo workspace is the run worktree, printed once and recorded once", () => {
    const workspace = tempGitRepo();
    const { runId, runDirectory } = startRun(workspace);
    const mirror = join(runDirectory, "workspace");

    const first = ark("worktree", "anchor", runId);
    expect(first.code).toBe(0);
    expect(first.out).toBe(`path:${mirror}\n`);
    expect(lstatSync(join(mirror, ".git")).isFile()).toBe(true);
    expect(gitOutput(mirror, "rev-parse", "--abbrev-ref", "HEAD")).toBe("ark/FAKE-1-ticket-fake-1");
    const state = JSON.parse(readFileSync(join(runDirectory, "state.json"), "utf8"));
    expect(state.worktrees.map((worktree: { repo: string }) => worktree.repo)).toEqual(["."]);

    const second = ark("worktree", "anchor", runId);
    expect(second.code).toBe(0);
    expect(second.out).toBe(first.out);
    expect(createdEvents(runDirectory)).toHaveLength(1);
  });

  test("ARK-276-AC3 without a root repo the anchor is the first repo, and create keeps it and makes the other", () => {
    const { runId, runDirectory } = startRun(tempTwoRepoWorkspace());
    const mirror = join(runDirectory, "workspace");

    const anchor = ark("worktree", "anchor", runId);
    expect(anchor.code).toBe(0);
    expect(anchor.out).toBe(`path:${join(mirror, "a")}\n`);
    expect(lstatSync(join(mirror, "a/.git")).isFile()).toBe(true);
    expect(existsSync(join(mirror, "b"))).toBe(false);

    const create = ark("worktree", "create", runId, "a", "b");
    expect(create.code).toBe(0);
    expect(create.out).toMatch(/exists\s+a\n/);
    expect(create.out).toMatch(/created\s+b /);
    expect(lstatSync(join(mirror, "b/.git")).isFile()).toBe(true);
    expect(createdEvents(runDirectory).map((event) => event.data.repo)).toEqual(["a", "b"]);
  });

  test("ARK-276-AC3 with a root repo and a nested repo the anchor is the mirror root, and create keeps it and makes the nested repo", () => {
    const { runId, runDirectory } = startRun(tempRootWithNestedWorkspace());
    const mirror = join(runDirectory, "workspace");

    const anchor = ark("worktree", "anchor", runId);
    expect(anchor.code).toBe(0);
    expect(anchor.out).toBe(`path:${mirror}\n`);

    const create = ark("worktree", "create", runId, ".", "repos/x");
    expect(create.code).toBe(0);
    expect(create.out).toMatch(/exists\s+\.\n/);
    expect(create.out).toMatch(/created\s+repos\/x /);
    expect(lstatSync(join(mirror, "repos/x/.git")).isFile()).toBe(true);
    expect(createdEvents(runDirectory).map((event) => event.data.repo)).toEqual([".", "repos/x"]);
  });

  test("ARK-276-AC4 anchor works in awaiting_criteria, awaiting_strategy, planning and building, and is refused in closed like create", () => {
    const phaseOf = (runId: string) => ark("status", runId).out;

    const criteria = startFreshRun();
    recordEvaluation(criteria.runDirectory, ["a blocker the human must accept"]);
    expect(phaseOf(criteria.runId)).toContain("awaiting_criteria");
    expect(ark("worktree", "anchor", criteria.runId).code).toBe(0);

    const strategy = startFreshRun();
    appendEvent(strategy.runDirectory, "evaluation.recorded", {
      blockers: [],
      risks: [],
      surfaces: ["none"],
    });
    appendEvent(strategy.runDirectory, "strategy.recorded", {
      count: 2,
      recommended: "S1",
      cards: ["S1", "S2"],
      reason: "two fit",
      card_text: { S1: "### S1 One", S2: "### S2 Two" },
    });
    expect(phaseOf(strategy.runId)).toContain("awaiting_strategy");
    expect(ark("worktree", "anchor", strategy.runId).code).toBe(0);

    const planning = startFreshRun();
    recordEvaluation(planning.runDirectory);
    expect(phaseOf(planning.runId)).toContain("planning");
    expect(ark("worktree", "anchor", planning.runId).code).toBe(0);

    const building = startFreshRun();
    recordEvaluation(building.runDirectory);
    approveAndOpenMergeRequest(building.runDirectory, false);
    expect(phaseOf(building.runId)).toContain("building");
    expect(ark("worktree", "anchor", building.runId).code).toBe(0);

    const closed = startFreshRun();
    recordEvaluation(closed.runDirectory);
    expect(closeRun(closed.runId, closed.runDirectory, "aborted").code).toBe(0);
    const refused = ark("worktree", "anchor", closed.runId);
    const create = ark("worktree", "create", closed.runId, ".");
    expect(refused.code).toBe(1);
    expect(create.code).toBe(1);
    expect(refused.err).toContain("worktree.created refused: run is closed (aborted)");
    expect(refused.err).toBe(create.err);
  });

  test("ARK-276-AC5 closing the run removes the anchor worktree and its branch", () => {
    const workspace = tempGitRepo();
    const { runId, runDirectory } = startRun(workspace);
    const path = join(runDirectory, "workspace");
    expect(ark("worktree", "anchor", runId).code).toBe(0);
    const branch = gitOutput(path, "branch", "--show-current");
    expect(branch).toBe("ark/FAKE-1-ticket-fake-1");

    const closed = closeRun(runId, runDirectory, "aborted");
    expect(closed.code).toBe(0);
    expect(existsSync(path)).toBe(false);
    expect(gitOutput(workspace, "branch", "--list", branch)).toBe("");
    expect(gitOutput(workspace, "worktree", "list")).not.toContain(path);
  });

  test("ARK-276-AC5 closing removes the anchor of a two-repo workspace and of a root repo with a nested worktree", () => {
    const two = tempTwoRepoWorkspace();
    const first = startRun(two);
    expect(ark("worktree", "anchor", first.runId).code).toBe(0);
    const anchorPath = join(first.runDirectory, "workspace/a");
    const anchorBranch = gitOutput(anchorPath, "branch", "--show-current");
    expect(closeRun(first.runId, first.runDirectory, "aborted").code).toBe(0);
    expect(existsSync(anchorPath)).toBe(false);
    expect(gitOutput(join(two, "a"), "branch", "--list", anchorBranch)).toBe("");

    const nested = tempRootWithNestedWorkspace();
    const second = startRun(nested);
    expect(ark("worktree", "anchor", second.runId).code).toBe(0);
    expect(ark("worktree", "create", second.runId, "repos/x").code).toBe(0);
    const rootPath = join(second.runDirectory, "workspace");
    const rootBranch = gitOutput(rootPath, "branch", "--show-current");
    const closed = closeRun(second.runId, second.runDirectory, "aborted");
    expect(closed.code).toBe(0);
    expect(closed.out).not.toContain("kept");
    expect(existsSync(rootPath)).toBe(false);
    expect(gitOutput(nested, "branch", "--list", rootBranch)).toBe("");
  });

  test("ARK-276-AC3 merge-request open skips an untouched anchor and opens nothing", () => {
    const workspace = tempGitRepo();
    const { runId, runDirectory } = startRun(workspace);
    expect(ark("worktree", "anchor", runId).code).toBe(0);
    approveAndOpenMergeRequest(runDirectory, false);
    const mirror = join(runDirectory, "workspace");
    appendEvent(runDirectory, "test.completed", {
      passed: true,
      heads: { ".": gitOutput(mirror, "rev-parse", "HEAD") },
      suites: [],
      criteria: {},
    });

    const opened = ark("merge-request", "open", runId);
    expect(opened.code).toBe(0);
    expect(opened.out).toBe("");
    const events = readFileSync(join(runDirectory, "events.ndjson"), "utf8");
    expect(events).not.toContain('"merge_request.opened"');
  });
});

describe("ARK-276 anchor path is resolved", () => {
  test("ARK-276-AC9 anchor and step-worker paths are real paths under the run folder", () => {
    const workspace = tempGitRepo();
    const { runId, runDirectory } = startRun(workspace);
    const printed = ark("worktree", "anchor", runId).out;
    expect(printed).toMatch(/^path:\/[^\n]+\n$/);
    const anchor = printed.slice("path:".length, -1);
    expect(anchor).toBe(realpathSync(anchor));
    expect(anchor).toBe(join(runDirectory, "workspace"));
    const stepWorker = join(anchor, "repos/a");
    mkdirSync(stepWorker, { recursive: true });
    expect(stepWorker).toBe(realpathSync(stepWorker));
  });
});
