import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendEvent } from "../cli/events.ts";
import {
  ark,
  recordEvaluation,
  tempArkHome,
  tempGitRepo,
  writeProject,
  writeTicket,
} from "./helpers.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

const playbookDirectory = join(import.meta.dir, "../skills/ark/playbooks");
const roles = {
  implementer: { harness: "claude", model: "claude-sonnet" },
  validator: { harness: "codex", model: "gpt-codex" },
  reviewer: { harness: "codex", model: "gpt-codex" },
};

function git(directory: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", directory, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
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

function startRun(
  repoNames = ["."],
  withValidator = false,
  config: Record<string, unknown> = {},
  prepareWorkspace: (workspace: string) => void = () => {},
) {
  const workspace = makeWorkspace(repoNames);
  prepareWorkspace(workspace);
  tempArkHome();
  const projectDirectory = writeProject("demo", {
    workspace,
    ticket_source: "local",
    suites: [
      {
        name: "integration",
        level: "integration",
        repo: ".",
        command: "true",
        parser: "bun",
      },
    ],
    roles,
    ...config,
  });
  const ticketFile = writeTicket(
    "demo",
    "ARK-900",
    [{ id: "ARK-900-AC1", text: "Sync fixture" }],
    "Sync test",
  );
  const started = ark("run", "start", ticketFile, "--project", "demo");
  if (started.code !== 0) throw new Error(started.err || started.out);
  const actualRunId = started.out.trim();
  const runDirectory = join(projectDirectory, "runs", actualRunId);
  recordEvaluation(runDirectory);
  const steps = [
    {
      id: "build",
      role: "implementer",
      repo: repoNames[0],
      harness: "claude",
      model: "claude-sonnet",
      needs: [],
      criteria: ["ARK-900-AC1"],
    },
    ...(withValidator
      ? [
          {
            id: "check",
            role: "validator",
            repo: repoNames[0],
            harness: "codex",
            model: "gpt-codex",
            needs: ["build"],
            criteria: ["ARK-900-AC1"],
          },
        ]
      : []),
  ];
  const plan = {
    design: { interfaces: [{ name: "fixture plan", callers: ["ark sync"] }] },
    summary: {
      why: "Prepare the sync fixture.",
      changes: [
        {
          criterion: "ARK-900-AC1",
          where: "workspace",
          now: "The fixture has no sync plan.",
          fix: "The fixture has a valid sync plan.",
        },
      ],
    },
    steps,
    test_cases: [
      {
        id: "sync-fixture",
        criterion: "ARK-900-AC1",
        level: "integration",
        given: [],
        when: ["prepare sync fixture"],
        // oxlint-disable-next-line unicorn/no-thenable -- plan test-case field `then: string[]`, not a Promise-like
        then: ["fixture is ready"],
        expected: "fixture is ready",
      },
    ],
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
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env bun\nconst states = JSON.parse(process.env.FAKE_GH_STATES ?? "{}");\nconsole.log(JSON.stringify({ state: states[process.argv[4]] ?? "OPEN", statusCheckRollup: [] }));\n`,
  );
  chmodSync(fakeGh, 0o755);
  process.env.PATH = `${fakeGhDirectory}:${process.env.PATH ?? ""}`;
});

test(
  "ARK-165-AC1 status reports every merged MR and allows closing, while an open MR stays open",
  () => {
    const scenario = startRun(["repos/a", "repos/b"]);
    const mergeRequests = [
      { repo: "repos/a", url: "https://github.com/acme/a/pull/1", number: 1 },
      { repo: "repos/b", url: "https://github.com/acme/b/pull/2", number: 2 },
    ];
    for (const mergeRequest of mergeRequests)
      appendEvent(scenario.runDirectory, "merge_request.opened", mergeRequest);
    process.env.FAKE_GH_STATES = JSON.stringify({
      [mergeRequests[0].url]: "MERGED",
      [mergeRequests[1].url]: "MERGED",
    });

    const merged = ark("merge-request", "status", scenario.runId);
    expect(merged.code).toBe(0);
    expect(merged.out).toContain("repos/a  merged  https://github.com/acme/a/pull/1");
    expect(merged.out).toContain("repos/b  merged  https://github.com/acme/b/pull/2");
    expect(ark("run", "close", scenario.runId, "merged").code).toBe(0);

    const openScenario = startRun();
    const openMergeRequest = {
      repo: ".",
      url: "https://github.com/acme/main/pull/3",
      number: 3,
    };
    appendEvent(openScenario.runDirectory, "merge_request.opened", openMergeRequest);
    process.env.FAKE_GH_STATES = JSON.stringify({
      [openMergeRequest.url]: "OPEN",
    });
    const open = ark("merge-request", "status", openScenario.runId);
    expect(open.code).toBe(0);
    expect(open.out).toContain(".  open  https://github.com/acme/main/pull/3");
  },
  { timeout: 30_000 },
);

test("ARK-165-AC1 ARK-165-AC2 Chief polls on every wait, closes merged runs and notifies other leads with the synced head", () => {
  const chief = readFileSync(join(playbookDirectory, "chief.md"), "utf8");
  const supervise = chief.split("## 7. Supervise")[1]?.split("\n## ")[0] ?? "";
  const close = chief.split("## 8. Close the run")[1]?.split("\n## ")[0] ?? "";
  expect(supervise).toContain(
    "On every wait, including an empty one, run `ark merge-request status <run> --since <last poll time>`",
  );
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

test(
  "ARK-165-AC3 worktree sync merges origin, pushes only MR worktrees and aborts conflicts",
  () => {
    const pushedScenario = startRun();
    const worktree = pushedScenario.worktreePath();
    const targetHead = advanceOrigin(pushedScenario.workspace, ".", "target.txt", "target\n");
    const mergeRequest = {
      repo: ".",
      url: "https://github.com/acme/main/pull/1",
      number: 1,
    };
    appendEvent(pushedScenario.runDirectory, "merge_request.opened", mergeRequest);
    const pushed = ark("worktree", "sync", pushedScenario.runId);
    expect(pushed.code).toBe(0);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(targetHead);
    expect(git(worktree, "merge-base", "HEAD", targetHead)).toBe(targetHead);
    expect(
      git(
        pushedScenario.workspace,
        "rev-parse",
        "origin/" + git(worktree, "branch", "--show-current"),
      ),
    ).toBe(git(worktree, "rev-parse", "HEAD"));

    const unpushedScenario = startRun();
    const unpushedTarget = advanceOrigin(unpushedScenario.workspace, ".", "target.txt", "target\n");
    expect(ark("worktree", "sync", unpushedScenario.runId).code).toBe(0);
    expect(git(unpushedScenario.worktreePath(), "merge-base", "HEAD", unpushedTarget)).toBe(
      unpushedTarget,
    );
    expect(
      Bun.spawnSync([
        "git",
        "-C",
        unpushedScenario.workspace,
        "rev-parse",
        "origin/" + git(unpushedScenario.worktreePath(), "branch", "--show-current"),
      ]).exitCode,
    ).not.toBe(0);

    const conflictScenario = startRun();
    commitFile(conflictScenario.worktreePath(), "shared.txt", "worktree\n");
    advanceOrigin(conflictScenario.workspace, ".", "shared.txt", "target\n");
    const conflict = ark("worktree", "sync", conflictScenario.runId);
    expect(conflict.code).toBe(1);
    expect(conflict.err).toContain("repo .:");
    expect(git(conflictScenario.worktreePath(), "status", "--porcelain")).toBe("");
    expect(git(conflictScenario.worktreePath(), "rev-parse", "HEAD")).not.toBe(
      git(conflictScenario.workspace, "rev-parse", "origin/main"),
    );
  },
  { timeout: 30_000 },
);

test(
  "ARK-165-AC4 workspace sync fast-forwards clean and unrelated-dirty checkouts but preserves conflicting changes",
  () => {
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
  },
  { timeout: 30_000 },
);

const readEventLines = (runDirectory: string) =>
  readFileSync(join(runDirectory, "events.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

/** Runs build once per round: start then finish. */
function buildRounds(runId: string, rounds: number): void {
  for (let round = 0; round < rounds; round++) {
    expect(ark("run", "step", runId, "build", "start").code).toBe(0);
    expect(ark("run", "step", runId, "build", "finish").code).toBe(0);
  }
}

/** Leaves the worktree and origin in conflict and runs the failing sync. */
function syncWithConflict(scenario: ReturnType<typeof startRun>): void {
  commitFile(scenario.worktreePath(), "shared.txt", "worktree\n");
  advanceOrigin(scenario.workspace, ".", "shared.txt", "target\n");
  expect(ark("worktree", "sync", scenario.runId).code).toBe(1);
}

test(
  "ARK-211-AC1 start --merge after a sync conflict keeps the round although the budget is spent",
  () => {
    const scenario = startRun();
    buildRounds(scenario.runId, 2);
    expect(ark("run", "step", scenario.runId, "build", "start").err).toContain(
      "round budget spent",
    );
    syncWithConflict(scenario);

    const merged = ark("run", "step", scenario.runId, "build", "start", "--merge");
    expect(merged.code).toBe(0);
    expect(merged.out).toContain("started (merge, round 2/2)");
    const started = readEventLines(scenario.runDirectory).filter(
      (event) => event.type === "step.started",
    );
    expect(started.map((event) => [event.data.round, event.data.merge])).toEqual([
      [1, undefined],
      [2, undefined],
      [2, true],
    ]);
    expect(JSON.parse(readFileSync(join(scenario.runDirectory, "state.json"), "utf8")).round).toBe(
      2,
    );
  },
  { timeout: 30_000 },
);

test(
  "ARK-211-AC1 a finished merge step does not raise the round of the next implementer start",
  () => {
    const scenario = startRun();
    buildRounds(scenario.runId, 1);
    syncWithConflict(scenario);
    expect(ark("run", "step", scenario.runId, "build", "start", "--merge").code).toBe(0);
    expect(ark("run", "step", scenario.runId, "build", "finish").code).toBe(0);

    const next = ark("run", "step", scenario.runId, "build", "start");
    expect(next.code).toBe(0);
    expect(next.out).toContain("started (round 2/2)");
    const events = readEventLines(scenario.runDirectory);
    expect(
      events.findLast((event) => event.type === "step.finished" && event.data.merge),
    ).toBeTruthy();
  },
  { timeout: 30_000 },
);

test(
  "ARK-211-AC1 --merge is refused on a non-implementer start and on finish, naming the reason",
  () => {
    const scenario = startRun(["."], true);
    buildRounds(scenario.runId, 1);
    syncWithConflict(scenario);

    const validator = ark("run", "step", scenario.runId, "check", "start", "--merge");
    expect(validator.code).toBe(1);
    expect(validator.err).toContain("--merge applies to an implementer step, not validator");

    expect(ark("run", "step", scenario.runId, "build", "start", "--merge").code).toBe(0);
    const finish = ark("run", "step", scenario.runId, "build", "finish", "--merge");
    expect(finish.code).toBe(1);
    expect(finish.err).toContain("--merge only applies to start");
  },
  { timeout: 30_000 },
);

test(
  "ARK-211-AC2 --merge is refused when no sync is on record or the last sync was clean",
  () => {
    const scenario = startRun();
    const never = ark("run", "step", scenario.runId, "build", "start", "--merge");
    expect(never.code).toBe(1);
    expect(never.err).toContain("--merge needs a failed ark worktree sync for repo .");

    advanceOrigin(scenario.workspace, ".", "target.txt", "target\n");
    expect(ark("worktree", "sync", scenario.runId).code).toBe(0);
    const clean = ark("run", "step", scenario.runId, "build", "start", "--merge");
    expect(clean.code).toBe(1);
    expect(clean.err).toContain("--merge needs a failed ark worktree sync for repo .");
    expect(
      readEventLines(scenario.runDirectory).some((event) => event.type === "step.started"),
    ).toBe(false);
  },
  { timeout: 30_000 },
);

test(
  "ARK-211-AC2 sync records a conflict before failing and a later clean sync clears it",
  () => {
    const scenario = startRun();
    syncWithConflict(scenario);
    const synced = () =>
      readEventLines(scenario.runDirectory)
        .filter((event) => event.type === "worktree.synced")
        .map((event) => event.data.conflict);
    expect(synced()).toEqual([true]);

    // Origin takes the worktree's change, so the next merge is clean.
    advanceOrigin(scenario.workspace, ".", "shared.txt", "worktree\n");
    expect(ark("worktree", "sync", scenario.runId).code).toBe(0);
    expect(synced()).toEqual([true, false]);
    const refused = ark("run", "step", scenario.runId, "build", "start", "--merge");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("--merge needs a failed ark worktree sync for repo .");
  },
  { timeout: 30_000 },
);

test(
  "ARK-211-AC3 retro counts merge steps in rework.merge_steps and not in rework.rounds",
  () => {
    process.env.ARK_OMP_SESSIONS = mkdtempSync(join(tmpdir(), "ark-omp-sessions-"));
    process.env.ARK_CLAUDE_SESSIONS = mkdtempSync(join(tmpdir(), "ark-claude-sessions-"));
    const scenario = startRun();
    buildRounds(scenario.runId, 1);
    syncWithConflict(scenario);
    expect(ark("run", "step", scenario.runId, "build", "start", "--merge").code).toBe(0);
    expect(ark("run", "step", scenario.runId, "build", "finish").code).toBe(0);

    const retroResult = ark("retro", scenario.runId);
    expect(retroResult.code).toBe(0);
    const metrics = JSON.parse(readFileSync(join(scenario.runDirectory, "metrics.json"), "utf8"));
    expect(metrics.rework.rounds).toBe(1);
    expect(metrics.rework.merge_steps).toBe(1);
    expect(retroResult.out).toContain(
      "1 rounds, 0 escalations, 0 findings sent back, 1 merge steps",
    );
  },
  { timeout: 30_000 },
);

test(
  "ARK-233-AC1 --merge is refused after a succeeded merge step until a new sync conflicts",
  () => {
    const scenario = startRun();
    buildRounds(scenario.runId, 1);
    syncWithConflict(scenario);
    expect(ark("run", "step", scenario.runId, "build", "start", "--merge").code).toBe(0);
    expect(ark("run", "step", scenario.runId, "build", "finish").code).toBe(0);

    const refused = ark("run", "step", scenario.runId, "build", "start", "--merge");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("--merge needs a failed ark worktree sync for repo .");

    // A new conflict: the worktree and origin both change another file.
    commitFile(scenario.worktreePath(), "again.txt", "worktree\n");
    advanceOrigin(scenario.workspace, ".", "again.txt", "target\n");
    expect(ark("worktree", "sync", scenario.runId).code).toBe(1);
    expect(ark("run", "step", scenario.runId, "build", "start", "--merge").code).toBe(0);
  },
  { timeout: 30_000 },
);

test(
  "ARK-233-AC1 --merge stays allowed after a merge step finished as failed",
  () => {
    const scenario = startRun();
    buildRounds(scenario.runId, 1);
    syncWithConflict(scenario);
    expect(ark("run", "step", scenario.runId, "build", "start", "--merge").code).toBe(0);
    expect(ark("run", "step", scenario.runId, "build", "finish", "--failed").code).toBe(0);

    expect(ark("run", "step", scenario.runId, "build", "start", "--merge").code).toBe(0);
  },
  { timeout: 30_000 },
);

test("ARK-233-AC2 the CLI reference documents rework.merge_steps", () => {
  const doc = readFileSync(join(import.meta.dir, "../docs/reference/cli.md"), "utf8");
  expect(doc).toContain("rework.merge_steps");
});

test(
  "ARK-233-AC3 worktree sync on a closed run exits with a phase error and leaves HEAD unchanged",
  () => {
    const scenario = startRun();
    appendEvent(scenario.runDirectory, "merge_request.opened", {
      repo: ".",
      url: "https://github.com/acme/main/pull/9",
      number: 9,
    });
    // A dirty worktree survives the close, so the sync has a worktree to leave alone.
    writeFileSync(join(scenario.worktreePath(), "dirty.txt"), "dirty\n");
    expect(ark("run", "close", scenario.runId, "merged").code).toBe(0);
    const before = git(scenario.worktreePath(), "rev-parse", "HEAD");
    advanceOrigin(scenario.workspace, ".", "target.txt", "target\n");

    const synced = ark("worktree", "sync", scenario.runId);
    expect(synced.code).toBe(1);
    expect(synced.err).toContain("closed");
    expect(git(scenario.worktreePath(), "rev-parse", "HEAD")).toBe(before);
  },
  { timeout: 30_000 },
);

/** Three repos where only repos/b conflicts; repos/a and repos/c get new commits on origin. */
function threeRepoScenario() {
  const scenario = startRun(["repos/a", "repos/b", "repos/c"]);
  commitFile(scenario.worktreePath("repos/b"), "shared.txt", "worktree\n");
  const heads = {
    "repos/a": advanceOrigin(scenario.workspace, "repos/a", "target.txt", "a\n"),
    "repos/b": advanceOrigin(scenario.workspace, "repos/b", "shared.txt", "target\n"),
    "repos/c": advanceOrigin(scenario.workspace, "repos/c", "target.txt", "c\n"),
  };
  return { ...scenario, heads };
}

const containsCommit = (directory: string, commit: string) =>
  Bun.spawnSync(["git", "-C", directory, "merge-base", "--is-ancestor", commit, "HEAD"])
    .exitCode === 0;

test(
  "ARK-241-AC1 sync with only repo B conflicting syncs A and C, exits 1 and names B",
  () => {
    const scenario = threeRepoScenario();
    const url = "https://github.com/acme/c/pull/5";
    appendEvent(scenario.runDirectory, "merge_request.opened", { repo: "repos/c", url, number: 5 });

    const synced = ark("worktree", "sync", scenario.runId);
    expect(synced.code).toBe(1);
    expect(synced.err).toContain("repo repos/b: merging origin/main failed");
    expect(synced.err).not.toContain("repo repos/a");
    expect(synced.err).not.toContain("repo repos/c");

    expect(containsCommit(scenario.worktreePath("repos/a"), scenario.heads["repos/a"])).toBe(true);
    expect(containsCommit(scenario.worktreePath("repos/c"), scenario.heads["repos/c"])).toBe(true);
    expect(containsCommit(scenario.worktreePath("repos/b"), scenario.heads["repos/b"])).toBe(false);
    expect(synced.out).toContain("repos/c  main");
    expect(synced.out).toContain("pushed");

    // The clean repo after the conflicting one is pushed to its origin.
    const worktreeC = scenario.worktreePath("repos/c");
    const originC = git(worktreeC, "remote", "get-url", "origin");
    expect(git(originC, "rev-parse", git(worktreeC, "branch", "--show-current"))).toBe(
      git(worktreeC, "rev-parse", "HEAD"),
    );
  },
  { timeout: 30_000 },
);

test(
  "ARK-241-AC2 sync with one conflicting repo records a conflict for that repo only",
  () => {
    const scenario = threeRepoScenario();
    expect(ark("worktree", "sync", scenario.runId).code).toBe(1);

    const events = readEventLines(scenario.runDirectory).filter(
      (event) => event.type === "worktree.synced",
    );
    expect(events.map((event) => [event.data.repo, event.data.conflict])).toEqual([
      ["repos/a", false],
      ["repos/b", true],
      ["repos/c", false],
    ]);
    expect(
      JSON.parse(readFileSync(join(scenario.runDirectory, "state.json"), "utf8")).sync_conflicts,
    ).toEqual(["repos/b"]);
  },
  { timeout: 30_000 },
);

/** Makes every push from the repo fail: git cannot push to the URL `DISABLED`. */
function disablePush(workspace: string, repoNames: string[]): void {
  for (const repoName of repoNames)
    git(
      repoName === "." ? workspace : join(workspace, repoName),
      "config",
      "remote.origin.pushurl",
      "DISABLED",
    );
}

for (const stray of [false, true]) {
  test(
    `ARK-295-AC4 worktree sync never pushes for a none project${stray ? ", also with a stray merge_request.opened event" : ""}`,
    () => {
      const scenario = startRun(["repos/a", "repos/b"], false, { merge_requests: "none" });
      disablePush(scenario.workspace, ["repos/a", "repos/b"]);
      if (stray)
        appendEvent(scenario.runDirectory, "merge_request.opened", {
          repo: "repos/a",
          url: "https://github.com/acme/a/pull/1",
          number: 1,
        });
      const targetHead = advanceOrigin(scenario.workspace, "repos/a", "target.txt", "target\n");

      const synced = ark("worktree", "sync", scenario.runId);
      expect(synced.code).toBe(0);
      expect(synced.out).toContain("repos/a  main");
      expect(synced.out).toContain("repos/b  main");
      expect(synced.out).not.toContain("pushed");
      expect(
        git(scenario.worktreePath("repos/a"), "merge-base", "--is-ancestor", targetHead, "HEAD"),
      ).toBe("");
    },
    { timeout: 30_000 },
  );
}

test(
  "ARK-295-AC4 an open project with an MR event still pushes on sync, so the disabled pushurl is what stops a none project",
  () => {
    const scenario = startRun(["."], false, { merge_requests: "open" });
    appendEvent(scenario.runDirectory, "merge_request.opened", {
      repo: ".",
      url: "https://github.com/acme/main/pull/1",
      number: 1,
    });
    const origin = git(scenario.workspace, "remote", "get-url", "origin");
    disablePush(scenario.workspace, ["."]);
    const failed = ark("worktree", "sync", scenario.runId);
    expect(failed.code).not.toBe(0);

    git(scenario.workspace, "config", "remote.origin.pushurl", origin);
    const synced = ark("worktree", "sync", scenario.runId);
    expect(synced.code).toBe(0);
    expect(synced.out).toContain("pushed");
  },
  { timeout: 30_000 },
);

test(
  "ARK-295-AC4 worktree sync refuses a none project with an invalid unrelated field before any git push or gh call",
  () => {
    const scenario = startRun(["."], false, { merge_requests: "none" });
    const configFile = join(scenario.runDirectory, "../../ark.yml");
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    writeFileSync(configFile, JSON.stringify({ ...config, concurrency: 0 }));
    appendEvent(scenario.runDirectory, "merge_request.opened", {
      repo: ".",
      url: "https://github.com/acme/main/pull/1",
      number: 1,
    });
    const realGit = Bun.which("git") as string;
    const log = join(fakeGhDirectory, "calls.log");
    writeFileSync(log, "");
    for (const tool of ["git", "gh", "glab"])
      writeFileSync(
        join(fakeGhDirectory, tool),
        `#!/bin/sh\necho "${tool} $*" >> "${log}"\n${tool === "git" ? `exec "${realGit}" "$@"` : "exit 1"}\n`,
        { mode: 0o755 },
      );

    const synced = ark("worktree", "sync", scenario.runId);
    expect(synced.code).toBe(1);
    expect(synced.err).toContain("concurrency must be an integer >= 1");
    expect(readFileSync(log, "utf8")).toBe("");
  },
  { timeout: 30_000 },
);

/** Pushes one commit to `branch` of the origin of `workspace`; returns its sha. */
function advanceBranch(workspace: string, branch: string, file: string): string {
  const clone = mkdtempSync(join(tmpdir(), "ark-sync-clone-"));
  git(clone, "clone", git(workspace, "remote", "get-url", "origin"), ".");
  git(clone, "config", "user.name", "Ark Test");
  git(clone, "config", "user.email", "ark@example.com");
  git(clone, "checkout", branch);
  commitFile(clone, file, `${branch}\n`);
  git(clone, "push", "origin", branch);
  return git(clone, "rev-parse", "HEAD");
}

test("ARK-296-AC3 worktree sync merges origin/<base> of the repo, not the branch origin/HEAD names", () => {
  const scenario = startRun(
    ["."],
    false,
    { repos: { ".": { base: "release/9" } } },
    (workspace) => {
      git(workspace, "branch", "release/9");
      git(workspace, "push", "origin", "release/9");
    },
  );
  const worktree = scenario.worktreePath();
  // after the run began: m.txt on main only, r.txt on release/9 only
  advanceOrigin(scenario.workspace, ".", "m.txt", "main\n");
  const releaseHead = advanceBranch(scenario.workspace, "release/9", "r.txt");

  const synced = ark("worktree", "sync", scenario.runId);
  expect(synced.code).toBe(0);
  expect(existsSync(join(worktree, "m.txt"))).toBe(false);
  expect(readFileSync(join(worktree, "r.txt"), "utf8")).toBe("release/9\n");
  expect(git(worktree, "merge-base", "--is-ancestor", releaseHead, "HEAD")).toBe("");
});

test("ARK-296-AC3 worktree sync of a repo with no base still merges the branch origin/HEAD names", () => {
  const scenario = startRun();
  advanceOrigin(scenario.workspace, ".", "m.txt", "main\n");
  expect(ark("worktree", "sync", scenario.runId).code).toBe(0);
  expect(readFileSync(join(scenario.worktreePath(), "m.txt"), "utf8")).toBe("main\n");
});
