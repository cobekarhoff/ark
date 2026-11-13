import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendEvent, deriveState, readEvents } from "../cli/events.ts";
import { planHash } from "../cli/plan.ts";
import type { PlanStep } from "../cli/plan.ts";
import { installFakeOrca, removeFakeOrca } from "./fake-orca.ts";
import { buildSpec } from "../cli/spec.ts";
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

function planStep(id: string, role: string, repo = "."): PlanStep {
  return {
    id,
    role,
    repo,
    harness: "omp",
    model: "test",
    needs: [],
    criteria: ["ARK-900-AC1"],
    skills: [],
    goal: "",
  };
}

/**
 * A run with an approved plan and a real worktree (HEAD equals base); the steps are the plan's.
 * `planExtras` adds keys to plan.yml; `withOrigin` gives the repo a bare origin, so the merge request diff exists.
 */
function openRun(steps: PlanStep[], options: { planExtras?: object; withOrigin?: boolean } = {}) {
  tempArkHome();
  installFakeOrca();
  const workspace = tempGitRepo();
  if (options.withOrigin) {
    const origin = mkdtempSync(join(tmpdir(), "ark-origin-"));
    for (const args of [
      ["clone", "-q", "--bare", workspace, origin],
      ["-C", workspace, "remote", "add", "origin", origin],
      ["-C", workspace, "fetch", "-q", "origin"],
      ["-C", workspace, "remote", "set-head", "origin", "main"],
    ])
      expect(Bun.spawnSync(["git", ...args]).exitCode).toBe(0);
  }
  const projectDirectory = writeProject("demo", {
    workspace,
    ticket_source: "local",
    round_budget: 1,
    suites: [
      {
        name: "integration",
        level: "integration",
        repo: ".",
        command: "true",
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
  writeFileSync(join(directory, "plan.yml"), JSON.stringify({ steps, ...options.planExtras }));
  recordEvaluation(directory);
  appendEvent(directory, "plan.checked", {
    valid: true,
    problems: [],
    plan_hash: planHash(directory),
    steps,
  });
  expect(ark("gate", "record", runId, "plan", "approve").code).toBe(0);
  expect(ark("worktree", "create", runId).code).toBe(0);
  const worktree = deriveState(readEvents(directory)).worktrees[0];
  return { runId, directory, worktree };
}

function writeFinding(directory: string, name: string, head: string, seconds: number) {
  mkdirSync(join(directory, "findings"), { recursive: true });
  const file = join(directory, "findings", name);
  writeFileSync(file, `Reviewed head: ${head}\n\nNo findings.\n`);
  utimesSync(file, seconds, seconds);
}

function specOf(directory: string, step: PlanStep, steps: PlanStep[], worktrees?: unknown) {
  const state = deriveState(readEvents(directory));
  return buildSpec({
    run: "run",
    directory,
    state: {
      ...state,
      steps: steps.map((s) => ({ ...s, status: "pending" })),
      ...(worktrees ? { worktrees } : {}),
    } as never,
    step,
    interrupted: false,
  });
}

test("ARK-T302 the first reviewer step's spec starts its range at the run base when only non-reviewer findings carry a Reviewed head", () => {
  const steps = [planStep("build", "implementer"), planStep("review", "reviewer")];
  const { directory, worktree } = openRun(steps);
  writeFinding(directory, "test-case-review-1.md", "aaaaaaa", 1000);
  writeFinding(directory, "round-1.md", "bbbbbbb", 2000);

  const spec = specOf(directory, steps[1]!, steps);
  expect(spec).toContain(`Last reviewed head: ${worktree!.base}`);
  expect(spec).not.toContain("aaaaaaa");
  expect(spec).not.toContain("bbbbbbb");

  const noBase = specOf(directory, steps[1]!, steps, [{ ...worktree, base: undefined }]);
  expect(noBase).not.toContain("Last reviewed head");
});

test("ARK-T303 the next reviewer step's spec starts its range at the head recorded by the previous reviewer step", () => {
  const steps = [
    planStep("build", "implementer"),
    planStep("review", "reviewer"),
    planStep("review-2", "reviewer"),
    planStep("review-3", "reviewer"),
    planStep("review-other", "reviewer", "other"),
  ];
  const { directory, worktree } = openRun(steps.filter((s) => s.repo === "."));
  writeFinding(directory, "review.md", "1111111", 1000);
  writeFinding(directory, "test-case-review-1.md", "9999999", 3000);

  const second = specOf(directory, steps[2]!, steps);
  expect(second).toContain("Last reviewed head: 1111111");
  expect(second).not.toContain("9999999");

  writeFinding(directory, "review-2.md", "2222222", 2000);
  expect(specOf(directory, steps[3]!, steps)).toContain("Last reviewed head: 2222222");

  // A reviewer step of another repo never takes its start from this repo's findings.
  const other = specOf(directory, steps[4]!, steps, [
    worktree,
    { repo: "other", path: worktree!.path, branch: "main", base: "ccccccc" },
  ]);
  expect(other).toContain("Last reviewed head: ccccccc");
  expect(other).not.toContain("2222222");
});

test("ARK-T304 finishing a succeeded reviewer step is refused when its review range holds no commit", () => {
  const steps = [planStep("build", "implementer"), planStep("review", "reviewer")];
  const { runId, directory, worktree } = openRun(steps);
  const head = Bun.spawnSync(["git", "-C", worktree!.path, "rev-parse", "HEAD"])
    .stdout.toString()
    .trim();
  writeFinding(directory, "review.md", head, 1000);
  expect(ark("run", "step", runId, "build", "start").code).toBe(0);
  expect(ark("run", "step", runId, "build", "finish").code).toBe(0);
  expect(ark("run", "step", runId, "review", "start").code).toBe(0);
  const before = readEvents(directory);

  const refused = ark("run", "step", runId, "review", "finish");
  expect(refused.code).toBe(1);
  expect(refused.err).toContain(`${worktree!.base}..${head}`);
  expect(refused.err).toContain("review");
  expect(readEvents(directory)).toEqual(before);

  // A dead reviewer can still be closed.
  expect(ark("run", "step", runId, "review", "finish", "--failed").code).toBe(0);
  expect(ark("run", "step", runId, "review", "start").code).toBe(0);
  expect(ark("run", "step", runId, "review", "finish", "--failed", "--not-started").code).toBe(0);

  expect(ark("run", "step", runId, "review", "start").code).toBe(0);
  const commit = Bun.spawnSync([
    "git",
    "-C",
    worktree!.path,
    "-c",
    "user.name=Ark",
    "-c",
    "user.email=ark@example.com",
    "commit",
    "--allow-empty",
    "-qm",
    "work",
  ]);
  expect(commit.exitCode).toBe(0);
  expect(ark("run", "step", runId, "review", "finish").code).toBe(0);
  expect(readEvents(directory).at(-1)).toMatchObject({
    type: "step.finished",
    data: { step: "review", outcome: "succeeded" },
  });
});

/** A started reviewer step whose worktree holds one commit that changes `files`; the plan lists only cli/run.ts. */
function reviewerWithChanges(files: string[]) {
  const steps = [planStep("build", "implementer"), planStep("review", "reviewer")];
  const run = openRun(steps, {
    withOrigin: true,
    planExtras: {
      summary: {
        why: "fixture",
        changes: [{ criterion: "ARK-900-AC1", where: "cli/run.ts", now: "", fix: "" }],
      },
    },
  });
  for (const file of files) {
    mkdirSync(dirname(join(run.worktree!.path, file)), { recursive: true });
    writeFileSync(join(run.worktree!.path, file), "changed\n");
  }
  for (const args of [
    ["add", "-A"],
    ["commit", "-qm", "work"],
  ])
    expect(
      Bun.spawnSync(["git", "-c", "user.name=Ark", "-c", "user.email=ark@example.com", ...args], {
        cwd: run.worktree!.path,
      }).exitCode,
    ).toBe(0);
  expect(ark("run", "step", run.runId, "build", "start").code).toBe(0);
  expect(ark("run", "step", run.runId, "build", "finish").code).toBe(0);
  expect(ark("run", "step", run.runId, "review", "start").code).toBe(0);
  return run;
}

function writeReviewerFindings(directory: string, text: string) {
  mkdirSync(join(directory, "findings"), { recursive: true });
  writeFileSync(join(directory, "findings", "review.md"), text);
}

const mergeRiskBlock = (...lines: string[]) => ["## Merge risk", "", ...lines, ""].join("\n");

test("ARK-T335 reviewer finish is refused for an unplanned file with no reason and names the line", () => {
  const { runId, directory } = reviewerWithChanges(["cli/helpers.ts", "cli/run.ts"]);
  const before = readEvents(directory);

  // The findings file exists, with a block and no line; then it does not exist at all.
  writeReviewerFindings(directory, mergeRiskBlock("- Door: two-way"));
  for (const absent of [false, true]) {
    if (absent) rmSync(join(directory, "findings", "review.md"));
    const refused = ark("run", "step", runId, "review", "finish");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("cli/helpers.ts");
    expect(refused.err).toContain("Not in plan: cli/helpers.ts — <reason>");
    expect(refused.err).toContain("findings/review.md");
    expect(refused.err).not.toContain("cli/run.ts");
    expect(readEvents(directory)).toEqual(before);
  }

  // A dead reviewer can still be closed.
  expect(ark("run", "step", runId, "review", "finish", "--failed").code).toBe(0);
});

test("ARK-T336 reviewer finish passes when each unplanned file has a reason and test/ and docs/ need none", () => {
  const files = ["cli/helpers.ts", "test/foo.test.ts", "docs/foo.md"];
  const line = "- Not in plan: cli/helpers.ts — fixture reason";

  // An empty reason, and a line only in a second block, are no reason.
  for (const text of [
    mergeRiskBlock("- Not in plan: cli/helpers.ts —"),
    `${mergeRiskBlock("- Door: two-way")}\n${mergeRiskBlock(line)}`,
  ]) {
    const { runId, directory } = reviewerWithChanges(files);
    writeReviewerFindings(directory, text);
    const refused = ark("run", "step", runId, "review", "finish");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("cli/helpers.ts");
    expect(refused.err).not.toContain("foo.test.ts");
    expect(refused.err).not.toContain("docs/foo.md");
  }

  const { runId, directory } = reviewerWithChanges(files);
  writeReviewerFindings(directory, mergeRiskBlock(line));
  const finished = ark("run", "step", runId, "review", "finish");
  expect(finished.code, finished.err).toBe(0);
  expect(readEvents(directory).at(-1)).toMatchObject({
    type: "step.finished",
    data: { step: "review", outcome: "succeeded" },
  });
});
