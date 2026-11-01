import { beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent } from "../cli/events.ts";
import { ark, tempArkHome, tempGitRepo, writeProject, writeTicket } from "./helpers.ts";

let projectDirectory: string;
let runId: string;
let runDirectory: string;

function startRun(criteria = [{ id: "ARK-170-AC", text: "observable behavior" }]): void {
  const started = ark("run", "start", writeTicket("demo", "ARK-170", criteria));
  expect(started.code).toBe(0);
  runId = started.out.trim();
  runDirectory = join(projectDirectory, "runs", runId);
}

function evaluation(content: string): void {
  writeFileSync(join(runDirectory, "evaluation.md"), content);
}

function record(blockers: string[], risks: string[]): void {
  appendEvent(runDirectory, "evaluation.recorded", { blockers, risks });
}

const events = () =>
  readFileSync(join(runDirectory, "events.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const state = () => JSON.parse(readFileSync(join(runDirectory, "state.json"), "utf8"));

beforeEach(() => {
  tempArkHome();
  projectDirectory = writeProject("demo", {
    workspace: tempGitRepo(),
    ticket_source: "local",
    suites: [{ name: "cli", level: "integration", repo: ".", command: "bun test", parser: "bun" }],
    roles: {
      implementer: { harness: "omp", model: "task" },
      evaluator: { harness: "omp", model: "validate" },
      validator: { harness: "omp", model: "validate" },
      reviewer: { harness: "omp", model: "validate" },
    },
  });
  startRun();
});

test("ARK-170-AC1 evaluation record writes both lists from evaluation.md", () => {
  evaluation(
    "## Blockers\n- AC2 cannot be exercised\n\n## Risks\n- Requires a configured role\n- Timing boundary\n",
  );
  const result = ark("evaluation", "record", runId);
  expect(result.code).toBe(0);
  expect(events().at(-1)).toMatchObject({
    type: "evaluation.recorded",
    data: {
      blockers: ["AC2 cannot be exercised"],
      risks: ["Requires a configured role", "Timing boundary"],
    },
  });
});

test("ARK-170-AC1 refuses missing or incomplete evaluation files without recording", () => {
  const missing = ark("evaluation", "record", runId);
  expect(missing.code).toBe(1);
  expect(missing.err).toContain("evaluation.md");
  evaluation("## Risks\n- risk without blockers list\n");
  const missingBlockers = ark("evaluation", "record", runId);
  expect(missingBlockers.code).toBe(1);
  expect(missingBlockers.err).toContain("blockers");

  evaluation("## Blockers\n- blocked\n");
  const incomplete = ark("evaluation", "record", runId);
  expect(incomplete.code).toBe(1);
  expect(incomplete.err).toContain("risks");
  expect(events().some((event) => event.type === "evaluation.recorded")).toBe(false);
});

test("ARK-170-AC1 refuses to record when ark.yml has no evaluator role", () => {
  const config = JSON.parse(readFileSync(join(projectDirectory, "ark.yml"), "utf8"));
  delete config.roles.evaluator;
  writeFileSync(join(projectDirectory, "ark.yml"), JSON.stringify(config));
  evaluation("## Blockers\n\n## Risks\n");
  const result = ark("evaluation", "record", runId);
  expect(result.code).toBe(1);
  expect(result.err).toContain("roles.evaluator");
  expect(events().some((event) => event.type === "evaluation.recorded")).toBe(false);
});

test("ARK-170-AC2 blockers keep the criteria gate open through edits until acceptance", () => {
  record(["AC is impossible"], []);
  expect(state().phase).toBe("awaiting_criteria");
  expect(ark("gate", "record", runId, "criteria", "edit").code).toBe(0);
  expect(state().phase).toBe("awaiting_criteria");
  expect(ark("gate", "record", runId, "criteria", "accept").code).toBe(0);
  expect(state().phase).toBe("planning");
});

test("ARK-170-AC2 a later clear evaluation does not end the criteria gate wait", () => {
  record(["AC is impossible"], []);
  record([], []);
  expect(state().phase).toBe("awaiting_criteria");
  expect(ark("gate", "record", runId, "criteria", "accept").code).toBe(0);
  expect(state().phase).toBe("planning");
});

test("ARK-170-AC2 aborting an evaluator-blocked criteria gate closes the run", () => {
  record(["AC is impossible"], []);
  const result = ark("gate", "record", runId, "criteria", "abort");
  expect(result.code).toBe(0);
  expect(state()).toMatchObject({ phase: "closed", outcome: "aborted" });
});

test("ARK-170-AC3 a clear evaluation advances a ticket with criteria without answering a gate", () => {
  record([], []);
  expect(state().phase).toBe("planning");
  expect(events().some((event) => event.type === "gate.answered")).toBe(false);
});

test("ARK-170-AC3 a ticket without criteria remains gated after a clear evaluation", () => {
  const started = ark("run", "start", writeTicket("demo", "ARK-170-NO-AC", []));
  expect(started.code).toBe(0);
  runId = started.out.trim();
  runDirectory = join(projectDirectory, "runs", runId);
  record([], []);
  expect(state().phase).toBe("awaiting_criteria");
});

test("ARK-170-AC4 plan check refuses a valid plan without an evaluation event", () => {
  writeFileSync(
    join(runDirectory, "plan.yml"),
    JSON.stringify({
      design: { interfaces: [{ name: "test", callers: ["ark plan check"] }] },
      summary: {
        why: "test",
        changes: [{ criterion: "ARK-170-AC", where: "cli", now: "missing", fix: "add" }],
      },
      steps: [
        {
          id: "build",
          role: "implementer",
          repo: ".",
          harness: "omp",
          model: "task",
          needs: [],
          criteria: ["ARK-170-AC"],
        },
      ],
      test_cases: [
        {
          id: "case",
          criterion: "ARK-170-AC",
          level: "integration",
          given: [],
          when: ["run"],
          then: ["pass"],
          expected: "the system shall pass",
        },
      ],
    }),
  );
  const result = ark("plan", "check", runId);
  expect(result.code).toBe(1);
  expect(`${result.err}${result.out}`).toContain("evaluation.recorded");
});

test("ARK-170-AC5 plan markdown lists only risks from the latest evaluation", () => {
  record([], ["old risk"]);
  record([], ["latest one", "latest two"]);
  writeFileSync(
    join(runDirectory, "plan.yml"),
    JSON.stringify({
      design: { interfaces: [{ name: "test", callers: ["ark plan check"] }] },
      summary: {
        why: "test",
        changes: [{ criterion: "ARK-170-AC", where: "cli", now: "missing", fix: "add" }],
      },
      steps: [
        {
          id: "build",
          role: "implementer",
          repo: ".",
          harness: "omp",
          model: "task",
          needs: [],
          criteria: ["ARK-170-AC"],
        },
      ],
      test_cases: [
        {
          id: "case",
          criterion: "ARK-170-AC",
          level: "integration",
          given: [],
          when: ["run"],
          then: ["pass"],
          expected: "the system shall pass",
        },
      ],
    }),
  );
  const result = ark("plan", "check", runId);
  expect(result.code, `${result.err}${result.out}`).toBe(0);
  const markdown = readFileSync(join(runDirectory, "plan.md"), "utf8");
  const evaluationSection = markdown.split("## Evaluation")[1]?.split("\n## ")[0];
  expect(evaluationSection).toContain("latest one");
  expect(evaluationSection).toContain("latest two");
  expect(evaluationSection).not.toContain("old risk");
});

test("ARK-170-AC7 playbooks assign evaluation recording before planning without product edits", () => {
  const playbooks = join(import.meta.dir, "../skills/ark/playbooks");
  const lead = readFileSync(join(playbooks, "run-lead.md"), "utf8");
  const worker = readFileSync(join(playbooks, "worker.md"), "utf8");
  expect(lead).toMatch(/roles\.evaluator[\s\S]*?before[\s\S]*?plan\.yml/i);
  expect(lead).toMatch(/roles\.evaluator[\s\S]*?(?:missing|no evaluator)/i);
  expect(worker).toContain("evaluation.md");
  expect(worker).toMatch(/evaluator[\s\S]*?no product code/i);
});
