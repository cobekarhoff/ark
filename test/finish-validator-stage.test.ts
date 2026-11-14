import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendEvent, deriveState, readEvents } from "../cli/events.ts";
import { planHash } from "../cli/plan.ts";
import type { PlanStep } from "../cli/plan.ts";
import { installFakeOrca, removeFakeOrca } from "./fake-orca.ts";
import {
  ark,
  recordEvaluation,
  tempArkHome,
  tempGitRepo,
  writeEvidenceFile,
  writeProject,
  writeTicket,
} from "./helpers.ts";

setDefaultTimeout(60_000);

const originalPath = process.env.PATH;
afterEach(() => {
  removeFakeOrca();
  process.env.PATH = originalPath;
});

const created = "`created-by-fix-405`";
const methods = ["test", "demonstration", "inspection", "demonstration"];
const analysisMethods = ["test", "demonstration", "analysis", "demonstration"];
const criteriaOf = (list: string[]) =>
  list.map((method, index) => ({
    id: `ARK-900-AC${index + 1}`,
    method,
    text: method === "test" ? `The fix creates ${created}` : `Criterion ${index + 1}`,
  }));
const allIds = criteriaOf(methods).map(({ id }) => id);

type Step = Pick<PlanStep, "id" | "role" | "needs" | "criteria">;
const fix: Step = { id: "fix", role: "implementer", needs: [], criteria: ["ARK-900-AC1"] };
const validator = (id: string, served: string[], needs = ["fix"]): Step => ({
  id,
  role: "validator",
  needs,
  criteria: served,
});

type ValidatorRun = {
  runId: string;
  directory: string;
  worktree: string;
  /** Writes a file of `results/evidence/` in the run folder, outside the worktree. */
  evidence(id: string, text: string): void;
  finish(id: string, ...flags: string[]): { code: number; out: string; err: string };
  finished(): number;
  eventLines(): string[];
};

/**
 * A run with an approved plan of `steps` and a real worktree; the steps in `start` are started. A bug run is
 * given its red proof (every automated criterion failing) first, so its implementer step may start.
 */
function validatorRun(
  steps: Step[],
  {
    start,
    kind,
    title,
    summary,
    criterionMethods = methods,
  }: {
    start: string[];
    kind?: "bug";
    title?: string;
    summary?: string;
    criterionMethods?: string[];
  },
): ValidatorRun {
  tempArkHome();
  installFakeOrca();
  const projectDirectory = writeProject("demo", {
    workspace: tempGitRepo(),
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
  const ticketFile = writeTicket("demo", "ARK-900", criteriaOf(criterionMethods), title, kind);
  if (summary !== undefined)
    writeFileSync(
      ticketFile,
      readFileSync(ticketFile, "utf8").replace(
        "status: ready\n",
        `status: ready\nsummary: ${JSON.stringify(summary)}\n`,
      ),
    );
  const runId = ark("run", "start", ticketFile, "--project", "demo").out.trim();
  const directory = join(projectDirectory, "runs", runId);
  const planned: PlanStep[] = steps.map((step) => ({
    ...step,
    repo: ".",
    harness: "omp",
    model: "test",
    skills: [],
    goal: "",
  }));
  writeFileSync(join(directory, "plan.yml"), JSON.stringify({ steps: planned }));
  recordEvaluation(directory);
  appendEvent(directory, "plan.checked", {
    valid: true,
    problems: [],
    plan_hash: planHash(directory),
    steps: planned,
  });
  expect(ark("gate", "record", runId, "plan", "approve").code).toBe(0);
  expect(ark("worktree", "create", runId).code).toBe(0);
  if (kind === "bug")
    appendEvent(directory, "test.completed", {
      passed: false,
      criteria: {
        "ARK-900/AC1": "failing",
        "ARK-900/AC2": "manual pending",
        "ARK-900/AC3": "manual pending",
        "ARK-900/AC4": "manual pending",
      },
    });
  for (const id of start) expect(ark("run", "step", runId, id, "start").code).toBe(0);
  const worktree = deriveState(readEvents(directory)).worktrees[0]!.path;
  return {
    runId,
    directory,
    worktree,
    evidence(id: string, text: string) {
      const file = join(directory, "results", "evidence", `${id}.md`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    },
    finish: (id, ...flags) => ark("run", "step", runId, id, "finish", ...flags),
    finished: () => readEvents(directory).filter((event) => event.type === "step.finished").length,
    eventLines: () => readFileSync(join(directory, "events.ndjson"), "utf8").trim().split("\n"),
  };
}

function commitFile(run: ValidatorRun, name: string, content: string): void {
  writeFileSync(join(run.worktree, name), content);
  for (const args of [
    ["add", name],
    ["commit", "-qm", name],
  ]) {
    const result = Bun.spawnSync([
      "git",
      "-C",
      run.worktree,
      "-c",
      "user.name=Ark",
      "-c",
      "user.email=ark@example.com",
      ...args,
    ]);
    expect(result.exitCode).toBe(0);
  }
}

/** A demonstration file with no last line `human: ok`; `saw: false` leaves out the section `What the human saw`. */
function demonstration(run: ValidatorRun, id: string, { saw = true } = {}): void {
  writeEvidenceFile(run.directory, id, "demonstration", { humanOk: false });
  const file = join(run.directory, "results", "evidence", `${id}.md`);
  if (!saw)
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("## What the human saw\n\nThe feature.\n\n", ""),
    );
}

const malformed = 'evidence malformed: AC4: missing section "What the human saw"';

/** Finishing is refused with `line` in its error text and writes no event, and the step is still running. */
function expectRefused(run: ValidatorRun, id: string, line: string): void {
  const before = run.eventLines();
  const refused = run.finish(id);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain(line);
  expect(run.eventLines()).toEqual(before);
}

function expectFinished(run: ValidatorRun, id: string, ...flags: string[]): void {
  const before = run.finished();
  const result = run.finish(id, ...flags);
  expect(result.code, result.err + result.out).toBe(0);
  expect(run.finished()).toBe(before + 1);
}

test("ARK-T381 a validator finish refuses a malformed demonstration file of a served AC, writes no event, and finishes with --failed", () => {
  const run = validatorRun([fix, validator("val-2", ["ARK-900-AC4"])], { start: ["val-2"] });
  demonstration(run, "AC4", { saw: false });
  expectRefused(run, "val-2", malformed);
  expectFinished(run, "val-2", "--failed");
});

test("ARK-T381 a validator finish of a well-formed demonstration file that lacks the last line finishes", () => {
  const run = validatorRun([fix, validator("val-2", ["ARK-900-AC4"])], { start: ["val-2"] });
  demonstration(run, "AC4");
  expectFinished(run, "val-2");
});

test("ARK-T381 the dirty-worktree refusal comes before the evidence refusal of a validator finish", () => {
  const run = validatorRun([fix, validator("val-2", ["ARK-900-AC4"])], { start: ["val-2"] });
  demonstration(run, "AC4", { saw: false });
  writeFileSync(join(run.worktree, "README.md"), "changed\n");
  const refused = run.finish("val-2");
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("has uncommitted changes");
  expect(refused.err).toContain("README.md");
  expect(refused.err).not.toContain("evidence malformed");
});

test("ARK-T381 a validator finish ignores a problem of an AC it does not serve and a title problem", () => {
  const run = validatorRun([fix, validator("val-2", ["ARK-900-AC1"])], {
    start: ["val-2"],
    title: "t".repeat(70),
    summary: "s".repeat(70),
  });
  commitFile(run, "fixed.txt", `${created}\n`);
  demonstration(run, "AC4", { saw: false });
  expectFinished(run, "val-2");
});

test("ARK-T381 a validator finish does not refuse for a pending manual answer or a reviewer file that is not written yet", () => {
  const run = validatorRun([fix, validator("val-2", ["ARK-900-AC2", "ARK-900-AC3"])], {
    start: ["val-2"],
  });
  demonstration(run, "AC2");
  demonstration(run, "AC4", { saw: false });
  expectFinished(run, "val-2");
});

test("ARK-T381 only a validator step is checked: an implementer finish with a malformed served file finishes", () => {
  const run = validatorRun(
    [{ ...fix, criteria: ["ARK-900-AC1", "ARK-900-AC4"] }, validator("val-2", ["ARK-900-AC1"])],
    { start: ["fix"] },
  );
  demonstration(run, "AC4", { saw: false });
  expectFinished(run, "fix");
});

/** The bug run of variants C and D: `val-1` serves every AC and runs before `fix`; the files lack only what a later writer adds. */
function bugRun(start: string[]) {
  const run = validatorRun(
    [
      validator("val-1", allIds, []),
      { ...fix, needs: ["val-1"] },
      validator("val-2", ["ARK-900-AC1"]),
    ],
    { start, kind: "bug" },
  );
  demonstration(run, "AC2");
  demonstration(run, "AC4");
  writeEvidenceFile(run.directory, "AC3", "inspection");
  run.evidence(
    "AC3",
    readFileSync(join(run.directory, "results", "evidence", "AC3.md"), "utf8").replace(
      "\n\nreviewer: pass",
      "",
    ),
  );
  return run;
}

test("ARK-T381 the first validator of a bug run finishes with a red test and the string that only the fix creates absent, also with --failed", () => {
  expectFinished(bugRun(["val-1"]), "val-1");
  expectFinished(bugRun(["val-1"]), "val-1", "--failed");
});

test("ARK-T381 a validator that runs after the fix is refused for the AC string that is still absent, and finishes once a tracked file holds it", () => {
  const run = bugRun(["val-1"]);
  expectFinished(run, "val-1");
  expect(run.finish("fix").code).toBe(1);
  for (const id of ["fix", "val-2"])
    expect(ark("run", "step", run.runId, id, "start").code).toBe(0);
  expectFinished(run, "fix");
  expectRefused(run, "val-2", `AC string in no tracked file at head: ARK-900/AC1 ${created}`);
  commitFile(run, "fixed.txt", `${created}\n`);
  expectFinished(run, "val-2");
});

/** The bug run of variants C and D with `AC3` an analysis criterion; the files lack only the analysis file that a later step writes. */
function analysisBugRun(steps: Step[], start: string[]) {
  const run = validatorRun(steps, { start, kind: "bug", criterionMethods: analysisMethods });
  demonstration(run, "AC2");
  demonstration(run, "AC4");
  return run;
}

test("ARK-T381 the first validator of a bug run finishes with the analysis file missing while a later validator step or an unfinished implementer step can still write it", () => {
  const laterValidator = analysisBugRun(
    [
      validator("val-1", allIds, []),
      { ...fix, needs: ["val-1"] },
      validator("val-2", ["ARK-900-AC1", "ARK-900-AC3"]),
    ],
    ["val-1"],
  );
  expectFinished(laterValidator, "val-1");
  const laterImplementer = analysisBugRun(
    [
      validator("val-1", allIds, []),
      { ...fix, needs: ["val-1"], criteria: ["ARK-900-AC1", "ARK-900-AC3"] },
    ],
    ["val-1"],
  );
  expectFinished(laterImplementer, "val-1");
});

test("ARK-T381 a validator finish refuses a missing analysis file when no later step can write it, and finishes once the file is written", () => {
  const alone = analysisBugRun(
    [validator("val-1", allIds, []), { ...fix, needs: ["val-1"] }],
    ["val-1"],
  );
  expectRefused(alone, "val-1", "evidence missing: AC3 (analysis)");
  writeEvidenceFile(alone.directory, "AC3", "analysis");
  expectFinished(alone, "val-1");

  const run = analysisBugRun(
    [
      validator("val-1", allIds, []),
      { ...fix, needs: ["val-1"] },
      validator("val-2", ["ARK-900-AC1", "ARK-900-AC3"]),
    ],
    ["val-1"],
  );
  expectFinished(run, "val-1");
  for (const id of ["fix", "val-2"])
    expect(ark("run", "step", run.runId, id, "start").code).toBe(0);
  expectFinished(run, "fix");
  commitFile(run, "fixed.txt", `${created}\n`);
  expectRefused(run, "val-2", "evidence missing: AC3 (analysis)");
  writeEvidenceFile(run.directory, "AC3", "analysis");
  expectFinished(run, "val-2");
});
