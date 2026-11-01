import { beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ark, tempArkHome, tempGitRepo, writeProject, writeTicket } from "./helpers.ts";

const criteria = Array.from({ length: 14 }, (_, index) => ({
  id: `ARK-173-AC${index + 1}`,
  text: `criterion ${index + 1}`,
}));

type RetroEventRow = [string, string, Record<string, unknown>];
let projectDirectory: string;
let runId: string;
let runDirectory: string;

beforeEach(() => {
  tempArkHome();
  projectDirectory = writeProject("demo", {
    workspace: tempGitRepo(),
    ticket_source: "local",
    suites: [{ name: "cli", level: "integration", repo: ".", command: "true", parser: "bun" }],
    roles: {
      implementer: { harness: "omp", model: "pi/task" },
      validator: { harness: "omp", model: "pi/validate" },
      reviewer: { harness: "omp", model: "pi/validate" },
      evaluator: { harness: "omp", model: "pi/validate" },
      designer: { harness: "omp", model: "pi/design" },
    },
  });
  expect(ark("run", "start", writeTicket("demo", "ARK-173", criteria)).code).toBe(0);
  runId = readdirSync(join(projectDirectory, "runs"))[0];
  runDirectory = join(projectDirectory, "runs", runId);
});

const events = () =>
  readFileSync(join(runDirectory, "events.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

const evaluation = (surfaces: string[] = ["none"]) => {
  writeFileSync(
    join(runDirectory, "evaluation.md"),
    `## Blockers\n\n## Risks\n\n## Surfaces\n${surfaces.map((surface) => `\n- ${surface}`).join("")}\n`,
  );
  return ark("evaluation", "record", runId);
};

const card = (id: string, fields = "Recommended: yes\n") =>
  `## ${id} ${id} approach\nApproach: Keep the change in the current command.\nInterfaces: cli/strategy.ts and cli/plan.ts.\nTradeoffs: Small change; leaves broader redesign out.\nSteps: Implement and verify.\n${fields}`;

const strategies = (...cards: string[]) =>
  writeFileSync(join(runDirectory, "strategies.md"), cards.join("\n"));

const decisionPlan = (decisions: unknown[]) => ({
  design: {
    approach: "Implement the selected direction.",
    interfaces: [{ name: "plan", callers: ["ark plan check"] }],
    example: "decision output",
  },
  summary: {
    why: "Expose human choices.",
    changes: criteria.map(({ id }) => ({
      criterion: id,
      where: "cli/plan.ts",
      now: "No decisions.",
      fix: "Render decisions.",
    })),
  },
  decisions,
  steps: [
    {
      id: "build",
      role: "implementer",
      repo: ".",
      harness: "omp",
      model: "pi/task",
      needs: [],
      criteria: criteria.map(({ id }) => id),
    },
  ],
  test_cases: criteria.map(({ id }) => ({
    id: `case-${id}`,
    criterion: id,
    level: "integration",
    given: ["a run"],
    when: ["run the command"],
    then: ["observe the result"],
    expected: "When used, the system shall behave as specified.",
  })),
});

test("ARK-173-AC1 plan check refuses every invalid decision and names it", () => {
  evaluation();
  strategies(card("S1", "Reason: This is the only feasible approach.\n"));
  expect(ark("strategy", "record", runId).code).toBe(0);
  const plan = decisionPlan([
    {
      id: "too-few",
      question: "Choose",
      options: [{ label: "A", tradeoffs: "small" }],
      recommended: "A",
      chosen: "",
    },
    {
      id: "too-many",
      question: "Choose",
      options: ["A", "B", "C", "D", "E"],
      recommended: "A",
      chosen: "",
    },
    {
      id: "bad-recommendation",
      question: "Choose",
      options: ["A", "B"],
      recommended: "C",
      chosen: "",
    },
    { id: "bad-choice", question: "Choose", options: ["A", "B"], recommended: "A", chosen: "C" },
  ]);
  writeFileSync(join(runDirectory, "plan.yml"), JSON.stringify(plan));
  const result = ark("plan", "check", runId);
  expect(result.code).toBe(1);
  for (const id of ["too-few", "too-many", "bad-recommendation", "bad-choice"])
    expect(result.out).toContain(id);
});

test("ARK-173-AC2 plan markdown renders open questions and chosen options", () => {
  evaluation();
  strategies(card("S1", "Reason: This is the only feasible approach.\n"));
  expect(ark("strategy", "record", runId).code).toBe(0);
  const plan = decisionPlan([
    {
      id: "open",
      question: "Which storage?",
      options: [
        { label: "File", tradeoffs: "Simple" },
        { label: "Database", tradeoffs: "Queryable" },
      ],
      recommended: "File",
      chosen: "",
    },
    {
      id: "decided",
      question: "Which format?",
      options: [
        { label: "JSON", tradeoffs: "Readable" },
        { label: "Binary", tradeoffs: "Compact" },
      ],
      recommended: "JSON",
      chosen: "Binary",
    },
  ]);
  writeFileSync(join(runDirectory, "plan.yml"), JSON.stringify(plan));
  expect(ark("plan", "check", runId).code).toBe(0);
  const markdown = readFileSync(join(runDirectory, "plan.md"), "utf8");
  expect(markdown).toContain(":::question\nWhich storage? (open)");
  expect(markdown).toContain("- [ ] File — Simple");
  expect(markdown).toContain("Recommended: File");
  expect(markdown).toContain("- [x] Binary — Compact");
});

test("ARK-173-AC3 checked plans count open decisions and cannot be approved", () => {
  evaluation();
  strategies(card("S1", "Reason: This is the only feasible approach.\n"));
  expect(ark("strategy", "record", runId).code).toBe(0);
  writeFileSync(
    join(runDirectory, "plan.yml"),
    JSON.stringify(
      decisionPlan([
        {
          id: "storage",
          question: "Which storage?",
          options: ["File", "Database"],
          recommended: "File",
          chosen: "",
        },
      ]),
    ),
  );
  expect(ark("plan", "check", runId).code).toBe(0);
  expect(events().findLast((event) => event.type === "plan.checked").data.open_decisions).toBe(1);
  const approval = ark("gate", "record", runId, "plan", "approve");
  expect(approval.code).toBe(1);
  expect(approval.err).toContain("open decision");
});
test("ARK-173-AC4 strategy record stores card metadata and refuses malformed inputs", () => {
  strategies(card("S1"), card("S2", "Recommended: no\n"));
  expect(ark("strategy", "record", runId).err).toContain("missing evaluation.recorded");
  expect(evaluation().code).toBe(0);
  strategies(card("S1"), card("S2", "Recommended: no\n"));
  expect(ark("strategy", "record", runId).code).toBe(0);
  expect(events().findLast((event) => event.type === "strategy.recorded").data).toMatchObject({
    count: 2,
    recommended: "S1",
    cards: ["S1", "S2"],
  });

  const cases: [string | null, string][] = [
    [null, "strategies.md"],
    ["## S1 One\nInterfaces: cli.\nTradeoffs: small.\nReason: only.\n", "approach"],
    ["## S1 One\nApproach: works.\nTradeoffs: small.\nReason: only.\n", "interfaces"],
    ["## S1 One\nApproach: works.\nInterfaces: cli.\nReason: only.\n", "tradeoffs"],
    [card("S1", "Mockup: missing.html\nReason: only.\n"), "not a file in the run folder"],
    [card("S1", ""), "Reason:"],
  ];
  for (const [content, message] of cases) {
    if (content === null) unlinkSync(join(runDirectory, "strategies.md"));
    else strategies(content);
    const result = ark("strategy", "record", runId);
    expect(result.code).toBe(1);
    expect(result.err).toContain(message);
  }
});

test("ARK-173-AC5 multiple strategies wait for a valid card choice or abort", () => {
  evaluation();
  strategies(card("S1"), card("S2", "Recommended: no\n"));
  expect(ark("strategy", "record", runId).code).toBe(0);
  expect(JSON.parse(readFileSync(join(runDirectory, "state.json"), "utf8")).phase).toBe(
    "awaiting_strategy",
  );
  const unknown = ark("gate", "record", runId, "strategy", "S9");
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain("S1, S2");
  expect(ark("gate", "record", runId, "strategy", "S2").code).toBe(0);
  expect(JSON.parse(readFileSync(join(runDirectory, "state.json"), "utf8")).phase).toBe("planning");

  tempArkHome();
  projectDirectory = writeProject("demo", {
    workspace: tempGitRepo(),
    ticket_source: "local",
    suites: [{ name: "cli", level: "integration", repo: ".", command: "true", parser: "bun" }],
    roles: {
      implementer: { harness: "omp", model: "pi/task" },
      validator: { harness: "omp", model: "pi/validate" },
      reviewer: { harness: "omp", model: "pi/validate" },
      evaluator: { harness: "omp", model: "pi/validate" },
      designer: { harness: "omp", model: "pi/design" },
    },
  });
  expect(ark("run", "start", writeTicket("demo", "ARK-173", criteria)).code).toBe(0);
  runId = readdirSync(join(projectDirectory, "runs"))[0];
  runDirectory = join(projectDirectory, "runs", runId);
  evaluation();
  strategies(card("S1"), card("S2", "Recommended: no\n"));
  expect(ark("strategy", "record", runId).code).toBe(0);
  expect(ark("gate", "record", runId, "strategy", "abort").code).toBe(0);
  expect(JSON.parse(readFileSync(join(runDirectory, "state.json"), "utf8")).phase).toBe("closed");
});

test("ARK-173-AC6 a single strategy skips the gate and appears with its reason in the plan", () => {
  evaluation();
  strategies(card("S1", "Reason: The existing interface is the only supported route.\n"));
  expect(ark("strategy", "record", runId).code).toBe(0);
  expect(JSON.parse(readFileSync(join(runDirectory, "state.json"), "utf8")).phase).toBe("planning");
  writeFileSync(join(runDirectory, "plan.yml"), JSON.stringify(decisionPlan([])));
  expect(ark("plan", "check", runId).code).toBe(0);
  const markdown = readFileSync(join(runDirectory, "plan.md"), "utf8");
  expect(markdown).toContain("## Strategy");
  expect(markdown).toContain("### S1 S1 approach");
  expect(markdown).toContain(
    "Only one strategy considered, because The existing interface is the only supported route.",
  );
});

test("ARK-173-AC7 plan check refuses runs without a strategy record and during strategy wait", () => {
  evaluation();
  writeFileSync(join(runDirectory, "plan.yml"), JSON.stringify(decisionPlan([])));
  const missing = ark("plan", "check", runId);
  expect(missing.code).toBe(1);
  expect(missing.err).toContain("strategy.recorded");
  strategies(card("S1"), card("S2", "Recommended: no\n"));
  expect(ark("strategy", "record", runId).code).toBe(0);
  const waiting = ark("plan", "check", runId);
  expect(waiting.code).toBe(1);
  expect(waiting.err).toContain("gate.answered strategy");
});

test("ARK-173-AC8 evaluation record requires known surfaces and persists them", () => {
  writeFileSync(join(runDirectory, "evaluation.md"), "## Blockers\n\n## Risks\n\n");
  expect(ark("evaluation", "record", runId).err).toContain('no "surfaces" list');
  writeFileSync(
    join(runDirectory, "evaluation.md"),
    "## Blockers\n\n## Risks\n\n## Surfaces\n- hologram\n",
  );
  const invalid = ark("evaluation", "record", runId);
  expect(invalid.code).toBe(1);
  expect(invalid.err).toContain("hologram");
  expect(evaluation(["web_ui", "document"]).code).toBe(0);
  expect(events().findLast((event) => event.type === "evaluation.recorded").data.surfaces).toEqual([
    "web_ui",
    "document",
  ]);
});

test("ARK-173-AC9 a visible surface requires every strategy card to link a mockup", () => {
  expect(evaluation(["cli_output"]).code).toBe(0);
  strategies(card("S1", "Reason: only.\n"));
  const result = ark("strategy", "record", runId);
  expect(result.code).toBe(1);
  expect(result.err).toContain("S1");
  mkdirSync(join(runDirectory, "mockups"), { recursive: true });
  writeFileSync(join(runDirectory, "mockups", "s1.html"), "<h1>CLI output</h1>");
  strategies(card("S1", "Mockup: mockups/s1.html\nReason: only.\n"));
  expect(ark("strategy", "record", runId).code).toBe(0);
});

test("ARK-173-AC10 old config loads but visible work requires a configured Designer", () => {
  const oldConfig = JSON.parse(readFileSync(join(projectDirectory, "ark.yml"), "utf8"));
  delete oldConfig.roles.designer;
  writeProject("demo", oldConfig);
  expect(ark("status", runId).code).toBe(0);
  expect(evaluation(["web_ui"]).code).toBe(0);
  strategies(card("S1", "Mockup: mockups/s1.html\nReason: only.\n"));
  const refused = ark("strategy", "record", runId);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("roles.designer");
  expect(refused.err).toContain("harness and model");
  writeProject("demo", {
    ...oldConfig,
    roles: { ...oldConfig.roles, designer: { harness: "omp", model: "pi/design" } },
  });
  mkdirSync(join(runDirectory, "mockups"), { recursive: true });
  writeFileSync(join(runDirectory, "mockups", "s1.html"), "<h1>Sketch</h1>");
  expect(ark("strategy", "record", runId).code).toBe(0);
  const bootstrap = readFileSync(
    join(import.meta.dir, "../skills/ark/playbooks/bootstrap.md"),
    "utf8",
  );
  expect(bootstrap).toContain("designer: { harness: <harness>, model: <model> }");
});

test("ARK-173-AC13 mockups remain outside actual worktrees and use one human review loop", () => {
  evaluation(["web_ui"]);
  mkdirSync(join(runDirectory, "mockups"), { recursive: true });
  writeFileSync(join(runDirectory, "mockups", "s1.html"), "<h1>mockup</h1>");
  strategies(card("S1", "Mockup: mockups/s1.html\nReason: only.\n"));
  expect(ark("strategy", "record", runId).code).toBe(0);
  writeFileSync(join(runDirectory, "plan.yml"), JSON.stringify(decisionPlan([])));
  expect(ark("plan", "check", runId).code).toBe(0);
  expect(ark("gate", "record", runId, "plan", "approve").code).toBe(0);
  expect(ark("worktree", "create", runId, ".").code).toBe(0);
  expect(existsSync(join(runDirectory, "mockups", "s1.html"))).toBe(true);
  expect(existsSync(join(runDirectory, "workspace", "mockups", "s1.html"))).toBe(false);

  const lead = readFileSync(join(import.meta.dir, "../skills/ark/playbooks/run-lead.md"), "utf8");
  const worker = readFileSync(join(import.meta.dir, "../skills/ark/playbooks/worker.md"), "utf8");
  expect(lead).toContain('plannotator annotate "<run folder>/strategies.md"');
  expect(lead).toContain("same Designer");
  expect(lead).toContain("Mockups and prototypes stay in the run folder or a throwaway worktree");
  expect(worker).toContain("<run folder>/mockups/");
  expect(worker).toContain("throwaway worktree");
});

test("ARK-173-AC14 Designer and override instructions keep generation and learning approval bounded", () => {
  const worker = readFileSync(join(import.meta.dir, "../skills/ark/playbooks/worker.md"), "utf8");
  const reviewer = readFileSync(join(import.meta.dir, "../skills/ark/rubrics/reviewer.md"), "utf8");
  const retro = readFileSync(join(import.meta.dir, "../skills/ark/playbooks/retro.md"), "utf8");
  expect(worker).toContain("Never run `impeccable generate`, and never use impeccable live mode.");
  expect(reviewer).toContain("web-design-guidelines");
  expect(reviewer).toContain("review-animations");
  expect(retro).toContain("one `learnings.md` entry");
  expect(retro).toContain("It changes nothing until the human approves it.");
});

test("ARK-173-AC11 retro counts design rounds, strategy wait and Designer cost without escalation", () => {
  const rows: RetroEventRow[] = [
    [
      "14:20:00.000",
      "run.started",
      {
        run: runId,
        project: "demo",
        ticket: { id: "ARK-173", title: "test" },
        criteria: ["ARK-173-AC1"],
        round_budget: 2,
      },
    ],
    ["14:21:00.000", "evaluation.recorded", { blockers: [], risks: [], surfaces: ["web_ui"] }],
    ["14:22:00.000", "strategy.recorded", { count: 2, recommended: "S1", cards: ["S1", "S2"] }],
    ["14:23:00.000", "strategy.recorded", { count: 2, recommended: "S1", cards: ["S1", "S2"] }],
    ["14:24:00.000", "strategy.recorded", { count: 2, recommended: "S1", cards: ["S1", "S2"] }],
    ["14:27:00.000", "gate.answered", { gate: "strategy", answer: "S2" }],
    ["14:28:00.000", "step.started", { step: "designer", role: "designer", repo: ".", round: 1 }],
    ["14:30:00.000", "step.finished", { step: "designer", outcome: "succeeded" }],
    ["14:31:00.000", "run.closed", { outcome: "aborted" }],
  ];
  writeFileSync(
    join(runDirectory, "events.ndjson"),
    `${rows.map(([time, type, data], index) => JSON.stringify({ seq: index + 1, time: `2026-10-29T${time}Z`, type, data })).join("\n")}\n`,
  );
  const sessionRoot = mkdtempSync(join(tmpdir(), "ark-designer-session-"));
  process.env.ARK_OMP_SESSIONS = sessionRoot;
  mkdirSync(join(runDirectory, "workspace"), { recursive: true });
  const session = [
    {
      type: "session",
      version: 3,
      id: "designer",
      timestamp: "2026-10-29T14:28:00.000Z",
      cwd: join(runDirectory, "workspace"),
    },
    {
      type: "message",
      id: "design-cost",
      timestamp: "2026-10-29T14:29:00.000Z",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        content: [],
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0.1, output: 0.15, cacheRead: 0, cacheWrite: 0, total: 0.25 },
        },
      },
    },
  ];
  mkdirSync(join(sessionRoot, "demo"), { recursive: true });
  writeFileSync(
    join(sessionRoot, "demo", "designer.jsonl"),
    `${session.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  const retroResult = ark("retro", runId);
  expect(retroResult).toMatchObject({ code: 0 });
  const metrics = JSON.parse(readFileSync(join(runDirectory, "metrics.json"), "utf8"));
  expect(metrics.design_rounds).toBe(2);
  expect(metrics.time.gate_wait_seconds).toBe(300);
  expect(metrics.cost.by_role.designer.usd).toBeCloseTo(0.25);
  expect(metrics.rework.escalations).toBe(0);
});

test("ARK-173-AC12 retro counts strategy and plan decision overrides", () => {
  const rows: RetroEventRow[] = [
    [
      "14:20:00.000",
      "run.started",
      {
        run: runId,
        project: "demo",
        ticket: { id: "ARK-173", title: "test" },
        criteria: ["ARK-173-AC1"],
        round_budget: 2,
      },
    ],
    ["14:21:00.000", "strategy.recorded", { count: 2, recommended: "S1", cards: ["S1", "S2"] }],
    ["14:22:00.000", "gate.answered", { gate: "strategy", answer: "S2" }],
    ["14:23:00.000", "run.closed", { outcome: "aborted" }],
  ];
  writeFileSync(
    join(runDirectory, "events.ndjson"),
    `${rows.map(([time, type, data], index) => JSON.stringify({ seq: index + 1, time: `2026-10-29T${time}Z`, type, data })).join("\n")}\n`,
  );
  writeFileSync(
    join(runDirectory, "plan.yml"),
    JSON.stringify({
      decisions: [
        {
          id: "format",
          question: "Choose",
          options: [
            { label: "JSON", tradeoffs: "readable" },
            { label: "binary", tradeoffs: "compact" },
          ],
          recommended: "JSON",
          chosen: "binary",
        },
        {
          id: "storage",
          question: "Choose",
          options: [
            { label: "file", tradeoffs: "simple" },
            { label: "database", tradeoffs: "queryable" },
          ],
          recommended: "file",
          chosen: "file",
        },
      ],
    }),
  );
  expect(ark("retro", runId).code).toBe(0);
  expect(JSON.parse(readFileSync(join(runDirectory, "metrics.json"), "utf8")).decisions).toEqual({
    total: 3,
    overridden: 2,
  });
});
