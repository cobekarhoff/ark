import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ark, tempArkHome, tempGitRepo, writeProject, writeTicket } from "./helpers.ts";

const roles = {
  implementer: { harness: "claude", model: "claude-sonnet" },
  validator: { harness: "codex", model: "gpt-codex" },
  reviewer: { harness: "codex", model: "gpt-codex" },
};

function gitOutput(directory: string, ...args: string[]): string {
  return Bun.spawnSync(["git", "-C", directory, ...args]).stdout.toString().trim();
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
function startRun(workspace: string, criteriaIds = ["FAKE-1-AC1"]): { runId: string; runDirectory: string } {
  const arkHome = tempArkHome();
  writeProject("demo", {
    workspace,
    ticket_source: "local",
    suites: [{ name: "unit", level: "unit", repo: ".", command: "true", parser: "bun" }],
    roles,
  });
  const ticket = writeTicket("demo", "FAKE-1", criteriaIds.map((id) => ({ id, text: `criterion ${id}` })));
  const started = ark("run", "start", ticket, "--project", "demo");
  const runId = started.out.match(/\d{4}-\d{2}-\d{2}-FAKE-1-\d+/)![0];
  return { runId, runDirectory: join(arkHome, "projects", "demo", "runs", runId) };
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
    expect(gitOutput(worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`ark/${runId}`);

    expect(readlinkSync(join(mirror, "repos/b/c"))).toBe(join(workspace, "repos/b/c"));
    expect(lstatSync(join(mirror, "repos/b")).isSymbolicLink()).toBe(false);
    expect(readlinkSync(join(mirror, "AGENTS.md"))).toBe(join(workspace, "AGENTS.md"));
    expect(readlinkSync(join(mirror, "compose.yml"))).toBe(join(workspace, "compose.yml"));
    expect(lstatSync(join(mirror, "repos")).isSymbolicLink()).toBe(false);
    expect(existsSync(join(mirror, ".DS_Store"))).toBe(false);

    expect(createdEvents(runDirectory)).toEqual([
      expect.objectContaining({
        data: { repo: "repos/a", path: worktree, branch: `ark/${runId}`, base: gitOutput(join(workspace, "repos/a"), "rev-parse", "HEAD") },
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
    expect(gitOutput(mirror, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`ark/${runId}`);
  });

  test("ARK-154-AC1 with no repos named, the repos of the last valid plan are used", () => {
    const workspace = tempMetaWorkspace();
    const { runId, runDirectory } = startRun(workspace);
    expect(ark("worktree", "create", runId).code).toBe(1);

    const plan = {
      steps: [{ id: "build", role: "implementer", repo: "repos/b/c", harness: "claude", model: "claude-sonnet", needs: [], criteria: ["FAKE-1-AC1"] }],
      test_cases: [{ id: "proves-ac1", criterion: "FAKE-1-AC1", level: "e2e", steps: ["run it"], expected: "it works" }],
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
    expect(createdEvents(runDirectory).map((event) => event.data.repo)).toEqual(["repos/a", "repos/b/c"]);

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
