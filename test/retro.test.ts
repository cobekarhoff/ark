import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { retro, runningCost } from "../cli/retro.ts";
import { parseClaudeSession } from "../cli/usage/claude.ts";
import { readUsage } from "../cli/usage/index.ts";
import { parseOmpSession } from "../cli/usage/omp.ts";
import { tempArkHome } from "./helpers.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

const fixtures = join(import.meta.dir, "fixtures", "retro");
const runId = "2026-10-29-ARK-901-1";

let arkHome: string;
let runDirectory: string;
let ompRoot: string;
let claudeRoot: string;

/** Copies a sanitized fixture into a session root; `__RUN__` in the fixture becomes the run folder. */
function installSession(root: string, relativePath: string, fixture: string): void {
  const text = readFileSync(join(fixtures, fixture), "utf8").replaceAll("__RUN__", runDirectory);
  mkdirSync(dirname(join(root, relativePath)), { recursive: true });
  writeFileSync(join(root, relativePath), text);
}

function installAllSessions(): void {
  installSession(ompRoot, "platform/session-build.jsonl", "omp/build.jsonl");
  installSession(ompRoot, "shared/session-review.jsonl", "omp/review.jsonl");
  installSession(claudeRoot, "workspace/session-lead.jsonl", "claude/lead.jsonl");
}

type EventRow = [time: string, type: string, data: Record<string, unknown>];

function writeEvents(directory: string, rows: EventRow[]): void {
  mkdirSync(directory, { recursive: true });
  const lines = rows.map(([time, type, data], index) =>
    JSON.stringify({ seq: index + 1, time: `2026-10-29T${time}Z`, type, data }),
  );
  writeFileSync(join(directory, "events.ndjson"), `${lines.join("\n")}\n`);
}

const day = (time: string) => `2026-10-29T${time}Z`;

// The run lead works in the workspace root; build runs in repos/platform, review in repos/shared.
const scenario: EventRow[] = [
  [
    "14:20:00.000",
    "run.started",
    {
      run: runId,
      project: "demo",
      ticket: { id: "ARK-901", title: "t" },
      criteria: ["ARK-901-AC1"],
      round_budget: 2,
    },
  ],
  ["14:20:30.000", "plan.checked", { valid: true, problems: [], plan_hash: "a", steps: [] }],
  ["14:21:00.000", "gate.answered", { gate: "plan", answer: "change" }],
  ["14:21:30.000", "plan.checked", { valid: true, problems: [], plan_hash: "b", steps: [] }],
  ["14:22:00.000", "gate.answered", { gate: "plan", answer: "approve" }],
  [
    "14:24:00.000",
    "step.started",
    { step: "build", role: "implementer", repo: "repos/platform", round: 1 },
  ],
  ["14:25:00.000", "step.finished", { step: "build", outcome: "succeeded" }],
  [
    "14:28:00.000",
    "step.started",
    { step: "review", role: "reviewer", repo: "repos/shared", round: 1 },
  ],
  ["14:55:00.000", "step.finished", { step: "review", outcome: "failed" }],
  ["14:55:30.000", "gate.answered", { gate: "escalation", answer: "one_more_round" }],
  [
    "14:56:00.000",
    "step.started",
    { step: "build", role: "implementer", repo: "repos/platform", round: 2 },
  ],
  ["14:57:00.000", "step.finished", { step: "build", outcome: "succeeded" }],
  ["15:00:00.000", "run.closed", { outcome: "aborted" }],
];

const readMetrics = () => JSON.parse(readFileSync(join(runDirectory, "metrics.json"), "utf8"));

beforeEach(() => {
  arkHome = tempArkHome();
  runDirectory = join(arkHome, "projects", "demo", "runs", runId);
  ompRoot = mkdtempSync(join(tmpdir(), "ark-omp-sessions-"));
  claudeRoot = mkdtempSync(join(tmpdir(), "ark-claude-sessions-"));
  process.env.ARK_OMP_SESSIONS = ompRoot;
  process.env.ARK_CLAUDE_SESSIONS = claudeRoot;
  writeEvents(runDirectory, scenario);
});

describe("usage parsers", () => {
  test("ARK-160-AC7 parses an OMP session file into per-message usage", () => {
    const session = parseOmpSession(join(fixtures, "omp", "build.jsonl"));
    expect(session.cwd).toBe("__RUN__/workspace/repos/platform");
    expect(
      session.messages.map(
        ({ time, model, provider, input, output, cacheRead, cacheWrite, costUsd, toolError }) => ({
          time,
          model,
          provider,
          input,
          output,
          cacheRead,
          cacheWrite,
          costUsd,
          toolError,
        }),
      ),
    ).toEqual([
      {
        time: day("14:24:42.254"),
        model: "claude-haiku-4-5",
        provider: "anthropic",
        input: 10,
        output: 305,
        cacheRead: 0,
        cacheWrite: 15713,
        costUsd: 0.032961,
        toolError: false,
      },
      {
        time: day("14:24:43.535"),
        model: "claude-haiku-4-5",
        provider: "anthropic",
        input: 8,
        output: 44,
        cacheRead: 15713,
        cacheWrite: 327,
        costUsd: 0.0024533000000000003,
        toolError: false,
      },
    ]);
    expect(session.messages[0].sessionFile).toBe(join(fixtures, "omp", "build.jsonl"));
  });

  test("ARK-160-AC7 flags failed tool calls, compactions and a crash on context overflow in an OMP session", () => {
    const session = parseOmpSession(join(fixtures, "omp", "review.jsonl"));
    expect(session.messages.map((message) => message.toolError)).toEqual([false, false, true]);
    expect(session.contextOverflows).toBe(2); // one compaction record, one "prompt is too long" error
    expect(session.crashed).toBe(true);
  });

  test("ARK-160-AC7 parses a Claude Code session file, pricing it and merging the records of one response", () => {
    const session = parseClaudeSession(join(fixtures, "claude", "lead.jsonl"));
    expect(session.cwd).toBe("__RUN__/workspace");
    // Three records, two responses: the first response spans two records with the same message id.
    expect(session.messages).toHaveLength(3);
    const [first, second, unpriced] = session.messages;
    expect(first).toMatchObject({
      model: "claude-sonnet-5",
      provider: "anthropic",
      input: 2,
      output: 175,
      cacheRead: 0,
      cacheWrite: 32857,
    });
    expect(first.costUsd).toBeCloseTo(0.133182, 9); // (2*2 + 175*10 + 32857*4) / 1e6, 1-hour cache write at 2x input
    expect(second.costUsd).toBeCloseTo(0.0108194, 9);
    expect(unpriced.costUsd).toBe("unknown");
    expect(session.messages.map((message) => message.toolError)).toEqual([true, false, false]); // tool_use ids span records
    expect(session.contextOverflows).toBe(1);
  });

  test("ARK-160-AC7 finds session files of both tools by their cwd, including subagent transcripts", () => {
    installAllSessions();
    installSession(ompRoot, "platform/session-build/Helper.jsonl", "omp/build.jsonl");
    mkdirSync(join(ompRoot, "elsewhere"), { recursive: true });
    writeFileSync(
      join(ompRoot, "elsewhere", "other.jsonl"),
      readFileSync(join(fixtures, "omp", "build.jsonl"), "utf8").replaceAll(
        "__RUN__",
        "/somewhere/else",
      ),
    );
    const files = readUsage(runDirectory)
      .map((session) => session.file.replace(ompRoot, "omp").replace(claudeRoot, "claude"))
      .sort();
    expect(files).toEqual([
      "claude/workspace/session-lead.jsonl",
      "omp/platform/session-build.jsonl",
      "omp/platform/session-build/Helper.jsonl",
      "omp/shared/session-review.jsonl",
    ]);
  });
});

describe("ark retro", () => {
  test("ARK-160-AC1 gives byte-identical metrics.json for the same run data", () => {
    installAllSessions();
    retro(runId);
    const first = readFileSync(join(runDirectory, "metrics.json"), "utf8");
    retro(runId);
    expect(readFileSync(join(runDirectory, "metrics.json"), "utf8")).toBe(first);
    expect(first).not.toMatch(/\d\.\d{7,}/); // rounded to 6 decimals
    expect(Object.keys(JSON.parse(first))).toEqual([
      "run",
      "actual_models",
      "same_vendor_review",
      "cost",
      "time",
      "rework",
      "design_rounds",
      "decisions",
      "human_intervention",
      "gates",
      "escaped_defects",
      "orchestration",
      "comparison",
    ]);
  });
  test("ARK-170-AC6 attributes pre-evaluation usage and starts criteria wait at the blocker event", () => {
    const evaluationTime = "14:21:00.000";
    writeEvents(runDirectory, [
      [
        "14:20:00.000",
        "run.started",
        { run: runId, project: "demo", ticket: { id: "ARK-901" }, criteria: ["ARK-901-AC1"] },
      ],
      [evaluationTime, "evaluation.recorded", { blockers: ["blocked"], risks: [] }],
      ["14:21:30.000", "gate.answered", { gate: "criteria", answer: "accept" }],
      ["14:22:00.000", "run.closed", { outcome: "aborted" }],
    ]);
    mkdirSync(join(ompRoot, "evaluator"), { recursive: true });
    writeFileSync(
      join(ompRoot, "evaluator", "session.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "evaluator", timestamp: day("14:20:00.000"), cwd: join(runDirectory, "workspace") })}\n${JSON.stringify(
        {
          type: "message",
          id: "evaluation",
          timestamp: day("14:20:30.000"),
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
              cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
            },
          },
        },
      )}\n`,
    );

    retro(runId);

    expect(readMetrics().cost.by_role.evaluator.usd).toBeCloseTo(0.003);
    expect(readMetrics().time.gate_wait_seconds).toBe(30);
  });

  test("ARK-160-AC1 compares with the project's other closed runs that have metrics", () => {
    const projectRuns = join(arkHome, "projects", "demo", "runs");
    const closed = (name: string, cost: number, wallSeconds: number, closing = true) => {
      const directory = join(projectRuns, name);
      writeEvents(directory, [
        ["10:00:00.000", "run.started", {}],
        ...(closing ? ([["10:05:00.000", "run.closed", {}]] as EventRow[]) : []),
      ]);
      writeFileSync(
        join(directory, "metrics.json"),
        JSON.stringify({ cost: { total_usd: cost }, time: { wall_seconds: wallSeconds } }),
      );
    };
    closed("2026-10-01-ARK-900-1", 1, 10);
    closed("2026-10-02-ARK-900-1", 3, 30);
    closed("2026-10-03-ARK-900-1", 100, 1000, false); // still open: ignored
    retro(runId);
    expect(readMetrics().comparison).toEqual({
      runs_compared: 2,
      median_cost_usd: 2,
      median_wall_seconds: 20,
    });
  });

  test("ARK-160-AC2 reports cost and tokens per run, step, role and model, and the review to build ratio", () => {
    installAllSessions();
    retro(runId);
    const { cost } = readMetrics();
    expect(cost.tokens).toBe(156255);
    expect(cost.total_usd).toBeCloseTo(0.3615345, 5);
    expect(cost.by_step.build).toMatchObject({ tokens: 32120, includes_unknown: false });
    expect(cost.by_step.build.usd).toBeCloseTo(0.0354143, 5);
    expect(cost.by_step.review).toMatchObject({ tokens: 57175, includes_unknown: false });
    expect(cost.by_step.review.usd).toBeCloseTo(0.1821188, 5);
    expect(cost.by_role.implementer.usd).toBeCloseTo(0.0354143, 5);
    expect(cost.by_role.reviewer.usd).toBeCloseTo(0.1821188, 5);
    expect(Object.keys(cost.by_model)).toEqual([
      "claude-future-9",
      "claude-haiku-4-5",
      "claude-opus-5-5",
      "claude-sonnet-5",
    ]);
    expect(cost.by_model["claude-haiku-4-5"].tokens).toBe(32120);
    expect(cost.review_to_build_ratio).toBeCloseTo(0.1821188 / 0.0354143, 4);
  });

  test("ARK-160-AC2 shows running cost from the same session data, without writing files", () => {
    installSession(ompRoot, "platform/session-build.jsonl", "omp/build.jsonl");
    const cost = runningCost(runDirectory);
    expect(cost.tokens).toBe(32120);
    expect(cost.usd).toBeCloseTo(0.0354143, 6);
    expect(() => readFileSync(join(runDirectory, "metrics.json"))).toThrow();
  });

  test("ARK-160-AC3 never counts an unknown cost as zero and flags every total that includes it", () => {
    installAllSessions();
    retro(runId);
    const { cost, orchestration } = readMetrics();
    expect(cost.includes_unknown).toBe(true);
    expect(cost.by_model["claude-future-9"]).toEqual({
      usd: "unknown",
      tokens: 12,
      includes_unknown: true,
    });
    expect(orchestration.master_chief_and_run_lead_cost.includes_unknown).toBe(true);
    expect(orchestration.master_chief_and_run_lead_cost.usd).toBeCloseTo(0.1440014, 5); // the known part only
    expect(runningCost(runDirectory).usd).toBe("unknown");
  });

  test("ARK-160-AC3 reports unknown, not zero, when no session usage exists", () => {
    retro(runId);
    const { cost, orchestration } = readMetrics();
    expect(cost).toMatchObject({
      total_usd: "unknown",
      tokens: 0,
      includes_unknown: true,
      review_to_build_ratio: "unknown",
    });
    expect(cost.by_step.build).toEqual({ usd: "unknown", tokens: 0, includes_unknown: true });
    expect(orchestration.dead_dispatches).toBe(2);
    expect(runningCost(runDirectory)).toEqual({ usd: "unknown", tokens: 0 });
  });

  test("ARK-160-AC4 reports wall time per run and step, with gate wait separate from work time", () => {
    retro(runId);
    const { time } = readMetrics();
    expect(time.wall_seconds).toBe(2400);
    expect(time.by_step).toEqual({ build: 120, review: 1620 });
    // plan change 30s, plan approve 30s (each from a valid plan.checked), escalation 30s (from the failed review)
    expect(time.gate_wait_seconds).toBe(90);
    expect(time.work_seconds).toBe(2310);
  });

  test("ARK-217-AC1 counts each plan wait from the first valid check after the previous answer", () => {
    writeEvents(runDirectory, [
      [
        "14:20:00.000",
        "run.started",
        { run: runId, project: "demo", ticket: { id: "ARK-901" }, criteria: ["ARK-901-AC1"] },
      ],
      ["14:20:30.000", "plan.checked", { valid: true, problems: [], plan_hash: "a", steps: [] }],
      ["14:21:00.000", "gate.answered", { gate: "plan", answer: "change" }],
      ["14:21:30.000", "plan.checked", { valid: true, problems: [], plan_hash: "b", steps: [] }],
      ["14:21:50.000", "plan.checked", { valid: true, problems: [], plan_hash: "b", steps: [] }],
      ["14:22:00.000", "gate.answered", { gate: "plan", answer: "approve" }],
      ["14:23:00.000", "run.closed", { outcome: "aborted" }],
    ]);

    retro(runId);

    // change wait 30 s, approve wait 30 s from the second check (20 s if it restarted at the third)
    expect(readMetrics().time.gate_wait_seconds).toBe(60);
  });

  test("ARK-217-AC2 reports a plan wait of 3601 s for checks at T and T+3600 s and an answer at T+3601 s", () => {
    writeEvents(runDirectory, [
      [
        "14:00:00.000",
        "run.started",
        { run: runId, project: "demo", ticket: { id: "ARK-901" }, criteria: ["ARK-901-AC1"] },
      ],
      ["14:00:00.000", "plan.checked", { valid: true, problems: [], plan_hash: "a", steps: [] }],
      ["15:00:00.000", "plan.checked", { valid: true, problems: [], plan_hash: "a", steps: [] }],
      ["15:00:01.000", "gate.answered", { gate: "plan", answer: "approve" }],
      ["15:01:00.000", "run.closed", { outcome: "aborted" }],
    ]);

    retro(runId);

    expect(readMetrics().time.gate_wait_seconds).toBe(3601);
  });

  /** An event log of plan answers only; each answer is one gate.answered event, in order. */
  const writePlanAnswers = (answers: string[]) => {
    writeEvents(runDirectory, [
      [
        "14:20:00.000",
        "run.started",
        { run: runId, project: "demo", ticket: { id: "ARK-901" }, criteria: ["ARK-901-AC1"] },
      ],
      ...answers.map((answer, index): EventRow => {
        const minute = String(21 + index).padStart(2, "0");
        return [`14:${minute}:00.000`, "gate.answered", { gate: "plan", answer }];
      }),
      ["14:50:00.000", "run.closed", { outcome: "aborted" }],
    ]);
  };

  test("ARK-183-AC1 writes plan_changes: 2 for one change answer and two approve answers", () => {
    writePlanAnswers(["change", "approve", "approve"]);
    retro(runId);
    expect(readMetrics().human_intervention.plan_changes).toBe(2);
  });

  test("ARK-183-AC2 writes plan_changes: 0 for one approve answer and no change answer", () => {
    writePlanAnswers(["approve"]);
    retro(runId);
    expect(readMetrics().human_intervention.plan_changes).toBe(0);
  });

  test("ARK-183-AC3 writes plan_changes: 2 for approve answers at three sequence numbers and no change", () => {
    writePlanAnswers(["approve", "approve", "approve"]);
    retro(runId);
    expect(readMetrics().human_intervention.plan_changes).toBe(2);
  });

  test("ARK-240-AC1 counts the ranked findings of every round file into rework.findings_sent_back", () => {
    const findings = join(runDirectory, "findings");
    mkdirSync(findings, { recursive: true });
    writeFileSync(join(findings, "round-1.md"), "### P1: first\n- P2 (cli/a.ts): second\n");
    writeFileSync(join(findings, "round-2.md"), "* P3 (cli/b.ts): third\n");
    retro(runId);
    expect(readMetrics().rework.findings_sent_back).toBe(3);
  });

  test("ARK-240-AC1 counts ranked heading, numbered and bold bullet lines of round-<n>.md only", () => {
    // the scenario already has a reviewer step that finished failed: it must add nothing
    const findings = join(runDirectory, "findings");
    mkdirSync(findings, { recursive: true });
    writeFileSync(
      join(findings, "round-1.md"),
      "### P1: heading\n1. P0 numbered\n- **P2** bullet\n- format drift in a.ts\nP10 not a rank\n",
    );
    writeFileSync(join(findings, "reviewer.md"), "- P0 not a round file\n");
    writeFileSync(join(findings, "round-x.md"), "- P0 not digits\n");
    retro(runId);
    expect(readMetrics().rework.findings_sent_back).toBe(3);
  });

  test("ARK-240-AC1 reports 0 findings sent back when the run has no findings folder", () => {
    retro(runId);
    expect(readMetrics().rework.findings_sent_back).toBe(0);
  });

  test("ARK-T7 reports rework, plan changes and escaped defects linked to the run", () => {
    writeFileSync(
      join(arkHome, "projects", "demo", "escaped-defects.yml"),
      `- { ticket: ARK-901, run: ${runId}, note: "rounding bug found in production" }\n- { ticket: ARK-777, run: 2026-09-01-ARK-777-1, note: "other run" }\n`,
    );
    mkdirSync(join(runDirectory, "findings"), { recursive: true });
    writeFileSync(join(runDirectory, "findings", "round-1.md"), "### P1: export drops the unit\n");
    retro(runId);
    const metrics = readMetrics();
    expect(metrics.rework).toEqual({
      rounds: 2,
      escalations: 1,
      findings_sent_back: 1,
      findings_left_p0p1: 0,
      merge_steps: 0,
    });
    expect(metrics.human_intervention).toEqual({
      plan_changes: 1,
      mr_comments: 0,
      mr_commits_after_open: 0,
    });
    expect(metrics.escaped_defects).toEqual([
      {
        ticket: "ARK-901",
        run: runId,
        note: "rounding bug found in production",
        fix: "",
        reviewer: "",
      },
    ]);
  });

  const runRetroProcess = () =>
    Bun.spawnSync(["bun", join(import.meta.dir, "..", "cli", "ark.ts"), "retro", runId], {
      env: { ...process.env, ARK_HOME: arkHome },
      stdout: "pipe",
      stderr: "pipe",
    });

  test("ARK-T5 retro keeps fix and reviewer of an escaped defect, for caught, missed and downgraded", () => {
    const base = `run: ${runId}, note: "n"`;
    writeFileSync(
      join(arkHome, "projects", "demo", "escaped-defects.yml"),
      [
        `- { ticket: ARK-213, ${base}, fix: 6e4bd35, reviewer: downgraded }`,
        `- { ticket: ARK-214, ${base}, fix: aaaaaaa, reviewer: caught }`,
        `- { ticket: ARK-215, ${base}, fix: bbbbbbb, reviewer: missed }`,
        `- { ticket: ARK-216, ${base} }`,
        `- { ticket: ARK-777, run: 2026-09-01-ARK-777-1, note: "other", fix: ccccccc, reviewer: caught }`,
      ].join("\n"),
    );
    expect(runRetroProcess().exitCode).toBe(0);
    expect(
      readMetrics().escaped_defects.map((entry: Record<string, string>) => [
        entry.ticket,
        entry.fix,
        entry.reviewer,
      ]),
    ).toEqual([
      ["ARK-213", "6e4bd35", "downgraded"],
      ["ARK-214", "aaaaaaa", "caught"],
      ["ARK-215", "bbbbbbb", "missed"],
      ["ARK-216", "", ""],
    ]);
  });

  test("ARK-T6 retro counts only P0 and P1 lines marked leave inside the Run lead decision section", () => {
    const findings = join(runDirectory, "findings");
    mkdirSync(findings, { recursive: true });
    writeFileSync(
      join(findings, "reviewer.md"),
      [
        "### P1: a",
        "### P0: b",
        "### P2: c",
        "",
        "## Run lead decision",
        "",
        "- P1 a: leave. minor",
        "- P0 b: send back.",
        "- P2 c: leave. later",
        "",
      ].join("\n"),
    );
    expect(runRetroProcess().exitCode).toBe(0);
    expect(readMetrics().rework.findings_left_p0p1).toBe(1);
    const sentBack = readMetrics().rework.findings_sent_back;

    writeFileSync(
      join(findings, "second.md"),
      [
        "## Run lead decision",
        "",
        "- **P1 d: leave.**",
        "- P0 e: send back. A leave would hide the data loss.",
        "",
      ].join("\n"),
    );
    expect(runRetroProcess().exitCode).toBe(0);
    expect(readMetrics().rework.findings_left_p0p1).toBe(2);
    expect(readMetrics().rework.findings_sent_back).toBe(sentBack);

    rmSync(findings, { recursive: true });
    expect(runRetroProcess().exitCode).toBe(0);
    expect(readMetrics().rework.findings_left_p0p1).toBe(0);
  });

  test("ARK-282-AC4 a step finished with not_started adds no round and no cost step; a plain failed one still does", () => {
    const withGhost = (notStarted: boolean): EventRow[] => [
      ...scenario.slice(0, -1),
      [
        "14:58:00.000",
        "step.started",
        { step: "ghost", role: "implementer", repo: "repos/platform", round: 3 },
      ],
      [
        "14:58:30.000",
        "step.finished",
        { step: "ghost", outcome: "failed", ...(notStarted ? { not_started: true } : {}) },
      ],
      scenario.at(-1) as EventRow,
    ];
    writeEvents(runDirectory, withGhost(true));
    retro(runId);
    let metrics = readMetrics();
    expect(metrics.rework).toMatchObject({ rounds: 2, escalations: 1 });
    expect(Object.keys(metrics.cost.by_step)).toEqual(["build", "review"]);

    writeEvents(runDirectory, withGhost(false));
    retro(runId);
    metrics = readMetrics();
    expect(metrics.rework).toMatchObject({ rounds: 3, escalations: 1 });
    expect(Object.keys(metrics.cost.by_step)).toContain("ghost");
  });

  test("ARK-282-AC4 a merge start finished with not_started leaves the real round and drops only the merge step", () => {
    writeEvents(runDirectory, [
      ...scenario.slice(0, -1),
      [
        "14:58:00.000",
        "step.started",
        { step: "build", role: "implementer", repo: "repos/platform", round: 2, merge: true },
      ],
      [
        "14:58:30.000",
        "step.finished",
        { step: "build", outcome: "failed", merge: true, not_started: true },
      ],
      scenario.at(-1) as EventRow,
    ]);
    retro(runId);
    expect(readMetrics().rework).toMatchObject({ rounds: 2, merge_steps: 0 });
  });

  describe("merge request activity", () => {
    const originalPath = process.env.PATH;
    const withMergeRequest: EventRow[] = [
      ...scenario.slice(0, -1),
      [
        "14:56:30.000",
        "merge_request.opened",
        { repo: "repos/platform", url: "https://github.com/acme/platform/pull/7", number: 7 },
      ],
      scenario[scenario.length - 1],
    ];

    beforeEach(() => {
      writeEvents(runDirectory, withMergeRequest);
      mkdirSync(join(runDirectory, "workspace", "repos", "platform"), { recursive: true });
    });

    test("ARK-160-AC5 counts MR comments and commits after open from gh", () => {
      const bin = mkdtempSync(join(tmpdir(), "ark-fake-gh-"));
      const answer = {
        comments: [{}, {}],
        reviews: [{ body: "please change" }, { body: "" }],
        commits: [{ committedDate: day("14:40:00.000") }, { committedDate: day("14:58:00.000") }],
      };
      writeFileSync(join(bin, "gh"), `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(answer)}\nJSON\n`);
      chmodSync(join(bin, "gh"), 0o755);
      process.env.PATH = `${bin}:${originalPath}`;
      try {
        retro(runId);
      } finally {
        process.env.PATH = originalPath;
      }
      expect(readMetrics().human_intervention).toMatchObject({
        mr_comments: 3,
        mr_commits_after_open: 1,
      });
    });

    test("ARK-160-AC5 reports unknown MR activity when gh cannot answer", () => {
      const emptyBin = mkdtempSync(join(tmpdir(), "ark-no-gh-"));
      process.env.PATH = emptyBin;
      try {
        retro(runId);
      } finally {
        process.env.PATH = originalPath;
      }
      expect(readMetrics().human_intervention).toMatchObject({
        mr_comments: "unknown",
        mr_commits_after_open: "unknown",
      });
    });
  });

  test("ARK-160-AC6 reports tool errors, context overflows, idle gaps, crashes, restarts and the cost of the run lead", () => {
    installAllSessions();
    retro(runId);
    expect(readMetrics().orchestration).toEqual({
      sessions: 3,
      restarts: 0,
      crashes: 1,
      stalled_workers: 0,
      dead_dispatches: 0,
      tool_errors: 2,
      context_overflows: 3,
      idle_gaps: 1,
      master_chief_and_run_lead_cost: { usd: 0.144001, tokens: 66960, includes_unknown: true },
    });
  });

  test("ARK-160-AC6 counts a second top-level session for a step as a restart, but not its subagent transcripts", () => {
    installAllSessions();
    installSession(ompRoot, "platform/session-build/Helper.jsonl", "omp/build.jsonl");
    retro(runId);
    expect(readMetrics().orchestration).toMatchObject({ sessions: 3, restarts: 0 });

    installSession(ompRoot, "platform/session-build-again.jsonl", "omp/build.jsonl");
    retro(runId);
    expect(readMetrics().orchestration).toMatchObject({ sessions: 4, restarts: 1 });
  });

  test("ARK-160-AC6 reports a started step that never finished once the run is closed as a stalled worker", () => {
    writeEvents(runDirectory, [
      ...scenario.slice(0, -2), // ends with the round 2 step.started
      scenario[scenario.length - 1],
    ]);
    retro(runId);
    expect(readMetrics().orchestration.stalled_workers).toBe(1);
  });

  const started: EventRow = [
    "14:00:00.000",
    "run.started",
    {
      run: runId,
      project: "demo",
      ticket: { id: "ARK-901" },
      criteria: ["ARK-901-AC1", "ARK-901-AC2"],
    },
  ];
  const testRun = (time: string, criteria: Record<string, string>): EventRow => [
    time,
    "test.completed",
    { passed: true, heads: {}, suites: [], criteria },
  ];
  const manualAnswer = (time: string, criterion: string, answer = "ok"): EventRow => [
    time,
    "gate.answered",
    { gate: "manual", criterion, answer, by: "human" },
  ];

  test("ARK-283-AC3 counts the wait from manual pending to the manual answer as gate wait, not work time (600 s)", () => {
    writeEvents(runDirectory, [
      started,
      testRun("14:10:00.000", { "ARK-901-AC1": "manual pending" }),
      manualAnswer("14:20:00.000", "ARK-901-AC1"),
      ["14:30:00.000", "run.closed", { outcome: "aborted" }],
    ]);
    retro(runId);
    const { time } = readMetrics();
    expect(time.gate_wait_seconds).toBe(600);
    expect(time.work_seconds).toBe(time.wall_seconds - 600);
    expect(time.wall_seconds).toBe(1800);
  });

  test("ARK-283-AC3 the wait starts at the first manual pending, not at a repeated one", () => {
    writeEvents(runDirectory, [
      started,
      testRun("14:10:00.000", { "ARK-901-AC1": "manual pending" }),
      testRun("14:15:00.000", { "ARK-901-AC1": "manual pending" }),
      manualAnswer("14:20:00.000", "ARK-901-AC1"),
      ["14:30:00.000", "run.closed", { outcome: "aborted" }],
    ]);
    retro(runId);
    expect(readMetrics().time.gate_wait_seconds).toBe(600);
  });

  test("ARK-283-AC3 a problem answer closes the wait and a later manual pending opens a new one", () => {
    writeEvents(runDirectory, [
      started,
      testRun("14:10:00.000", { "ARK-901-AC1": "manual pending" }),
      manualAnswer("14:12:00.000", "ARK-901-AC1", "problem"),
      testRun("14:20:00.000", { "ARK-901-AC1": "manual pending" }),
      manualAnswer("14:21:00.000", "ARK-901-AC1"),
      ["14:30:00.000", "run.closed", { outcome: "aborted" }],
    ]);
    retro(runId);
    expect(readMetrics().time.gate_wait_seconds).toBe(180);
  });

  test("ARK-283-AC3 two manual criteria keep separate waits but count elapsed time once", () => {
    writeEvents(runDirectory, [
      started,
      testRun("14:10:00.000", { "ARK-901-AC1": "manual pending", "ARK-901-AC2": "manual pending" }),
      manualAnswer("14:11:00.000", "ARK-901-AC1"),
      manualAnswer("14:15:00.000", "ARK-901-AC2"),
      ["14:30:00.000", "run.closed", { outcome: "aborted" }],
    ]);
    retro(runId);
    // AC1 waits 60 s inside AC2's 300 s; an answer for AC1 must not close AC2, and the union is 300 s.
    expect(readMetrics().time.gate_wait_seconds).toBe(300);
  });

  test("ARK-283-AC3 work time is never negative when manual waits overlap", () => {
    writeEvents(runDirectory, [
      started,
      testRun("14:00:00.000", { "ARK-901-AC1": "manual pending", "ARK-901-AC2": "manual pending" }),
      manualAnswer("14:10:00.000", "ARK-901-AC1"),
      manualAnswer("14:10:00.000", "ARK-901-AC2"),
      ["14:10:00.000", "run.closed", { outcome: "aborted" }],
    ]);
    retro(runId);
    const time = readMetrics().time;
    expect(time.gate_wait_seconds).toBeLessThanOrEqual(time.wall_seconds);
    expect(time.work_seconds).toBeGreaterThanOrEqual(0);
  });

  test("ARK-283-AC3 an unanswered manual pending adds no gate wait", () => {
    writeEvents(runDirectory, [
      started,
      testRun("14:10:00.000", { "ARK-901-AC1": "manual pending" }),
      ["14:30:00.000", "run.closed", { outcome: "aborted" }],
    ]);
    retro(runId);
    expect(readMetrics().time.gate_wait_seconds).toBe(0);
  });
});

describe("ark retro models and vendors", () => {
  const buildFixture = "omp/build.jsonl";
  const reviewFixture = "omp/review.jsonl";

  /** Installs a fixture session with its model renamed, so a step can run on any model. */
  function installModel(path: string, fixture: string, from: string, to: string): void {
    const text = readFileSync(join(fixtures, fixture), "utf8")
      .replaceAll("__RUN__", runDirectory)
      .replaceAll(`"model":"${from}"`, `"model":"${to}"`);
    mkdirSync(dirname(join(ompRoot, path)), { recursive: true });
    writeFileSync(join(ompRoot, path), text);
  }

  function writePlan(steps: [id: string, role: string, repo: string, model: string][]): void {
    const rows = steps.map(
      ([id, role, repo, model]) =>
        `  - {id: ${id}, role: ${role}, repo: ${repo}, model: ${model}, needs: [], criteria: []}`,
    );
    writeFileSync(join(runDirectory, "plan.yml"), `steps:\n${rows.join("\n")}\n`);
  }

  function runRetro(): string {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.join(" "));
    try {
      retro(runId);
    } finally {
      console.log = original;
    }
    return lines.join("\n");
  }

  test("ARK-186-AC1 writes actual_models sorted and de-duplicated, and [] for a step with no session", () => {
    installAllSessions();
    installModel(
      "platform/session-build-2.jsonl",
      buildFixture,
      "claude-haiku-4-5",
      "claude-sonnet-5",
    );
    installModel(
      "platform/session-build-3.jsonl",
      buildFixture,
      "claude-haiku-4-5",
      "claude-sonnet-5",
    );
    writeEvents(runDirectory, [
      ...scenario.slice(0, -1),
      [
        "14:58:00.000",
        "step.started",
        { step: "docs", role: "implementer", repo: "repos/platform", round: 1 },
      ],
      ["14:58:30.000", "step.finished", { step: "docs", outcome: "succeeded" }],
      scenario[scenario.length - 1],
    ]);
    runRetro();
    const { actual_models } = readMetrics();
    expect(actual_models.build).toEqual(["claude-haiku-4-5", "claude-sonnet-5"]);
    expect(actual_models.review).toEqual(["claude-opus-5-5"]);
    expect(actual_models.docs).toEqual([]);
  });

  test("ARK-186-AC2 prints no model changed line when plan and run differ only by provider prefix", () => {
    installAllSessions();
    writePlan([
      ["build", "implementer", "repos/platform", "anthropic/claude-haiku-4-5"],
      ["review", "reviewer", "repos/shared", "anthropic/claude-opus-5-5"],
    ]);
    expect(runRetro()).not.toContain("model changed:");
  });

  test("ARK-186-AC2 prints one model changed line naming step, plan model and actual models on real failover", () => {
    installAllSessions();
    writePlan([
      ["build", "implementer", "repos/platform", "anthropic/claude-haiku-4-5"],
      ["review", "reviewer", "repos/shared", "openai-codex/gpt-6.1-sol"],
    ]);
    const out = runRetro();
    expect(out.match(/model changed:/g)).toHaveLength(1);
    expect(out).toContain(
      "model changed: step review planned openai-codex/gpt-6.1-sol, ran claude-opus-5-5",
    );
  });

  test("ARK-186-AC1 ARK-186-AC2 ARK-186-AC3 without plan.yml still writes metrics.json, same_vendor_review false, no change line", () => {
    installAllSessions();
    const out = runRetro();
    const metrics = readMetrics();
    expect(metrics.same_vendor_review).toBe(false);
    expect(metrics.actual_models.build).toEqual(["claude-haiku-4-5"]);
    expect(out).not.toContain("model changed:");
    expect(out).toContain("same vendor review: false");
  });

  /** Runs the review step in repos/platform, next to build: the events and the review session both say so. */
  function reviewInPlatform(): void {
    installSession(ompRoot, "platform/session-build.jsonl", "omp/build.jsonl");
    const text = readFileSync(join(fixtures, "omp", "review.jsonl"), "utf8")
      .replaceAll("__RUN__", runDirectory)
      .replaceAll("/workspace/repos/shared", "/workspace/repos/platform");
    writeFileSync(join(ompRoot, "platform", "session-review.jsonl"), text);
    writeEvents(
      runDirectory,
      scenario.map(([time, type, data]): EventRow => [
        time,
        type,
        data.step === "review" ? { ...data, repo: "repos/platform" } : data,
      ]),
    );
  }

  test("ARK-186-AC3 same vendor review is true and names both steps when reviewer and implementer share a vendor and repo", () => {
    reviewInPlatform();
    writePlan([
      ["build", "implementer", "repos/platform", "claude-haiku-4-5"],
      ["review", "reviewer", "repos/platform", "claude-opus-5-5"],
    ]);
    const out = runRetro();
    expect(readMetrics().same_vendor_review).toBe(true);
    expect(out).toContain("same vendor review: true (review with build in repos/platform)");
  });

  test("ARK-186-AC3 same vendor review follows the executed repos: plan repos that agree but runs in different repos is false", () => {
    installAllSessions(); // build ran in repos/platform, review in repos/shared
    writePlan([
      ["build", "implementer", "repos/platform", "claude-haiku-4-5"],
      ["review", "reviewer", "repos/platform", "claude-opus-5-5"],
    ]);
    expect(runRetro()).toContain("same vendor review: false");
    expect(readMetrics().same_vendor_review).toBe(false);
  });

  test("ARK-186-AC3 same vendor review follows the executed repos: plan repos that differ but runs in one repo is true", () => {
    reviewInPlatform();
    writePlan([
      ["build", "implementer", "repos/platform", "claude-haiku-4-5"],
      ["review", "reviewer", "repos/shared", "claude-opus-5-5"],
    ]);
    expect(runRetro()).toContain("same vendor review: true (review with build in repos/platform)");
    expect(readMetrics().same_vendor_review).toBe(true);
  });

  test("ARK-186-AC3 same vendor review is false for a gpt reviewer and a claude implementer", () => {
    installAllSessions();
    installModel("shared/session-review.jsonl", reviewFixture, "claude-opus-5-5", "gpt-6.1-sol");
    writePlan([
      ["build", "implementer", "repos/platform", "claude-haiku-4-5"],
      ["review", "reviewer", "repos/platform", "gpt-6.1-sol"],
    ]);
    const out = runRetro();
    expect(readMetrics().same_vendor_review).toBe(false);
    expect(out).toContain("same vendor review: false");
  });

  test("ARK-186-AC3 same vendor review is false when the same-vendor reviewer is in another repo", () => {
    installAllSessions();
    writePlan([
      ["build", "implementer", "repos/platform", "claude-haiku-4-5"],
      ["review", "reviewer", "repos/shared", "claude-opus-5-5"],
    ]);
    expect(runRetro()).toContain("same vendor review: false");
    expect(readMetrics().same_vendor_review).toBe(false);
  });

  test("ARK-186-AC3 a model with an unknown prefix has no vendor, so same vendor review is false", () => {
    installModel("platform/session-build.jsonl", buildFixture, "claude-haiku-4-5", "llama-3");
    installModel("shared/session-review.jsonl", reviewFixture, "claude-opus-5-5", "llama-3");
    writePlan([
      ["build", "implementer", "repos/platform", "llama-3"],
      ["review", "reviewer", "repos/platform", "llama-3"],
    ]);
    runRetro();
    expect(readMetrics().same_vendor_review).toBe(false);
  });

  /** The review step runs in repos/platform. Its main session ran `main`; `sub` adds a sub-session on another model. */
  function reviewOnModels(main: string, sub?: string, helperModel?: string): void {
    reviewInPlatform();
    const text = (model: string) =>
      readFileSync(join(fixtures, "omp", "review.jsonl"), "utf8")
        .replaceAll("__RUN__", runDirectory)
        .replaceAll("/workspace/repos/shared", "/workspace/repos/platform")
        .replaceAll('"model":"claude-opus-5-5"', `"model":"${model}"`);
    // An omp helper call (job-caption) after the real messages, inside the review window.
    const helper = helperModel
      ? `${JSON.stringify({ type: "model_usage", timestamp: day("14:50:30.000"), purpose: "job-caption", provider: "openai-codex", model: helperModel, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } })}\n`
      : "";
    writeFileSync(join(ompRoot, "platform", "session-review.jsonl"), text(main) + helper);
    if (sub) {
      mkdirSync(join(ompRoot, "platform", "session-review"), { recursive: true });
      writeFileSync(join(ompRoot, "platform", "session-review", "Helper.jsonl"), text(sub));
    }
    writePlan([
      ["build", "implementer", "repos/platform", "claude-haiku-4-5"],
      ["review", "reviewer", "repos/platform", main],
    ]);
  }

  test("ARK-310-AC3 same vendor review is true when every model of the review step shares the implementer vendor", () => {
    reviewOnModels("claude-opus-5-5", "claude-sonnet-5");
    const out = runRetro();
    expect(readMetrics().same_vendor_review).toBe(true);
    expect(out).toContain("same vendor review: true (review with build in repos/platform)");
    expect(out).not.toContain("mixed");
  });

  test("ARK-310-AC3 same vendor review is false and nothing is mixed when the review step ran on another vendor", () => {
    reviewOnModels("gpt-6.1-sol");
    const out = runRetro();
    expect(readMetrics().same_vendor_review).toBe(false);
    expect(out).toContain("same vendor review: false");
    expect(out).not.toContain("mixed");
  });

  test("ARK-310-AC3 a review step with a codex model and an anthropic sub-session is mixed, not same vendor", () => {
    reviewOnModels("gpt-6.1-sol", "claude-opus-5-5");
    const out = runRetro();
    expect(readMetrics().same_vendor_review).toBe(false);
    expect(out).toContain("same vendor review: false");
    const mixedLine = out.split("\n").find((line) => line.includes("mixed"));
    expect(mixedLine).toBeDefined();
    expect(mixedLine).toContain("review");
  });

  test("ARK-310-AC3 a helper call with a purpose field and another vendor does not make the review step mixed or changed", () => {
    reviewOnModels("claude-opus-5-5", undefined, "gpt-6-luna");
    const out = runRetro();
    expect(readMetrics().same_vendor_review).toBe(true);
    expect(out).toContain("same vendor review: true");
    expect(out).not.toContain("mixed");
    expect(out).not.toContain("gpt-6-luna");
  });
});
