import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent, deriveState, readEvents } from "../cli/events.ts";
import { manualCriteria, runCriteria } from "../cli/ticket.ts";
import { ark, recordEvaluation, tempArkHome, tempGitRepo, writeProject } from "./helpers.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(120_000);

type ArkResult = { code: number; out: string; err: string };
type Run = { runId: string; runDirectory: string; workspace: string };
type CriterionSpec = { id: string; lines: string[] };

const roles = {
  implementer: { harness: "omp", model: "pi/task" },
  validator: { harness: "omp", model: "pi/task" },
  reviewer: { harness: "omp", model: "pi/task" },
};
const junit = (file: string) => `bun test --reporter=junit --reporter-outfile={report} ./${file}`;

function startProject(options: { files?: Record<string, string>; command?: string } = {}): string {
  tempArkHome();
  return writeProject("demo", {
    workspace: tempGitRepo(options.files),
    ticket_source: "local",
    suites: [
      {
        name: "cli",
        level: "integration",
        repo: ".",
        command: options.command ?? "true",
        parser: "bun",
      },
    ],
    roles,
  });
}

const textOf = (id: string) => `text ${id}`;

function ticketText(ticketId: string, criteria: CriterionSpec[]): string {
  return [
    "---",
    `id: ${ticketId}`,
    `title: "Amend verified_by demo"`,
    "status: ready",
    "acceptance_criteria:",
    ...criteria.flatMap((criterion) => [
      `  - id: ${criterion.id}`,
      `    text: "${textOf(criterion.id)}"`,
      ...criterion.lines,
    ]),
    "---",
    "## Acceptance criteria",
    "",
    "| ID | Criterion |",
    "| --- | --- |",
    ...criteria.map((criterion) => `| ${criterion.id} | ${textOf(criterion.id)} |`),
    "",
  ].join("\n");
}

const method = "    method: test";
const manual = "    manual: true";
const listed = (...ids: string[]) => `    verified_by: [${ids.join(", ")}]`;

const git = (directory: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", "-C", directory, ...args]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
};

function writeCase(repository: string, id: string, status = "active"): void {
  mkdirSync(join(repository, "test", "cases"), { recursive: true });
  writeFileSync(
    join(repository, "test", "cases", `${id}.md`),
    [
      "---",
      `id: ${id}`,
      `title: ${id} case`,
      "level: integration",
      "technique: equivalence classes",
      "priority: high",
      "risk: wrong proof",
      `status: ${status}`,
      "changed_by: 2026-11-10-ARK-361-1",
      "---",
      "",
      "## Objective",
      "",
      "Prove it.",
      "",
      "## Preconditions",
      "",
      "- none",
      "",
      "## Steps",
      "",
      "1. Run it.",
      "",
      "## Expected results",
      "",
      "- It works.",
      "",
      "## Screenshot checkpoints",
      "",
      "none",
      "",
    ].join("\n"),
  );
}

function commitCase(repository: string, id: string, status = "active"): void {
  writeCase(repository, id, status);
  git(repository, "add", `test/cases/${id}.md`);
  git(repository, "commit", "-q", "-m", `case ${id}`);
}

/** A run in building: ticket started, plan checked and approved, worktree made. */
function buildingRun(project: string, ticketId: string, criteria: CriterionSpec[]): Run {
  const ticketFile = join(project, "tickets", `${ticketId}.md`);
  mkdirSync(join(project, "tickets"), { recursive: true });
  writeFileSync(ticketFile, ticketText(ticketId, criteria));
  const started = ark("run", "start", ticketFile);
  expect(started.code, started.err).toBe(0);
  const runId = started.out.match(new RegExp(`\\d{4}-\\d{2}-\\d{2}-${ticketId}-\\d+`))![0];
  const runDirectory = join(project, "runs", runId);
  recordEvaluation(runDirectory);

  const manualIds = manualCriteria(runDirectory);
  const provable = runCriteria(runDirectory).filter(
    (criterion) => !manualIds.includes(criterion.id),
  );
  const scenario = {
    level: "integration",
    given: [],
    when: ["do the thing"],
    // oxlint-disable-next-line unicorn/no-thenable -- plan test-case field `then: string[]`, not a Promise-like
    then: ["it works"],
    expected: "the system shall work",
  };
  const caseIds = [...new Set(provable.flatMap((criterion) => criterion.verified_by))];
  writeFileSync(
    join(runDirectory, "plan.yml"),
    JSON.stringify({
      design: { approach: "Do it.", interfaces: [{ name: "x", callers: ["y"] }], example: "ok" },
      summary: {
        why: "Because.",
        changes: runCriteria(runDirectory).map((criterion) => ({
          criterion: criterion.id,
          where: "x",
          now: "a",
          fix: "b",
        })),
      },
      steps: [
        {
          id: "build",
          role: "implementer",
          repo: ".",
          harness: "omp",
          model: "pi/task",
          needs: [],
          criteria: runCriteria(runDirectory).map((criterion) => criterion.id),
        },
      ],
      test_cases: [
        ...caseIds.map((id) => ({ id, action: "add", ...scenario })),
        ...provable
          .filter((criterion) => criterion.verified_by.length === 0)
          .map((criterion) => ({
            id: `proves-${criterion.id}`,
            criterion: criterion.id,
            ...scenario,
          })),
      ],
    }),
  );
  for (const args of [
    ["plan", "check", runId],
    ["gate", "record", runId, "plan", "approve"],
    ["worktree", "create", runId, "."],
  ]) {
    const result = ark(...args);
    expect(result.code, `${args.join(" ")}: ${result.err}${result.out}`).toBe(0);
  }
  return { runId, runDirectory, workspace: join(runDirectory, "workspace") };
}

const read = (run: Run, name: string) => readFileSync(join(run.runDirectory, name), "utf8");
const amendments = (run: Run) =>
  readEvents(run.runDirectory).filter((event) => event.type === "criteria.amended");
const amendIds = (run: Run, criterion: string, ids: string, ...rest: string[]) =>
  ark("criteria", "amend", run.runId, criterion, "--verified-by", ids, ...rest);
const withReason = ["--reason", "renumbered"];

function textFile(run: Run, text: string): string {
  const file = join(run.runDirectory, "new-text.txt");
  writeFileSync(file, text);
  return file;
}

/** Asserts a refused call exits 1, names `mention`, and leaves ticket.md and the event log byte-identical. */
function expectRefused(run: Run, result: ArkResult, mention: string): void {
  const ticket = read(run, "ticket.md");
  const log = read(run, "events.ndjson");
  expect(result.code, result.out).toBe(1);
  expect(result.err).toContain(mention);
  expect(read(run, "ticket.md")).toBe(ticket);
  expect(read(run, "events.ndjson")).toBe(log);
}

const gate = (run: Run, criterion: string) =>
  deriveState(readEvents(run.runDirectory)).gates[`manual:${criterion}` as "criteria"];

test("ARK-T228 --verified-by replaces the list in ticket.md and records the old list, new list and reason", () => {
  const project = startProject();
  const forms = [
    {
      ticketId: "ARK-501",
      id: "AC1",
      lines: [method, listed("ARK-T1")],
      before: listed("ARK-T1"),
      old: ["ARK-T1"],
    },
    {
      ticketId: "ARK-502",
      id: "AC1",
      lines: [method, "    verified_by:", "      - ARK-T1"],
      before: "    verified_by:\n      - ARK-T1",
      old: ["ARK-T1"],
    },
    {
      ticketId: "ARK-503",
      id: "AC1",
      lines: [manual, "    verified_by: []   # comment"],
      before: "    verified_by: []   # comment",
      old: [],
    },
    // An old-form id with no key is the legacy proof mode.
    { ticketId: "ARK-504", id: "ARK-504-AC1", lines: [method], before: undefined, old: [] },
  ];
  for (const form of forms) {
    const run = buildingRun(project, form.ticketId, [
      { id: form.id, lines: form.lines },
      { id: "AC2", lines: [method, listed("ARK-T2")] },
    ]);
    commitCase(run.workspace, "ARK-T300");
    commitCase(run.workspace, "ARK-T301");
    const criterionId = `${form.ticketId}/AC1`;
    const newList = "    verified_by: [ARK-T300, ARK-T301]";
    const ticket = read(run, "ticket.md");
    const expected =
      form.before === undefined
        ? ticket.replace(
            `    text: "${textOf(form.id)}"\n`,
            `${newList}\n    text: "${textOf(form.id)}"\n`,
          )
        : ticket.replace(form.before, newList);
    const legacy = form.before === undefined;
    expect(runCriteria(run.runDirectory)[0].newScheme).toBe(!legacy);

    const result = amendIds(run, "AC1", "ARK-T300,ARK-T301", ...withReason);

    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain(criterionId);
    expect(result.out).toContain("ARK-T300");
    expect(read(run, "ticket.md")).toBe(expected);
    expect(amendments(run).at(-1)!.data).toEqual({
      criterion: criterionId,
      verified_by_old: form.old,
      verified_by_new: ["ARK-T300", "ARK-T301"],
      by: "human",
      reason: "renumbered",
    });
    const [amended, untouched] = runCriteria(run.runDirectory);
    expect(amended.verified_by).toEqual(["ARK-T300", "ARK-T301"]);
    expect(amended.newScheme).toBe(true);
    expect(untouched.verified_by).toEqual(["ARK-T2"]);
  }
});

test("ARK-T229 --verified-by refuses a test case id with no active file at HEAD and changes nothing", () => {
  const project = startProject();
  const run = buildingRun(project, "ARK-510", [{ id: "AC1", lines: [method, listed("ARK-T1")] }]);
  commitCase(run.workspace, "ARK-T1");
  commitCase(run.workspace, "ARK-T2");
  commitCase(run.workspace, "ARK-T3", "retired");
  const other = join(run.workspace, "other");
  renameSync(tempGitRepo(), other);
  commitCase(other, "ARK-T5");
  writeCase(run.workspace, "ARK-T7"); // untracked
  writeCase(run.workspace, "ARK-T8"); // staged, not committed
  git(run.workspace, "add", "test/cases/ARK-T8.md");

  expectRefused(run, amendIds(run, "AC1", "ARK-T1,ARK-T9", ...withReason), "ARK-T9");
  expectRefused(run, amendIds(run, "AC1", "ARK-T3", ...withReason), "ARK-T3");
  expectRefused(run, amendIds(run, "AC1", "ARK-T7", ...withReason), "ARK-T7");
  expectRefused(run, amendIds(run, "AC1", "ARK-T8", ...withReason), "ARK-T8");
  expectRefused(run, amendIds(run, "AC1", "", ...withReason), "empty entry");
  expectRefused(run, amendIds(run, "AC1", "ARK-T2,,ARK-T1", ...withReason), "empty entry");
  expect(amendments(run)).toEqual([]);

  // An id committed in any repo worktree counts.
  expect(amendIds(run, "AC1", "ARK-T2,ARK-T5", ...withReason).code).toBe(0);
  // Committing the file turns the refusal into success.
  commitCase(run.workspace, "ARK-T7");
  expect(amendIds(run, "AC1", "ARK-T7", ...withReason).code).toBe(0);
  expect(read(run, "ticket.md")).toContain(listed("ARK-T7"));
  expect(amendments(run)).toHaveLength(2);
});

test("ARK-T230 --verified-by is refused in merge_requests_open and closed, and with an unknown criterion or no reason", () => {
  const project = startProject();
  const make = (ticketId: string) => {
    const run = buildingRun(project, ticketId, [{ id: "AC1", lines: [method, listed("ARK-T1")] }]);
    commitCase(run.workspace, "ARK-T2");
    return run;
  };

  const building = make("ARK-521");
  expectRefused(building, amendIds(building, "AC9", "ARK-T2", ...withReason), "AC9");
  expect(amendIds(building, "AC9", "ARK-T2", ...withReason).err).toContain("AC1");
  expectRefused(building, amendIds(building, "AC1", "ARK-T2"), "--reason");
  expectRefused(building, amendIds(building, "AC1", "ARK-T2", "--reason", "  "), "--reason");
  expect(amendIds(building, "AC1", "ARK-T2", ...withReason).code).toBe(0);
  expect(read(building, "ticket.md")).toContain(listed("ARK-T2"));

  const escalation = make("ARK-522");
  appendEvent(escalation.runDirectory, "step.started", {
    step: "build",
    role: "implementer",
    repo: ".",
    round: 2,
  });
  appendEvent(escalation.runDirectory, "test.completed", {
    passed: false,
    heads: {},
    suites: [{ name: "cli", level: "integration", passed: false }],
    criteria: {},
  });
  expect(ark("status", escalation.runId).out).toContain("phase: escalation");
  expect(amendIds(escalation, "AC1", "ARK-T2", ...withReason).code).toBe(0);

  const open = make("ARK-523");
  appendEvent(open.runDirectory, "merge_request.opened", { repo: ".", url: "u" });
  expectRefused(open, amendIds(open, "AC1", "ARK-T2", ...withReason), "merge_requests_open");

  const closed = make("ARK-524");
  appendEvent(closed.runDirectory, "merge_request.opened", { repo: ".", url: "u" });
  appendEvent(closed.runDirectory, "run.closed", { outcome: "abandoned" });
  expectRefused(closed, amendIds(closed, "AC1", "ARK-T2", ...withReason), "closed");
});

test("ARK-T231 after a --verified-by amend, ark test proves the criterion with the renumbered case ids", () => {
  const caseTest = (id: string, outcome: "pass" | "fail") =>
    `import { expect, test } from "bun:test";\ntest("${id} renumbered case", () => { expect(1).toBe(${outcome === "pass" ? 1 : 2}); });\n`;
  const project = startProject({
    files: { "cases.test.ts": caseTest("ARK-T20", "pass") },
    command: junit("cases.test.ts"),
  });
  const run = buildingRun(project, "ARK-531", [{ id: "AC1", lines: [method, listed("ARK-T10")] }]);
  commitCase(run.workspace, "ARK-T10");
  commitCase(run.workspace, "ARK-T20");
  const criterionId = "ARK-531/AC1";

  const before = ark("test", run.runId);
  expect(before.code, before.err + before.out).toBe(1);
  expect(before.out).toContain(`${criterionId}  missing`);

  expect(amendIds(run, "AC1", "ARK-T20", ...withReason).code).toBe(0);
  const after = ark("test", run.runId);
  expect(after.code, after.err + after.out).toBe(0);
  expect(after.out).toContain(`${criterionId}  passing`);
  expect(after.out).toContain("ARK-T20");
  expect(after.err + after.out).not.toContain("plan check");
  expect(ark("status", run.runId).out).toContain("phase: building");

  writeFileSync(join(run.workspace, "cases.test.ts"), caseTest("ARK-T20", "fail"));
  git(run.workspace, "commit", "-q", "-am", "break ARK-T20");
  const failing = ark("test", run.runId);
  expect(failing.code).toBe(1);
  expect(failing.out).toContain(`${criterionId}  failing`);
});

test("ARK-T232 a --verified-by amend keeps the manual answers of every criterion", () => {
  const project = startProject();
  const run = buildingRun(project, "ARK-541", [
    { id: "AC1", lines: [manual] },
    { id: "AC2", lines: [method, listed("ARK-T1")] },
  ]);
  commitCase(run.workspace, "ARK-T11");
  commitCase(run.workspace, "ARK-T12");
  expect(ark("gate", "record", run.runId, "manual", "AC1", "ok", "--note", "seen").code).toBe(0);

  expect(amendIds(run, "AC1", "ARK-T11", ...withReason).code).toBe(0);
  expect(amendIds(run, "AC2", "ARK-T12", ...withReason).code).toBe(0);

  expect(gate(run, "ARK-541/AC1")).toBe("ok");
  expect(deriveState(readEvents(run.runDirectory)).amended_criteria).toEqual([]);
  expect(ark("status", run.runId).out).not.toContain("amended criteria:");

  // An event from before the change (no verified_by_new) still clears the answer.
  const old = buildingRun(project, "ARK-542", [{ id: "AC1", lines: [manual] }]);
  expect(ark("gate", "record", old.runId, "manual", "AC1", "ok").code).toBe(0);
  appendEvent(old.runDirectory, "criteria.amended", {
    criterion: "ARK-542/AC1",
    old: textOf("AC1"),
    new: "reworded",
    by: "human",
    reason: "why",
  });
  expect(gate(old, "ARK-542/AC1")).toBeUndefined();
});

test("ARK-T233 a text amend of a manual criterion with no --carry-manual clears its manual answer", () => {
  const project = startProject();
  const run = buildingRun(project, "ARK-551", [
    { id: "AC1", lines: [manual] },
    { id: "AC2", lines: [method, listed("ARK-T1")] },
    { id: "AC3", lines: [manual] },
  ]);
  commitCase(run.workspace, "ARK-T2");
  for (const id of ["AC1", "AC3"])
    expect(ark("gate", "record", run.runId, "manual", id, "ok").code).toBe(0);
  const file = textFile(run, "text AC1 and it also requires a second thing");
  const amendText = (criterion: string, ...rest: string[]) =>
    ark("criteria", "amend", run.runId, criterion, file, ...rest);

  expectRefused(run, amendText("AC1", ...withReason, "--carry-manual", ""), "--carry-manual");
  expectRefused(run, amendText("AC1", ...withReason, "--carry-manual", "  "), "--carry-manual");
  expectRefused(run, amendText("AC2", ...withReason, "--carry-manual", "words"), "--carry-manual");
  expectRefused(
    run,
    amendIds(run, "AC1", "ARK-T2", ...withReason, "--carry-manual", "words"),
    "--carry-manual",
  );
  expect(gate(run, "ARK-551/AC1")).toBe("ok");

  expect(amendText("AC1", "--reason", "adds a requirement").code).toBe(0);

  expect(gate(run, "ARK-551/AC1")).toBeUndefined();
  expect(gate(run, "ARK-551/AC3")).toBe("ok");
  expect(amendments(run).at(-1)!.data).toEqual({
    criterion: "ARK-551/AC1",
    old: textOf("AC1"),
    new: "text AC1 and it also requires a second thing",
    by: "human",
    reason: "adds a requirement",
  });
});

test("ARK-T234 a text amend of a manual criterion with --carry-manual keeps the answer and records the old text, new text, reason and words", () => {
  const project = startProject();
  const run = buildingRun(project, "ARK-561", [{ id: "AC1", lines: [manual] }]);
  expect(ark("gate", "record", run.runId, "manual", "AC1", "ok").code).toBe(0);
  const words = "human: same decision, wording only";

  const result = ark(
    "criteria",
    "amend",
    run.runId,
    "AC1",
    textFile(run, "reworded one"),
    "--reason",
    "wording",
    "--carry-manual",
    words,
  );

  expect(result.code, result.err).toBe(0);
  expect(amendments(run).at(-1)!.data).toEqual({
    criterion: "ARK-561/AC1",
    old: textOf("AC1"),
    new: "reworded one",
    by: "human",
    reason: "wording",
    carry_manual: words,
  });
  expect(read(run, "ticket.md")).toContain("reworded one");
  // A fresh process rebuilds the state from the events.
  expect(ark("test", run.runId).out).toContain("ARK-561/AC1  manual ok");
  const status = ark("status", run.runId).out;
  expect(status).toContain("ARK-561/AC1 by human: wording");
  expect(status).toContain("new: ");
});
