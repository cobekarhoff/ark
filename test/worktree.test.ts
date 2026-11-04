import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
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
  writeFakeCommand,
  writeProject,
  writeTicket,
} from "./helpers.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

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
    suites: [
      {
        name: "unit",
        level: "unit",
        repo: ".",
        command: "true",
        parser: "bun",
      },
    ],
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
  appendEvent(runDirectory, "gate.answered", {
    gate: "plan",
    answer: "approve",
  });
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
    const workspace = tempGitRepo({
      "AGENTS.md": "rules\n",
      "src/main.txt": "x",
    });
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
      design: {
        interfaces: [{ name: "fixture plan", callers: ["ark worktree create"] }],
      },
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
    suites: [
      {
        name: "unit",
        level: "unit",
        repo: ".",
        command: "true",
        parser: "bun",
      },
    ],
    roles,
  });
  const ticket = writeTicket("demo", "FAKE-1", [{ id: "FAKE-1-AC1", text: "criterion" }]);
  const runId = ark("run", "start", ticket, "--project", "demo").out.trim();
  return {
    runId,
    runDirectory: join(arkHome, "projects", "demo", "runs", runId),
  };
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

  test("ARK-276-AC5 closing keeps a root anchor that holds real untracked files next to a nested worktree, and deletes nothing", () => {
    const { runId, runDirectory } = startRun(tempRootWithNestedWorkspace());
    expect(ark("worktree", "anchor", runId).code).toBe(0);
    expect(ark("worktree", "create", runId, "repos/x").code).toBe(0);
    const rootPath = join(runDirectory, "workspace");
    writeFileSync(join(rootPath, "repos/mine.txt"), "mine\n");
    writeFileSync(join(rootPath, "my file.txt"), "mine\n");

    const closed = closeRun(runId, runDirectory, "aborted");
    expect(closed.code).toBe(0);
    expect(closed.out).toMatch(/kept\s+\.\s/);
    expect(existsSync(join(rootPath, "repos/mine.txt"))).toBe(true);
    expect(existsSync(join(rootPath, "my file.txt"))).toBe(true);
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

describe("ARK-278 close removes workspace/", () => {
  test("ARK-278-AC5 a clean close removes workspace/ and keeps the other run files", () => {
    const { runId, runDirectory } = startRun(tempMetaWorkspace());
    expect(ark("worktree", "create", runId, "repos/a").code).toBe(0);
    mkdirSync(join(runDirectory, "results"));
    for (const name of ["ticket.md", "plan.md", "retro.md", "metrics.json", "results/r.json"])
      writeFileSync(join(runDirectory, name), "x\n");
    expect(existsSync(join(runDirectory, "workspace"))).toBe(true);

    const closed = closeRun(runId, runDirectory, "aborted");
    expect(closed.code).toBe(0);
    expect(existsSync(join(runDirectory, "workspace"))).toBe(false);
    for (const name of [
      "events.ndjson",
      "ticket.md",
      "plan.md",
      "retro.md",
      "metrics.json",
      "results/r.json",
    ])
      expect(existsSync(join(runDirectory, name))).toBe(true);
  });
});

describe("ARK-280 worker permission setting", () => {
  const settingFile = "tools:\n  approvalMode: yolo\n";

  /** Every file under `directory` as `relative path -> content or link target`, skipping `skip` prefixes. */
  function snapshot(directory: string, skip: string[] = []): Record<string, string> {
    const files: Record<string, string> = {};
    const walk = (current: string) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        const relative = full.slice(directory.length + 1);
        if (skip.includes(relative)) continue;
        if (entry.isSymbolicLink()) files[relative] = `-> ${readlinkSync(full)}`;
        else if (entry.isDirectory()) {
          files[`${relative}/`] = "";
          walk(full);
        } else files[relative] = readFileSync(full, "utf8");
      }
    };
    walk(directory);
    return files;
  }

  /** The state of the main workspace that a worktree must not change: files, refs-free git config, exclude, status. */
  function workspaceState(workspace: string, repo: string) {
    const root = join(workspace, repo);
    return {
      files: snapshot(root, [".git"]),
      config: readFileSync(join(root, ".git/config"), "utf8"),
      exclude: readFileSync(join(root, ".git/info/exclude"), "utf8"),
      status: gitOutput(root, "status", "--porcelain", "--ignored"),
    };
  }

  function assertHiddenFromGit(worktree: string): void {
    expect(gitOutput(worktree, "status", "--porcelain")).toBe("");
    gitOutput(worktree, "add", "-A");
    expect(gitOutput(worktree, "diff", "--cached", "--name-only")).toBe("");
  }

  test("ARK-280-AC2 anchor and create write the setting in the run worktree and keep it out of git status and git add", () => {
    const workspace = tempGitRepo({ "src/main.txt": "x" });
    const { runId, runDirectory } = startRun(workspace);
    const mirror = join(runDirectory, "workspace");

    const anchor = ark("worktree", "anchor", runId);
    expect(anchor.code).toBe(0);
    expect(anchor.out).toContain(`path:${mirror}`);
    expect(readFileSync(join(mirror, ".omp/config.yml"), "utf8")).toBe(settingFile);
    assertHiddenFromGit(mirror);

    // create after anchor keeps the file and the clean status
    expect(ark("worktree", "create", runId, ".").code).toBe(0);
    expect(readFileSync(join(mirror, ".omp/config.yml"), "utf8")).toBe(settingFile);
    assertHiddenFromGit(mirror);
  });

  test("ARK-280-AC2 create alone also writes the setting", () => {
    const workspace = tempGitRepo();
    const { runId, runDirectory } = startRun(workspace);
    expect(ark("worktree", "create", runId, ".").code).toBe(0);
    const mirror = join(runDirectory, "workspace");
    expect(readFileSync(join(mirror, ".omp/config.yml"), "utf8")).toBe(settingFile);
    assertHiddenFromGit(mirror);
  });

  test("ARK-280-AC2 ARK-280-AC3 a meta-repo run writes the setting in each real worktree and not in a linked folder or the workspace", () => {
    const workspace = tempMetaWorkspace();
    const { runId, runDirectory } = startRun(workspace);
    const before = {
      a: workspaceState(workspace, "repos/a"),
      c: workspaceState(workspace, "repos/b/c"),
    };
    const result = ark("worktree", "create", runId, "repos/a");
    expect(result.code).toBe(0);

    const mirror = join(runDirectory, "workspace");
    expect(readFileSync(join(mirror, "repos/a/.omp/config.yml"), "utf8")).toBe(settingFile);
    assertHiddenFromGit(join(mirror, "repos/a"));

    // repos/b/c is a link to the workspace: a write through it would land in the main workspace
    expect(lstatSync(join(mirror, "repos/b/c")).isSymbolicLink()).toBe(true);
    for (const path of ["repos/b/c/.omp", "repos/b/.omp", "repos/.omp", ".omp"]) {
      expect(existsSync(join(mirror, path)), path).toBe(false);
      expect(existsSync(join(workspace, path)), path).toBe(false);
    }
    expect(existsSync(join(workspace, "repos/a/.omp"))).toBe(false);
    expect(workspaceState(workspace, "repos/a")).toEqual(before.a);
    expect(workspaceState(workspace, "repos/b/c")).toEqual(before.c);

    // a second repo gets its own file
    expect(ark("worktree", "create", runId, "repos/b/c").code).toBe(0);
    expect(readFileSync(join(mirror, "repos/b/c/.omp/config.yml"), "utf8")).toBe(settingFile);
    expect(existsSync(join(workspace, "repos/b/c/.omp"))).toBe(false);
  });

  test("ARK-280-AC3 anchor and create change no file in the home folders or the main workspace, including info/exclude and git config", () => {
    const home = mkdtempSync(join(tmpdir(), "ark-userhome-"));
    mkdirSync(join(home, ".omp/agent"), { recursive: true });
    writeFileSync(join(home, ".omp/agent/config.yml"), "tools:\n  approvalMode: always-ask\n");
    const realHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const workspace = tempGitRepo({ "src/main.txt": "x", ".gitignore": "dist\n" });
      writeFileSync(join(workspace, "untracked.txt"), "u");
      const { runId, runDirectory } = startRun(workspace);
      const arkHome = process.env.ARK_HOME as string;
      const runs = join("projects", "demo", "runs");
      const before = {
        home: snapshot(home),
        arkHome: snapshot(arkHome, [runs]),
        workspace: workspaceState(workspace, "."),
      };

      expect(ark("worktree", "anchor", runId).code).toBe(0);
      expect(ark("worktree", "create", runId, ".").code).toBe(0);

      expect(snapshot(home)).toEqual(before.home);
      expect(snapshot(arkHome, [runs])).toEqual(before.arkHome);
      expect(workspaceState(workspace, ".")).toEqual(before.workspace);
      expect(existsSync(join(workspace, ".omp"))).toBe(false);
      // only the run worktree got the file
      expect(existsSync(join(runDirectory, "workspace/.omp/config.yml"))).toBe(true);
    } finally {
      process.env.HOME = realHome;
    }
  });

  test("ARK-280-AC3 the written file holds one key, tools.approvalMode, and nothing else", () => {
    const { runId, runDirectory } = startRun(tempGitRepo());
    expect(ark("worktree", "create", runId, ".").code).toBe(0);
    const mirror = join(runDirectory, "workspace");
    expect(readdirSync(join(mirror, ".omp")).sort()).toEqual([".gitignore", "config.yml"]);
    expect(readFileSync(join(mirror, ".omp/.gitignore"), "utf8")).toBe("*\n");
    expect(Bun.YAML.parse(readFileSync(join(mirror, ".omp/config.yml"), "utf8"))).toEqual({
      tools: { approvalMode: "yolo" },
    });
  });

  test("ARK-280-AC1 ARK-280-AC5 the how-to names the value the worktree command writes, where it applies and how to turn it off", () => {
    const { runId, runDirectory } = startRun(tempGitRepo());
    expect(ark("worktree", "create", runId, ".").code).toBe(0);
    const written = readFileSync(join(runDirectory, "workspace/.omp/config.yml"), "utf8").match(
      /approvalMode: (\S+)/,
    )![1];

    const howTo = readFileSync(join(import.meta.dir, "../docs/how-to/run-a-ticket.md"), "utf8");
    const named = howTo.match(/`tools\.approvalMode: (\S+?)`/);
    expect(named?.[1]).toBe(written);
    expect(howTo).toContain("`.omp/config.yml`");
    expect(howTo).toMatch(/only to the worktrees Ark makes/);
    expect(howTo).toMatch(/nothing in your `~\/\.omp`/);
    expect(howTo).toMatch(/delete its `\.omp\/config\.yml`/);
  });
});

test("ARK-280-AC5 docs/reference/cli.md matches the generator", () => {
  const root = join(import.meta.dir, "..");
  const path = join(root, "docs/reference/cli.md");
  const before = readFileSync(path, "utf8");
  expect(
    Bun.spawnSync(["bun", join(root, "scripts/cli-reference.ts")], { cwd: root }).exitCode,
  ).toBe(0);
  expect(readFileSync(path, "utf8")).toBe(before);
});

/** Runs `body` with a fake `gh` first on PATH, then restores PATH. */
function withFakeGh<T>(script: string, body: () => T): T {
  const saved = process.env.PATH;
  try {
    writeFakeCommand("gh", script);
    return body();
  } finally {
    process.env.PATH = saved;
  }
}

/** Records a GitHub MR for the root repo so `ark run close` can ask the host about it. */
function openGithubMergeRequest(runDirectory: string): void {
  approveAndOpenMergeRequest(runDirectory, false);
  appendEvent(runDirectory, "merge_request.opened", {
    repo: ".",
    url: "https://github.com/org/repo/pull/1",
    number: 1,
  });
}

function commitIn(path: string, file: string): void {
  writeFileSync(join(path, file), "branch-only change\n");
  for (const args of [
    ["add", file],
    ["commit", "-m", file],
  ]) {
    const result = Bun.spawnSync(["git", "-C", path, ...args]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }
}

describe("ARK-188 worktree branches, cleanup and dirty sources", () => {
  test("ARK-188-AC1 a branch that exists locally makes the new branch get suffix -2, recorded in worktree.created", () => {
    const workspace = tempGitRepo();
    gitOutput(workspace, "branch", "ark/FAKE-1-ticket-fake-1");
    const { runId, runDirectory } = startRun(workspace);

    expect(ark("worktree", "create", runId, ".").code).toBe(0);
    expect(createdEvents(runDirectory).map((event) => event.data.branch)).toEqual([
      "ark/FAKE-1-ticket-fake-1-2",
    ]);
    expect(gitOutput(workspace, "branch", "--list", "ark/FAKE-1-ticket-fake-1-2")).not.toBe("");
  });

  test("ARK-188-AC1 branches that exist only on origin are skipped: the lowest free suffix is used", () => {
    const workspace = tempGitRepo();
    addRemote(workspace);
    for (const name of ["ark/FAKE-1-ticket-fake-1", "ark/FAKE-1-ticket-fake-1-2"])
      Bun.spawnSync(["git", "-C", workspace, "push", "origin", `HEAD:refs/heads/${name}`]);
    const { runId, runDirectory } = startRun(workspace);
    expect(gitOutput(workspace, "branch", "--list", "ark/FAKE-1-*")).toBe("");

    expect(ark("worktree", "create", runId, ".").code).toBe(0);
    expect(createdEvents(runDirectory).map((event) => event.data.branch)).toEqual([
      "ark/FAKE-1-ticket-fake-1-3",
    ]);
  });

  test("ARK-188-AC2 a merged MR deletes the branch although a squash merge left it out of the target", () => {
    const workspace = tempGitRepo();
    addRemote(workspace);
    const { runId, runDirectory } = startRun(workspace);
    expect(ark("worktree", "create", runId, ".").code).toBe(0);
    const path = join(runDirectory, "workspace");
    const branch = gitOutput(path, "branch", "--show-current");
    commitIn(path, "squashed.txt");
    openGithubMergeRequest(runDirectory);

    const closed = withFakeGh(`echo '{"state":"MERGED","statusCheckRollup":[]}'`, () =>
      ark("run", "close", runId, "merged"),
    );
    expect(closed.code).toBe(0);
    expect(closed.out).toContain(`removed  .  ${branch}`);
    expect(gitOutput(workspace, "branch", "--list", branch)).toBe("");
    expect(existsSync(path)).toBe(false);
  });

  test("ARK-188-AC3 a failed fetch with an unknown MR state keeps the branch and names the repo and the reason", () => {
    const workspace = tempGitRepo();
    addRemote(workspace);
    const { runId, runDirectory } = startRun(workspace);
    expect(ark("worktree", "create", runId, ".").code).toBe(0);
    const path = join(runDirectory, "workspace");
    const branch = gitOutput(path, "branch", "--show-current");
    commitIn(path, "unmerged.txt");
    gitOutput(workspace, "remote", "set-url", "origin", join(tmpdir(), "ark-no-such-remote"));
    openGithubMergeRequest(runDirectory);

    const closed = withFakeGh("exit 1", () => ark("run", "close", runId, "merged"));
    expect(closed.out).toContain(`kept     .  ${branch}: could not fetch origin`);
    expect(closed.out).toContain("ark-no-such-remote");
    expect(gitOutput(workspace, "branch", "--list", branch)).not.toBe("");
    expect(existsSync(path)).toBe(true);
  });

  test("ARK-188-AC4 a dirty source repo without --allow-dirty exits 1, lists the path and creates no worktree", () => {
    const workspace = tempGitRepo();
    writeFileSync(join(workspace, "README.md"), "changed\n");
    const { runId, runDirectory } = startRun(workspace);

    const result = ark("worktree", "create", runId, ".");
    expect(result.code).toBe(1);
    expect(result.out + result.err).toContain("README.md");
    expect(existsSync(join(runDirectory, "workspace"))).toBe(false);
    expect(createdEvents(runDirectory)).toEqual([]);
  });

  test("ARK-188-AC5 with --allow-dirty the worktree is created and the changed path is printed as a warning", () => {
    const workspace = tempGitRepo();
    writeFileSync(join(workspace, "README.md"), "changed\n");
    const { runId, runDirectory } = startRun(workspace);

    const result = ark("worktree", "create", runId, ".", "--allow-dirty");
    expect(result.code).toBe(0);
    expect(result.out + result.err).toContain("warning");
    expect(result.out + result.err).toContain("README.md");
    expect(createdEvents(runDirectory)).toHaveLength(1);
    expect(existsSync(join(runDirectory, "workspace"))).toBe(true);
  });
});

/** Starts a run in a two-repo workspace with a worktree in `a` and `b`, and a passed test, so it may close `handed_off`. */
function handedOffRun() {
  const workspace = tempTwoRepoWorkspace();
  const { runId, runDirectory } = startRun(workspace);
  for (const repo of ["a", "b"]) expect(ark("worktree", "create", runId, repo).code).toBe(0);
  approveAndOpenMergeRequest(runDirectory, false);
  appendEvent(runDirectory, "test.completed", {
    passed: true,
    heads: {},
    suites: [{ name: "unit", level: "unit", passed: true }],
    criteria: { "FAKE-1-AC1": "passing" },
  });
  const [a, b] = ["a", "b"].map((repo) => join(runDirectory, "workspace", repo));
  const branch = gitOutput(a, "branch", "--show-current");
  const base = createdEvents(runDirectory).find((event) => event.data.repo === "a").data
    .base as string;
  return { workspace, runId, runDirectory, a, b, branch, base };
}

describe("ARK-294 handed_off close keeps branches with commits", () => {
  test("ARK-294-AC1 closing handed_off keeps a committed branch, removes the worktree and workspace, and prints a kept line", () => {
    const { workspace, runId, runDirectory, a, branch, base } = handedOffRun();
    commitIn(a, "work.txt");
    const commit = gitOutput(a, "rev-parse", "HEAD");

    const closed = closeRun(runId, runDirectory, "handed_off");
    expect(closed.code).toBe(0);
    expect(gitOutput(join(workspace, "a"), "rev-parse", "--verify", branch)).toBe(commit);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(join(runDirectory, "workspace"))).toBe(false);
    expect(closed.out).toContain(
      `kept     a  ${branch}: handed off, 1 commit ahead of ${base.slice(0, 8)}\n`,
    );
  });

  test("ARK-294-AC2 closing handed_off removes an empty branch and counts several commits", () => {
    const { workspace, runId, runDirectory, a, b, branch } = handedOffRun();
    for (const file of ["one.txt", "two.txt", "three.txt"]) commitIn(a, file);

    const closed = closeRun(runId, runDirectory, "handed_off");
    expect(closed.code).toBe(0);
    expect(closed.out).toContain(`removed  b  ${branch}\n`);
    expect(closed.out).toMatch(
      new RegExp(`kept     a  ${branch}: handed off, 3 commits ahead of `),
    );
    expect(existsSync(b)).toBe(false);
    expect(gitOutput(join(workspace, "b"), "branch", "--list", branch)).toBe("");
    expect(gitOutput(join(workspace, "a"), "branch", "--list", branch)).not.toBe("");
  });

  test("ARK-294-AC3 a dirty handed_off worktree and its branch stay", () => {
    const { workspace, runId, runDirectory, a, branch } = handedOffRun();
    commitIn(a, "work.txt");
    writeFileSync(join(a, "untracked.txt"), "dirty\n");

    const closed = closeRun(runId, runDirectory, "handed_off");
    expect(closed.code).toBe(0);
    expect(closed.out).toContain(`kept     a  ${branch}: uncommitted changes`);
    expect(existsSync(a)).toBe(true);
    expect(gitOutput(join(workspace, "a"), "branch", "--list", branch)).not.toBe("");
  });

  test("ARK-294-AC3 an aborted run still deletes a branch that has a commit", () => {
    const { workspace, runId, runDirectory, a, branch } = handedOffRun();
    commitIn(a, "work.txt");

    const closed = closeRun(runId, runDirectory, "aborted");
    expect(closed.code).toBe(0);
    expect(closed.out).toContain(`removed  a  ${branch}\n`);
    expect(gitOutput(join(workspace, "a"), "branch", "--list", branch)).toBe("");
  });

  test("ARK-294-AC3 a handed_off branch whose base is unknown is kept", () => {
    const { workspace, runId, runDirectory, a, branch, base } = handedOffRun();
    commitIn(a, "work.txt");
    const events = join(runDirectory, "events.ndjson");
    writeFileSync(events, readFileSync(events, "utf8").replaceAll(base, "0".repeat(base.length)));

    const closed = closeRun(runId, runDirectory, "handed_off");
    expect(closed.code).toBe(0);
    expect(closed.out).toContain(`kept     a  ${branch}: handed off`);
    expect(gitOutput(join(workspace, "a"), "branch", "--list", branch)).not.toBe("");
  });

  test("ARK-294-AC3 a handed_off branch with commits stays when its worktree directory is already gone", () => {
    const { workspace, runId, runDirectory, a, branch, base } = handedOffRun();
    commitIn(a, "work.txt");
    rmSync(a, { recursive: true, force: true });

    const closed = closeRun(runId, runDirectory, "handed_off");
    expect(closed.code).toBe(0);
    expect(closed.out).toContain(
      `kept     a  ${branch}: handed off, 1 commit ahead of ${base.slice(0, 8)}\n`,
    );
    expect(gitOutput(join(workspace, "a"), "branch", "--list", branch)).not.toBe("");
  });

  test("ARK-294-AC4 the close description, reference, CONTEXT, chief playbook and how-to say the branches stay", () => {
    const root = join(import.meta.dir, "..");
    const text = (path: string) => readFileSync(join(root, path), "utf8");
    const log = "git -C <repo> log <base>..<branch>";

    for (const path of ["cli/ark.ts", "docs/reference/cli.md"])
      expect(text(path)).toContain(
        "For handed_off it keeps each branch with commits beyond its base",
      );
    expect(text("CONTEXT.md")).toMatch(
      /Each branch with commits beyond its base stays in its clone/,
    );
    expect(text("skills/ark/playbooks/chief.md")).toContain(log);
    expect(text("docs/how-to/run-a-ticket.md")).toContain(log);
    expect(text("docs/how-to/run-a-ticket.md")).toMatch(/stays in its clone/);
  });
});

/** Adds `repos` to the ark.yml that `startRun` wrote (JSON, which is YAML). */
function setRepos(runDirectory: string, repos: Record<string, { base: string }>): void {
  const file = join(runDirectory, "../../ark.yml");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), repos }));
}

/** Pushes one commit to `branch` of `workspace`'s origin from a second clone; returns its sha. */
function pushToOrigin(workspace: string, branch: string, file: string): string {
  const clone = mkdtempSync(join(tmpdir(), "ark-other-clone-"));
  gitOutput(clone, "clone", gitOutput(workspace, "remote", "get-url", "origin"), ".");
  gitOutput(clone, "config", "user.name", "Ark Test");
  gitOutput(clone, "config", "user.email", "ark@example.com");
  gitOutput(clone, "checkout", branch);
  commitIn(clone, file);
  gitOutput(clone, "push", "origin", branch);
  return gitOutput(clone, "rev-parse", "HEAD");
}

/** A clone whose origin has main and release/9 at the same commit, checked out on `checkedOut`. */
function releaseWorkspace(checkedOut: "main" | "release/9" = "main"): string {
  const workspace = tempGitRepo();
  addRemote(workspace);
  gitOutput(workspace, "push", "origin", "main:release/9");
  gitOutput(workspace, "checkout", "-b", "release/9", "origin/release/9");
  gitOutput(workspace, "checkout", checkedOut);
  return workspace;
}

describe("ARK-296 repos.<repo>.base starts the worktree from origin/<base>", () => {
  test("ARK-296-AC2 worktree create fetches origin/<base> and starts from it, not from the clone HEAD", () => {
    const workspace = releaseWorkspace("release/9");
    commitIn(workspace, "local-only.txt"); // on the clone's release/9, not on origin
    const cloneHead = gitOutput(workspace, "rev-parse", "HEAD");
    const originHead = pushToOrigin(workspace, "release/9", "origin-only.txt"); // clone's origin/release/9 is stale
    const { runId, runDirectory } = startRun(workspace);
    setRepos(runDirectory, { ".": { base: "release/9" } });

    expect(ark("worktree", "create", runId, ".").code).toBe(0);
    const worktree = join(runDirectory, "workspace");
    expect(gitOutput(worktree, "rev-parse", "HEAD")).toBe(originHead);
    expect(gitOutput(worktree, "rev-parse", "HEAD")).not.toBe(cloneHead);
    expect(existsSync(join(worktree, "local-only.txt"))).toBe(false);
    expect(createdEvents(runDirectory).map((event) => event.data.base)).toEqual([originHead]);
  });

  test("ARK-296-AC2 worktree anchor starts from origin/<base> and records it as worktree.created.base", () => {
    const workspace = releaseWorkspace("release/9");
    commitIn(workspace, "local-only.txt");
    const originHead = pushToOrigin(workspace, "release/9", "origin-only.txt");
    const { runId, runDirectory } = startRun(workspace);
    setRepos(runDirectory, { ".": { base: "release/9" } });

    const anchor = ark("worktree", "anchor", runId);
    expect(anchor.code).toBe(0);
    const path = anchor.out.trim().replace(/^path:/, "");
    expect(gitOutput(path, "rev-parse", "HEAD")).toBe(originHead);
    expect(createdEvents(runDirectory).map((event) => event.data.base)).toEqual([originHead]);
  });

  test("ARK-296-AC2 a repo with no base still starts from the clone HEAD", () => {
    const workspace = releaseWorkspace("release/9");
    commitIn(workspace, "local-only.txt");
    const cloneHead = gitOutput(workspace, "rev-parse", "HEAD");
    const { runId, runDirectory } = startRun(workspace);
    setRepos(runDirectory, { "repos/other": { base: "release/9" } });

    expect(ark("worktree", "create", runId, ".").code).toBe(0);
    expect(gitOutput(join(runDirectory, "workspace"), "rev-parse", "HEAD")).toBe(cloneHead);
  });

  for (const command of ["create", "anchor"]) {
    test(`ARK-296-AC2 worktree ${command} with a base origin lacks exits 1, names the repo and the fetch error, and makes nothing`, () => {
      const workspace = releaseWorkspace();
      const { runId, runDirectory } = startRun(workspace);
      setRepos(runDirectory, { ".": { base: "release/none" } });

      const result =
        command === "create"
          ? ark("worktree", "create", runId, ".")
          : ark("worktree", "anchor", runId);
      expect(result.code).toBe(1);
      expect(result.err).toContain("repo .");
      expect(result.err).toContain("git fetch origin release/none");
      expect(result.err).toContain("couldn't find remote ref release/none");
      expect(readdirSync(join(runDirectory, "workspace"))).toEqual([]); // the empty mirror folder is made before the fetch
      expect(
        gitOutput(workspace, "worktree", "list", "--porcelain").match(/^worktree /gm),
      ).toHaveLength(1);
      expect(gitOutput(workspace, "branch", "--list", "ark/*")).toBe("");
      expect(readFileSync(join(runDirectory, "events.ndjson"), "utf8")).not.toContain(
        "worktree.created",
      );
    });
  }
});

describe("ARK-296 repos.<repo>.base is the target of worktree cleanup and workspace sync", () => {
  /** A run on a clone whose origin has main and release/9. The run branch is pushed to origin/release/9 only, so it is in release/9 and not in main. */
  function pushedToRelease(repos: Record<string, { base: string }>) {
    const workspace = releaseWorkspace();
    const { runId, runDirectory } = startRun(workspace);
    setRepos(runDirectory, repos);
    expect(ark("worktree", "create", runId, ".").code).toBe(0);
    const worktree = join(runDirectory, "workspace");
    const branch = gitOutput(worktree, "branch", "--show-current");
    commitIn(worktree, "squashed.txt");
    gitOutput(worktree, "push", "origin", "HEAD:release/9");
    openGithubMergeRequest(runDirectory);
    return { workspace, runId, runDirectory, worktree, branch };
  }
  const openMergeRequest = `echo '{"state":"OPEN","statusCheckRollup":[]}'`;

  test("ARK-296-AC4 cleanup of a merged run treats a branch in origin/<base> as in the target", () => {
    const { workspace, runId, worktree, branch } = pushedToRelease({ ".": { base: "release/9" } });
    const closed = withFakeGh(openMergeRequest, () => ark("run", "close", runId, "merged"));
    expect(closed.code).toBe(0);
    expect(closed.out).toContain(`removed  .  ${branch}`);
    expect(gitOutput(workspace, "branch", "--list", branch)).toBe("");
    expect(existsSync(worktree)).toBe(false);
  });

  test("ARK-296-AC4 cleanup of a merged run with no base keeps the origin/HEAD target", () => {
    const { workspace, runId, worktree, branch } = pushedToRelease({});
    const closed = withFakeGh(openMergeRequest, () => ark("run", "close", runId, "merged"));
    expect(closed.out).toContain(`kept     .  ${branch}: branch is not in main`);
    expect(gitOutput(workspace, "branch", "--list", branch)).not.toBe("");
    expect(existsSync(worktree)).toBe(true);
  });

  /** A run whose clone is on main and has a local release/9; origin/release/9 then moves ahead. */
  function originMoved(repos: Record<string, { base: string }>) {
    const workspace = releaseWorkspace();
    const { runId, runDirectory } = startRun(workspace);
    setRepos(runDirectory, repos);
    expect(ark("worktree", "create", runId, ".").code).toBe(0);
    return { workspace, runId, releaseHead: pushToOrigin(workspace, "release/9", "r.txt") };
  }

  test("ARK-296-AC4 workspace sync fast-forwards origin/<base> into the local <base> branch", () => {
    const { workspace, runId, releaseHead } = originMoved({ ".": { base: "release/9" } });
    const mainBefore = gitOutput(workspace, "rev-parse", "main");
    const synced = ark("workspace", "sync", runId);
    expect(synced.code).toBe(0);
    expect(synced.out).toContain(`.  release/9  ${releaseHead}`);
    expect(gitOutput(workspace, "rev-parse", "release/9")).toBe(releaseHead);
    expect(gitOutput(workspace, "rev-parse", "main")).toBe(mainBefore);
  });

  test("ARK-296-AC4 workspace sync with no base keeps the origin/HEAD target", () => {
    const { workspace, runId, releaseHead } = originMoved({});
    const staleRelease = gitOutput(workspace, "rev-parse", "release/9");
    const synced = ark("workspace", "sync", runId);
    expect(synced.code).toBe(0);
    expect(synced.out).toContain(`.  main  ${gitOutput(workspace, "rev-parse", "main")}`);
    expect(gitOutput(workspace, "rev-parse", "release/9")).toBe(staleRelease);
    expect(staleRelease).not.toBe(releaseHead);
  });
});

test("ARK-296-AC5 bootstrap step 2 asks for the base of each repo off origin/HEAD, docs/reference documents repos, and cli.md matches the generator", () => {
  const root = join(import.meta.dir, "..");
  const bootstrap = readFileSync(join(root, "skills/ark/playbooks/bootstrap.md"), "utf8");
  const step2 = bootstrap.split("\n## 2.")[1]?.split("\n## ")[0] ?? "";
  expect(step2).toContain("`origin/HEAD`");
  expect(step2).toContain("keep every repo where they differ");
  expect(step2).toContain("These repos are the `repos` candidates. Ask for each one in step 3.");
  const ask = bootstrap.match(/For each `repos` candidate, ask: .*$/m)?.[0] ?? "";
  expect(ask).toContain("origin/HEAD");
  expect(ask).toContain("Recommended:");
  expect(bootstrap).toMatch(/^repos: .*key is the repo path, exactly$/m);

  const reference = readdirSync(join(root, "docs/reference"))
    .map((name) => readFileSync(join(root, "docs/reference", name), "utf8"))
    .join("\n");
  expect(reference).toMatch(/^\| `repos` +\| no +\| map +\|.*\{ base: <branch name> \}/m);

  const path = join(root, "docs/reference/cli.md");
  const before = readFileSync(path, "utf8");
  expect(
    Bun.spawnSync(["bun", join(root, "scripts/cli-reference.ts")], { cwd: root }).exitCode,
  ).toBe(0);
  expect(readFileSync(path, "utf8")).toBe(before);
});
