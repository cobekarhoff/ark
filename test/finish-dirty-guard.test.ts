import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent, deriveState, readEvents } from "../cli/events.ts";
import { planHash } from "../cli/plan.ts";
import type { PlanStep } from "../cli/plan.ts";
import { installFakeOrca, removeFakeOrca } from "./fake-orca.ts";
import {
  ark,
  recordEvaluation,
  tempArkHome,
  tempGitRepo,
  writeProject,
  writeTicket,
} from "./helpers.ts";

setDefaultTimeout(30_000);

const originalPath = process.env.PATH;
afterEach(() => {
  removeFakeOrca();
  process.env.PATH = originalPath;
});

const stepIds = ["build", "other"];

/** A run with an approved plan, a real worktree and every step started. */
function openRun() {
  tempArkHome();
  installFakeOrca();
  const workspace = tempGitRepo();
  const projectDirectory = writeProject("demo", {
    workspace,
    ticket_source: "local",
    round_budget: 1,
    suites: [
      {
        name: "integration",
        level: "integration",
        repo: ".",
        command: "true {report}",
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
  const steps: PlanStep[] = stepIds.map((id) => ({
    id,
    role: "implementer",
    repo: ".",
    harness: "omp",
    model: "test",
    needs: [],
    criteria: ["ARK-900-AC1"],
    skills: [],
    goal: "",
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
  for (const id of stepIds) expect(ark("run", "step", runId, id, "start").code).toBe(0);
  const worktree = deriveState(readEvents(directory)).worktrees[0]!;
  return { runId, directory, worktree };
}

function git(path: string, ...args: string[]) {
  const result = Bun.spawnSync([
    "git",
    "-C",
    path,
    "-c",
    "user.name=Ark",
    "-c",
    "user.email=ark@example.com",
    ...args,
  ]);
  expect(result.exitCode).toBe(0);
}

test("ARK-T332 finishing a step is refused and lists each file when its worktree holds a changed tracked or untracked file", () => {
  const { runId, directory, worktree } = openRun();
  writeFileSync(join(worktree.path, "README.md"), "changed\n");
  writeFileSync(join(worktree.path, "new-file.txt"), "new\n");
  const before = readEvents(directory);

  const refused = ark("run", "step", runId, "build", "finish");
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("README.md");
  expect(refused.err).toContain("new-file.txt");
  expect(refused.err).toContain("commit");
  expect(refused.err).toContain("--failed");
  expect(readEvents(directory)).toEqual(before);
});

test("ARK-T332 finishing a step is refused when git status fails in its worktree", () => {
  const { runId, directory, worktree } = openRun();
  writeFileSync(join(worktree.path, ".git"), "gitdir: /nonexistent\n");
  const before = readEvents(directory);

  const refused = ark("run", "step", runId, "build", "finish");
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("git status failed");
  expect(readEvents(directory)).toEqual(before);
});

test("ARK-T333 finishing a step works when its worktree is clean beside Ark's own untracked entries", () => {
  const { runId, directory, worktree } = openRun();
  writeFileSync(join(worktree.path, "README.md"), "changed\n");
  writeFileSync(join(worktree.path, "new-file.txt"), "new\n");
  git(worktree.path, "add", "-A");
  git(worktree.path, "commit", "-qm", "work");
  // Ark's own entry: an untracked mirror symlink
  symlinkSync(directory, join(worktree.path, "mirror-link"));

  expect(ark("run", "step", runId, "build", "finish").code).toBe(0);
  expect(readEvents(directory).at(-1)).toMatchObject({
    type: "step.finished",
    data: { step: "build", outcome: "succeeded" },
  });
});

test("ARK-T334 finish with --failed and with --not-started is not refused on a dirty worktree", () => {
  const { runId, directory, worktree } = openRun();
  writeFileSync(join(worktree.path, "new-file.txt"), "new\n");

  expect(ark("run", "step", runId, "build", "finish", "--failed").code).toBe(0);
  expect(ark("run", "step", runId, "other", "finish", "--failed", "--not-started").code).toBe(0);
  const finished = readEvents(directory).filter((event) => event.type === "step.finished");
  expect(finished).toHaveLength(2);
});
