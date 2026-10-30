import { beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendEvent } from "../cli/events.ts";
import { ark, tempArkHome, tempGitRepo, writeProject, writeTicket } from "./helpers.ts";

const playbookDirectory = join(import.meta.dir, "../skills/ark/playbooks");
const roles = {
  implementer: { harness: "claude", model: "claude-sonnet" },
  validator: { harness: "codex", model: "gpt-codex" },
  reviewer: { harness: "codex", model: "gpt-codex" },
};

function git(directory: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", directory, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function commitFile(directory: string, name: string, content: string): void {
  writeFileSync(join(directory, name), content);
  git(directory, "add", name);
  git(directory, "commit", "-m", `update ${name}`);
}
function makeWorkspace(repoNames = ["."]): string {
  if (repoNames.length === 1 && repoNames[0] === ".") {
    const workspace = tempGitRepo({ "shared.txt": "base\n" });
    configureOrigin(workspace);
    return workspace;
  }
  const workspace = mkdtempSync(join(tmpdir(), "ark-sync-workspace-"));
  for (const repoName of repoNames) {
    const source = tempGitRepo({ "shared.txt": "base\n" });
    const repoPath = join(workspace, repoName);
    mkdirSync(dirname(repoPath), { recursive: true });
    renameSync(source, repoPath);
    configureOrigin(repoPath);
  }
  return workspace;
}

function configureOrigin(repoPath: string): void {
  const bare = mkdtempSync(join(tmpdir(), "ark-sync-origin-"));
  git(bare, "init", "--bare");
  git(repoPath, "remote", "add", "origin", bare);
  git(repoPath, "push", "-u", "origin", "main");
  git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
  git(repoPath, "remote", "set-head", "origin", "main");
}

function startRun(repoNames = ["."]) {
  const workspace = makeWorkspace(repoNames);
  tempArkHome();
  const projectDirectory = writeProject("demo", {
    workspace,
    ticket_source: "local",
    suites: [{ name: "integration", level: "integration", repo: ".", command: "true", parser: "bun" }],
    roles,
  });
  const ticketFile = writeTicket("demo", "ARK-900", [{ id: "ARK-900-AC1", text: "Sync fixture" }], "Sync test");
  const started = ark("run", "start", ticketFile, "--project", "demo");
  if (started.code !== 0) throw new Error(started.err || started.out);
  const actualRunId = started.out.trim();
  const runDirectory = join(projectDirectory, "runs", actualRunId);
  const steps = [{ id: "build", role: "implementer", repo: repoNames[0], harness: "claude", model: "claude-sonnet", needs: [], criteria: ["ARK-900-AC1"] }];
  const plan = {
    summary: {
      why: "Prepare the sync fixture.",
      changes: [{ criterion: "ARK-900-AC1", where: "workspace", now: "The fixture has no sync plan.", fix: "The fixture has a valid sync plan." }],
    },
    steps,
    test_cases: [{ id: "sync-fixture", criterion: "ARK-900-AC1", level: "integration", steps: ["prepare sync fixture"], expected: "fixture is ready" }],
  };
  writeFileSync(join(runDirectory, "plan.yml"), JSON.stringify(plan));
  const checked = ark("plan", "check", actualRunId);
  if (checked.code !== 0) throw new Error(checked.err || checked.out);
  const approved = ark("gate", "record", actualRunId, "plan", "approve");
  if (approved.code !== 0) throw new Error(approved.err || approved.out);
  const created = ark("worktree", "create", actualRunId, ...repoNames);
  if (created.code !== 0) throw new Error(created.err || created.out);
  return {
    workspace,
    runId: actualRunId,
    runDirectory,
    worktreePath: (repoName = ".") => join(runDirectory, "workspace", repoName),
  };
}

function advanceOrigin(workspace: string, repoName: string, file: string, content: string): string {
  const repoPath = repoName === "." ? workspace : join(workspace, repoName);
  const clone = mkdtempSync(join(tmpdir(), "ark-sync-clone-"));
  git(clone, "clone", git(repoPath, "remote", "get-url", "origin"), ".");
  git(clone, "config", "user.name", "Ark Test");
  git(clone, "config", "user.email", "ark@example.com");
  commitFile(clone, file, content);
  git(clone, "push", "origin", "main");
  return git(clone, "rev-parse", "HEAD");
}

let fakeGhDirectory = "";
beforeEach(() => {
  fakeGhDirectory = mkdtempSync(join(tmpdir(), "ark-sync-bin-"));
  const fakeGh = join(fakeGhDirectory, "gh");
  writeFileSync(fakeGh, `#!/usr/bin/env bun\nconst states = JSON.parse(process.env.FAKE_GH_STATES ?? "{}");\nconsole.log(JSON.stringify({ state: states[process.argv[4]] ?? "OPEN" }));\n`);
  chmodSync(fakeGh, 0o755);
  process.env.PATH = `${fakeGhDirectory}:${process.env.PATH ?? ""}`;
});

test("ARK-165-AC1 status reports every merged MR and allows closing, while an open MR stays open", () => {
  const scenario = startRun(["repos/a", "repos/b"]);
  const mergeRequests = [
    { repo: "repos/a", url: "https://github.com/acme/a/pull/1", number: 1 },
    { repo: "repos/b", url: "https://github.com/acme/b/pull/2", number: 2 },
  ];
  for (const mergeRequest of mergeRequests) appendEvent(scenario.runDirectory, "merge_request.opened", mergeRequest);
  process.env.FAKE_GH_STATES = JSON.stringify({ [mergeRequests[0].url]: "MERGED", [mergeRequests[1].url]: "MERGED" });

  const merged = ark("merge-request", "status", scenario.runId);
  expect(merged.code).toBe(0);
  expect(merged.out).toContain("repos/a  merged  https://github.com/acme/a/pull/1");
  expect(merged.out).toContain("repos/b  merged  https://github.com/acme/b/pull/2");
  expect(ark("run", "close", scenario.runId, "merged").code).toBe(0);

  const openScenario = startRun();
  const openMergeRequest = { repo: ".", url: "https://github.com/acme/main/pull/3", number: 3 };
  appendEvent(openScenario.runDirectory, "merge_request.opened", openMergeRequest);
  process.env.FAKE_GH_STATES = JSON.stringify({ [openMergeRequest.url]: "OPEN" });
  const open = ark("merge-request", "status", openScenario.runId);
  expect(open.code).toBe(0);
  expect(open.out).toContain(".  open  https://github.com/acme/main/pull/3");
});

test("ARK-165-AC1 ARK-165-AC2 Chief polls on every wait, closes merged runs and notifies other leads with the synced head", () => {
  const chief = readFileSync(join(playbookDirectory, "chief.md"), "utf8");
  const supervise = chief.split("## 7. Supervise")[1]?.split("\n## ")[0] ?? "";
  const close = chief.split("## 8. Close the run")[1]?.split("\n## ")[0] ?? "";
  expect(supervise).toContain("On every wait, including an empty one, run `ark merge-request status <run>`");
  expect(supervise).toContain("If every MR of a run is merged, go to section 8");
  expect(close).toContain("ark run close <run> merged");
  expect(close).toContain("ark workspace sync <run>");
  expect(close).toContain("For every other open run, send its lead a `status` message");
  expect(close).toContain("target branch and the head that `ark workspace sync` printed");
});

test("ARK-165-AC3 run lead syncs status-notified worktrees before starting the next step", () => {
  const runLead = readFileSync(join(playbookDirectory, "run-lead.md"), "utf8");
  const steps = runLead.split("## 7. Run the steps")[1]?.split("\n## ")[0] ?? "";
  expect(steps).toContain("Before you start any step, read your mail");
  expect(steps).toContain("If you got one, run this before `ark run step ... start`");
  expect(steps).toContain("ark worktree sync <run>");
  expect(steps).toContain("pushes the branch of every repo with an open MR");
});

test("ARK-165-AC3 worktree sync merges origin, pushes only MR worktrees and aborts conflicts", () => {
  const pushedScenario = startRun();
  const worktree = pushedScenario.worktreePath();
  const targetHead = advanceOrigin(pushedScenario.workspace, ".", "target.txt", "target\n");
  const mergeRequest = { repo: ".", url: "https://github.com/acme/main/pull/1", number: 1 };
  appendEvent(pushedScenario.runDirectory, "merge_request.opened", mergeRequest);
  const pushed = ark("worktree", "sync", pushedScenario.runId);
  expect(pushed.code).toBe(0);
  expect(git(worktree, "rev-parse", "HEAD")).toBe(targetHead);
  expect(git(worktree, "merge-base", "HEAD", targetHead)).toBe(targetHead);
  expect(git(pushedScenario.workspace, "rev-parse", "origin/ark/" + pushedScenario.runId)).toBe(git(worktree, "rev-parse", "HEAD"));

  const unpushedScenario = startRun();
  const unpushedTarget = advanceOrigin(unpushedScenario.workspace, ".", "target.txt", "target\n");
  expect(ark("worktree", "sync", unpushedScenario.runId).code).toBe(0);
  expect(git(unpushedScenario.worktreePath(), "merge-base", "HEAD", unpushedTarget)).toBe(unpushedTarget);
  expect(Bun.spawnSync(["git", "-C", unpushedScenario.workspace, "rev-parse", "origin/ark/" + unpushedScenario.runId]).exitCode).not.toBe(0);

  const conflictScenario = startRun();
  commitFile(conflictScenario.worktreePath(), "shared.txt", "worktree\n");
  advanceOrigin(conflictScenario.workspace, ".", "shared.txt", "target\n");
  const conflict = ark("worktree", "sync", conflictScenario.runId);
  expect(conflict.code).toBe(1);
  expect(conflict.err).toContain("repo .:");
  expect(git(conflictScenario.worktreePath(), "status", "--porcelain")).toBe("");
  expect(git(conflictScenario.worktreePath(), "rev-parse", "HEAD")).not.toBe(git(conflictScenario.workspace, "rev-parse", "origin/main"));
});

test("ARK-165-AC4 workspace sync fast-forwards clean and unrelated-dirty checkouts but preserves conflicting changes", () => {
  const cleanScenario = startRun();
  advanceOrigin(cleanScenario.workspace, ".", "first.txt", "first\n");
  const cleanHead = advanceOrigin(cleanScenario.workspace, ".", "target.txt", "second\n");
  const first = ark("workspace", "sync", cleanScenario.runId);
  expect(first.code).toBe(0);
  expect(first.out).toContain(`.  main  ${cleanHead}`);
  expect(git(cleanScenario.workspace, "rev-parse", "main")).toBe(cleanHead);

  const conflictingScenario = startRun();
  writeFileSync(join(conflictingScenario.workspace, "shared.txt"), "local\n");
  const unchangedHead = git(conflictingScenario.workspace, "rev-parse", "main");
  advanceOrigin(conflictingScenario.workspace, ".", "shared.txt", "remote\n");
  const conflicting = ark("workspace", "sync", conflictingScenario.runId);
  expect(conflicting.code).toBe(1);
  expect(conflicting.err).toContain("repo .:");
  expect(git(conflictingScenario.workspace, "rev-parse", "main")).toBe(unchangedHead);
  expect(readFileSync(join(conflictingScenario.workspace, "shared.txt"), "utf8")).toBe("local\n");

  const unrelatedScenario = startRun();
  writeFileSync(join(unrelatedScenario.workspace, "local.txt"), "keep\n");
  const unrelatedHead = advanceOrigin(unrelatedScenario.workspace, ".", "target.txt", "remote\n");
  const unrelated = ark("workspace", "sync", unrelatedScenario.runId);
  expect(unrelated.code).toBe(0);
  expect(git(unrelatedScenario.workspace, "rev-parse", "main")).toBe(unrelatedHead);
  expect(readFileSync(join(unrelatedScenario.workspace, "local.txt"), "utf8")).toBe("keep\n");
});
