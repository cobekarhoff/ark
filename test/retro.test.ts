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
let codexRoot: string;

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
      round_budget: 1,
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
  ["14:55:00.000", "escalation.requested", { reason: "review failed" }],
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
  codexRoot = mkdtempSync(join(tmpdir(), "ark-codex-sessions-"));
  process.env.ARK_CODEX_SESSIONS = codexRoot;
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

/** Runs `ark retro` and returns what it prints. */
function captureRetro(): string {
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

describe("ark retro", () => {
  test("ARK-T170 gives byte-identical metrics.json for the same run data", () => {
    installAllSessions();
    installToolErrorSessions();
    retro(runId);
    const first = readFileSync(join(runDirectory, "metrics.json"), "utf8");
    retro(runId);
    expect(readFileSync(join(runDirectory, "metrics.json"), "utf8")).toBe(first);
    expect(first).not.toMatch(/\d\.\d{7,}/); // rounded to 6 decimals
    // The list has ties in count, so only a fixed order keeps the bytes equal.
    expect(JSON.parse(first).orchestration.tool_error_list.length).toBeGreaterThan(1);
    expect(Object.keys(JSON.parse(first))).toEqual([
      "run",
      "actual_models",
      "same_vendor_review",
      "cost",
      "time",
      "rework",
      "tests",
      "design_rounds",
      "decisions",
      "human_intervention",
      "gates",
      "escaped_defects",
      "orchestration",
      "resources",
      "comparison",
    ]);
  });
  const longError =
    "Edit failed: the old text was not found in the file because the file changed since it was last read, so the replacement was refused";

  function installToolErrorSessions(): void {
    installSession(ompRoot, "platform/session-tool-errors.jsonl", "omp/tool-errors.jsonl");
    installSession(claudeRoot, "workspace/session-tool-errors.jsonl", "claude/tool-errors.jsonl");
    installSession(codexRoot, "2026/10/29/rollout-tool-errors.jsonl", "codex/tool-errors.jsonl");
  }

  /** One omp session in the run folder: each call is a tool, its arguments and the error text (undefined: it succeeds). */
  function installOmpCalls(
    name: string,
    calls: { tool: string; args: unknown; error?: string }[],
  ): void {
    const message = (id: string, body: Record<string, unknown>) => ({
      type: "message",
      id,
      timestamp: day("14:30:00.000"),
      message: body,
    });
    const records: unknown[] = [
      { type: "session", id: name, timestamp: day("14:30:00.000"), cwd: runDirectory },
      message("a", {
        role: "assistant",
        model: "claude-haiku-4-5",
        content: calls.map((call, index) => ({
          type: "toolCall",
          id: `t${index}`,
          name: call.tool,
          arguments: call.args,
        })),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
      }),
      ...calls.map((call, index) =>
        message(`r${index}`, {
          role: "toolResult",
          toolCallId: `t${index}`,
          isError: call.error !== undefined,
          content: [{ type: "text", text: call.error ?? "ok" }],
        }),
      ),
    ];
    mkdirSync(join(ompRoot, "platform"), { recursive: true });
    writeFileSync(
      join(ompRoot, "platform", `${name}.jsonl`),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
  }

  test("ARK-T192 lists the failed calls of an omp, a claude and a codex session by tool and first command word", () => {
    installToolErrorSessions();
    const printed = captureRetro();
    const orchestration = readMetrics().orchestration;
    // Codex shell calls fail three ways: a non-zero exit, an object success:false and a serialized success:false.
    // The count-2 tie and the count-1 tie sort by tool, plain string comparison: uppercase first.
    expect(orchestration.tool_error_list).toEqual([
      { tool: "shell", word: "orca", count: 3, first_error: "orca: no such run" },
      { tool: "Bash", word: "orca", count: 2, first_error: "orca: command failed" },
      { tool: "bash", word: "orca", count: 2, first_error: "usage: orca run list" },
      { tool: "Edit", word: "", count: 1, first_error: longError.slice(0, 120) },
      {
        tool: "apply_patch",
        word: "",
        count: 1,
        first_error: "patch failed: hunk 1 does not apply",
      },
      { tool: "edit", word: "", count: 1, first_error: "Stale tag: file changed since last read" },
    ]);
    expect(longError.length).toBeGreaterThan(120);
    // The list counts failed calls (10); tool_errors counts the messages that hold them (omp 1, claude 1, codex 0).
    expect(
      orchestration.tool_error_list.reduce(
        (sum: number, entry: { count: number }) => sum + entry.count,
        0,
      ),
    ).toBe(10);
    expect(orchestration.tool_errors).toBe(2);
    // Stdout: exactly the five largest, after the orchestration line, the word omitted when empty.
    const lines = printed.split("\n");
    const start = lines.findIndex((line) => line.startsWith("orchestration:"));
    expect(
      lines.slice(start + 1, start + 7).filter((line) => line.startsWith("tool error:")),
    ).toEqual([
      "tool error: shell orca x3: orca: no such run",
      "tool error: Bash orca x2: orca: command failed",
      "tool error: bash orca x2: usage: orca run list",
      `tool error: Edit x1: ${longError.slice(0, 120)}`,
      "tool error: apply_patch x1: patch failed: hunk 1 does not apply",
    ]);
    expect(lines.filter((line) => line.startsWith("tool error:"))).toHaveLength(5);
  });

  test("ARK-T192 writes every pair to metrics.json but prints only the five largest of seven", () => {
    installOmpCalls(
      "seven",
      ["a", "b", "c", "d", "e", "f", "g"].flatMap((tool, index) =>
        Array.from({ length: 7 - index }, () => ({
          tool,
          args: { command: "run it" },
          error: `${tool} failed`,
        })),
      ),
    );
    const printed = captureRetro();
    expect(
      readMetrics().orchestration.tool_error_list.map((entry: { tool: string; count: number }) => [
        entry.tool,
        entry.count,
      ]),
    ).toEqual([
      ["a", 7],
      ["b", 6],
      ["c", 5],
      ["d", 4],
      ["e", 3],
      ["f", 2],
      ["g", 1],
    ]);
    expect(printed.split("\n").filter((line) => line.startsWith("tool error:"))).toEqual([
      "tool error: a run x7: a failed",
      "tool error: b run x6: b failed",
      "tool error: c run x5: c failed",
      "tool error: d run x4: d failed",
      "tool error: e run x3: e failed",
    ]);
  });

  test("ARK-T192 writes an empty list and no tool error line when no call failed", () => {
    installOmpCalls("clean", [{ tool: "bash", args: { command: "orca status" } }]);
    const printed = captureRetro();
    expect(readMetrics().orchestration.tool_error_list).toEqual([]);
    expect(printed).not.toContain("tool error:");
  });

  test("ARK-T192 gives word '' for a failed call whose command cannot be read, without throwing", () => {
    installOmpCalls("unreadable", [
      { tool: "bash", args: { command: 42 }, error: "bad command" },
      { tool: "bash", args: {}, error: "bad command" },
    ]);
    mkdirSync(join(codexRoot, "2026/10/29"), { recursive: true });
    writeFileSync(
      join(codexRoot, "2026/10/29/rollout-unreadable.jsonl"),
      [
        {
          timestamp: day("14:30:00.000"),
          type: "session_meta",
          payload: { id: "u", cwd: runDirectory },
        },
        {
          type: "response_item",
          payload: { type: "function_call", name: "shell", call_id: "u1", arguments: "{not json" },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "u1",
            output: JSON.stringify({ output: "boom", metadata: { exit_code: 1 } }),
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "shell",
            call_id: "u2",
            arguments: JSON.stringify({ command: ["git", "status"] }),
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "u2",
            output: JSON.stringify({ output: "not a repo", metadata: { exit_code: 128 } }),
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n"),
    );
    captureRetro();
    expect(readMetrics().orchestration.tool_error_list).toEqual([
      { tool: "bash", word: "", count: 2, first_error: "bad command" },
      { tool: "shell", word: "", count: 1, first_error: "boom" },
      { tool: "shell", word: "git", count: 1, first_error: "not a repo" },
    ]);
  });

  test("ARK-T183 attributes pre-evaluation usage and starts criteria wait at the blocker event", () => {
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
    expect(readMetrics().time.waiting_on_you_seconds).toBe(30);
  });

  test("ARK-T178 compares with the project's other closed runs that have metrics", () => {
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
      median_waiting_on_you_seconds: "unknown", // no earlier metrics file has the new field
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

  test("ARK-T174 reports wall time per run and step, split into waiting on you, working, waiting to merge and idle", () => {
    retro(runId);
    const { time } = readMetrics();
    expect(time.wall_seconds).toBe(2400);
    expect(time.by_step).toEqual({ build: 120, review: 1620 });
    // plan change 30s, plan approve 30s (each from a valid plan.checked), escalation 30s (from the failed review)
    expect(time.waiting_on_you_seconds).toBe(90);
    expect(time.working_seconds).toBe(1740);
    expect(time.waiting_to_merge_seconds).toBe(0);
    expect(time.idle_seconds).toBe(570);
  });

  test("ARK-T184 counts each plan wait from the first valid check after the previous answer", () => {
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
    expect(readMetrics().time.waiting_on_you_seconds).toBe(60);
  });

  test("ARK-T184 reports a plan wait of 3601 s for checks at T and T+3600 s and an answer at T+3601 s", () => {
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

    expect(readMetrics().time.waiting_on_you_seconds).toBe(3601);
  });

  test("ARK-T176 an escalation wait starts when the run enters phase escalation, not at an earlier failed step", () => {
    writeEvents(runDirectory, [
      [
        "14:00:00.000",
        "run.started",
        {
          run: runId,
          project: "demo",
          ticket: { id: "ARK-901" },
          criteria: ["ARK-901-AC1"],
          round_budget: 1,
        },
      ],
      ["14:00:00.000", "plan.checked", { valid: true, problems: [], plan_hash: "a", steps: [] }],
      ["14:00:00.000", "gate.answered", { gate: "plan", answer: "approve" }],
      [
        "14:10:00.000",
        "step.started",
        { step: "review", role: "reviewer", repo: "repos/shared", round: 1 },
      ],
      ["14:20:00.000", "step.finished", { step: "review", outcome: "failed" }],
      ["14:50:00.000", "test.completed", { passed: false, criteria: {}, heads: {} }],
      ["14:51:00.000", "gate.answered", { gate: "escalation", answer: "abort" }],
    ]);

    retro(runId);

    expect(readMetrics().time.waiting_on_you_seconds).toBe(60);
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

  test("ARK-T15 reports rework, plan changes and escaped defects linked to the run", () => {
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
      findings_dropped: 0,
      merge_steps: 0,
      rules_added: 0,
    });
    expect(metrics.human_intervention).toEqual({
      plan_changes: 1,
      mr_comments: 0,
      mr_commits_after_open: 0,
      mr_sync_commits: 0,
      mr_fix_commits: 0,
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

  test("ARK-T13 retro keeps fix and reviewer of an escaped defect, for caught, missed and downgraded", () => {
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

  test("ARK-T14 retro counts only P0 and P1 lines marked leave inside the Run lead decision section", () => {
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

  test("ARK-T406 retro counts the rule list lines of rules.md into rework.rules_added", () => {
    const rulesFile = join(runDirectory, "rules.md");
    writeFileSync(
      rulesFile,
      [
        "# Rules",
        "",
        "Written by the run lead when a finding repeats.",
        "",
        "- Check the unit on every export path (export drops the unit; csv export drops the unit; 2026-11-14T10:00:00Z)",
        "- Never read ARK_HOME at import time (config read at import; path read at import; 2026-11-14T11:00:00Z)",
        "",
      ].join("\n"),
    );
    expect(runRetroProcess().exitCode).toBe(0);
    expect(readMetrics().rework).toMatchObject({
      rules_added: 2,
      findings_dropped: 0,
      findings_sent_back: 0,
    });

    rmSync(rulesFile);
    expect(runRetroProcess().exitCode).toBe(0);
    expect(readMetrics().rework.rules_added).toBe(0);
  });

  test("ARK-T392 retro counts only the dropped lines under Run lead decision into findings_dropped", () => {
    const findings = join(runDirectory, "findings");
    mkdirSync(findings, { recursive: true });
    writeFileSync(
      join(findings, "reviewer.md"),
      [
        "### P2: slow export",
        "",
        "- **Evidence:** the reviewer dropped the unit",
        "",
        "## Run lead decision",
        "",
        "- dropped might be slow: no Line and no Input",
        "- dropped cleanup helper: no File",
        "- P1 export drops the unit: send back, the Repro fails",
        "",
        "## Notes",
        "",
        "- dropped in the notes, not a decision",
        "",
      ].join("\n"),
    );
    writeFileSync(join(findings, "round-1.md"), "- dropped by hand: not a decision\n");
    expect(runRetroProcess().exitCode).toBe(0);
    expect(readMetrics().rework).toMatchObject({
      findings_dropped: 2,
      findings_left_p0p1: 0,
      findings_sent_back: 0,
    });

    writeFileSync(
      join(findings, "second.md"),
      [
        "## Run lead decision",
        "",
        "- **dropped bold title: no Input**",
        "* Dropped star title: no File",
        "Dropped the vague ones since they lacked Input.",
        "",
      ].join("\n"),
    );
    expect(runRetroProcess().exitCode).toBe(0);
    expect(readMetrics().rework).toMatchObject({
      findings_dropped: 4,
      findings_left_p0p1: 0,
      findings_sent_back: 0,
    });

    rmSync(findings, { recursive: true });
    expect(runRetroProcess().exitCode).toBe(0);
    expect(readMetrics().rework.findings_dropped).toBe(0);
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
    const originalCwd = process.cwd();
    const before = day("14:40:00.000");
    const after = day("14:58:00.000");

    type GithubCommit = {
      sha: string;
      parents: string[];
      date: string;
      message: string;
    };
    type GitlabCommit = {
      id: string;
      parent_ids: string[];
      committed_date: string;
      title: string;
    };
    type Forges = {
      github?: GithubCommit[];
      gitlab?: GitlabCommit[];
      failing?: boolean;
      /** Extra commits in the base history, as after the MR merged: its side branches are in it. */
      mergedHistory?: string[];
      /** Every page of comments and notes is full, so the 1000-item cap hides further items. */
      fullPages?: boolean;
    };

    const github = (sha: string, parents: string[], date: string, message = "work") => ({
      sha,
      parents,
      date,
      message,
    });
    const gitlab = (id: string, parent_ids: string[], committed_date: string, title = "work") => ({
      id,
      parent_ids,
      committed_date,
      title,
    });

    const githubUrl = "https://github.com/acme/web/pull/7";
    const gitlabUrl = "https://gitlab.com/acme/api/-/merge_requests/9";

    // The run worktree folder is never created: `ark run close` deletes it before retro runs.
    function writeMergeRequestRun(forges: Forges): void {
      const rows: EventRow[] = scenario.slice(0, -1);
      if (forges.github)
        rows.push([
          "14:56:30.000",
          "merge_request.opened",
          { repo: "repos/web", url: githubUrl, number: 7 },
        ]);
      if (forges.gitlab)
        rows.push([
          "14:56:30.000",
          "merge_request.opened",
          { repo: "repos/api", url: gitlabUrl, number: 9 },
        ]);
      writeEvents(runDirectory, [...rows, scenario[scenario.length - 1]]);
    }

    /** Fake gh and glab: each answers only a call that names the MR by its URL-derived path. */
    function installForges(forges: Forges): string {
      const binDirectory = mkdtempSync(join(tmpdir(), "ark-fake-forges-"));
      const data = JSON.stringify({
        github: forges.github ?? [],
        gitlab: forges.gitlab ?? [],
        failing: forges.failing === true,
        mergedHistory: forges.mergedHistory ?? [],
        fullPages: forges.fullPages === true,
      });
      const common = `#!/usr/bin/env bun
const data = ${data};
const callArguments = process.argv.slice(2);
const reject = () => process.exit(1);
if (data.failing) reject();
const answer = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
const endpoint = callArguments[0] === "api" ? callArguments.slice(1).find((candidate) => !candidate.startsWith("-")) ?? "" : "";
const [path, query = ""] = endpoint.split("?");
const page = Number(/(?:^|&)page=(\\d+)/.exec(query)?.[1] ?? 1);
if (data.fullPages && (path.endsWith("/comments") || path.endsWith("/notes")))
  answer(Array.from({ length: 100 }, () => ({ system: false })));
if (page > 1) answer([]);
`;
      const gh = `${common}
const history = [{ sha: "aaa111" }, { sha: "aaa222" }, { sha: "aaa333" }, ...data.mergedHistory.map((sha) => ({ sha }))];
const reviews = [{ body: "please change" }, { body: "" }];
if (callArguments[0] === "pr" && callArguments[1] === "view") {
  if (callArguments[2] !== ${JSON.stringify(githubUrl)}) reject();
  answer({
    baseRefName: "main",
    comments: [{}, {}],
    reviews,
    commits: data.github.map((commit) => ({ oid: commit.sha, messageHeadline: commit.message, committedDate: commit.date })),
  });
}
if (callArguments[0] !== "api") reject();
if (path === "repos/acme/web/pulls/7") answer({ base: { ref: "main" }, number: 7 });
if (path === "repos/acme/web/pulls/7/commits")
  answer(data.github.map((commit) => ({
    sha: commit.sha,
    commit: { message: commit.message, committer: { date: commit.date } },
    parents: commit.parents.map((sha) => ({ sha })),
  })));
if (path === "repos/acme/web/issues/7/comments") answer([{}, {}]);
if (path === "repos/acme/web/pulls/7/reviews") answer(reviews);
if (path === "repos/acme/web/pulls/7/comments") answer([]);
if (path === "repos/acme/web/commits" && /(?:^|&)sha=main(?:&|$)/.test(query)) answer(history);
reject();
`;
      const glab = `${common}
const hostIndex = callArguments.indexOf("--hostname");
const host = hostIndex >= 0 ? callArguments[hostIndex + 1] : process.env.GITLAB_HOST;
if (!host || !host.includes("gitlab.com")) reject();
if (callArguments[0] !== "api") reject();
const history = [{ id: "aaa111" }, { id: "aaa222" }, { id: "aaa333" }, ...data.mergedHistory.map((id) => ({ id }))];
const base = "projects/acme%2Fapi";
if (path === base + "/merge_requests/9") answer({ target_branch: "main" });
if (path === base + "/merge_requests/9/notes")
  answer([{ system: false }, { system: false }, { system: true }]);
if (path === base + "/merge_requests/9/commits") answer(data.gitlab);
if (path === base + "/repository/commits" && /(?:^|&)ref_name=main(?:&|$)/.test(query)) answer(history);
reject();
`;
      writeFileSync(join(binDirectory, "gh"), gh);
      writeFileSync(join(binDirectory, "glab"), glab);
      chmodSync(join(binDirectory, "gh"), 0o755);
      chmodSync(join(binDirectory, "glab"), 0o755);
      return binDirectory;
    }

    /** Runs retro from a folder that is not the run worktree, with the fake forges first in PATH. */
    function retroWithForges(forges: Forges): void {
      writeMergeRequestRun(forges);
      const binDirectory = installForges(forges);
      const elsewhere = mkdtempSync(join(tmpdir(), "ark-elsewhere-"));
      process.env.PATH = `${binDirectory}:${originalPath}`;
      process.chdir(elsewhere);
      try {
        retro(runId);
      } finally {
        process.chdir(originalCwd);
        process.env.PATH = originalPath;
      }
    }

    test("ARK-T251 counts MR comments and commits after open by MR URL, with no run worktree and from another folder", () => {
      retroWithForges({
        github: [
          github("g0", ["g00"], before),
          github("g1", ["g0", "aaa222"], after, "bring in latest"),
          github("g3", ["g1"], after),
        ],
        gitlab: [
          gitlab("l0", ["l00"], before),
          gitlab("l1", ["l0", "aaa333"], after),
          gitlab("l2", ["l1"], after),
          gitlab("l3", ["l2"], after),
        ],
      });
      // 2 comments + 1 review body on GitHub, 2 non-system notes on GitLab; 2 + 3 commits after open.
      expect(readMetrics().human_intervention).toMatchObject({
        mr_comments: 5,
        mr_commits_after_open: 5,
      });
    });

    test("ARK-T251 reports every MR number as unknown when gh or glab cannot answer", () => {
      retroWithForges({
        github: [github("g0", ["g00"], after)],
        gitlab: [gitlab("l0", ["l00"], after)],
        failing: true,
      });
      expect(readMetrics().human_intervention).toMatchObject({
        mr_comments: "unknown",
        mr_commits_after_open: "unknown",
        mr_sync_commits: "unknown",
        mr_fix_commits: "unknown",
      });
    });

    test("ARK-T252 lists merges from the base branch as sync commits and every other commit after open as fix commits", () => {
      retroWithForges({
        github: [
          github("g0", ["g00"], before),
          github("g1", ["g0", "aaa222"], after, "bring in latest"),
          github("g2", ["g1", "bbb111"], after, "Merge feature/x"),
          github("g3", ["g2"], after),
          github("g4", ["g3"], after),
        ],
        gitlab: [
          gitlab("l0", ["l00"], before),
          gitlab("l1", ["l0", "aaa333"], after, "Merge branch 'main' into topic"),
          gitlab("l2", ["l1"], after),
          gitlab("l3", ["l2", "ccc111"], after, "Merge branch 'main' into topic"),
        ],
      });
      expect(readMetrics().human_intervention).toMatchObject({
        mr_sync_commits: 2,
        mr_fix_commits: 5,
        mr_commits_after_open: 7,
      });
    });

    test("ARK-T252 counts no fix commits when every commit after open is a merge from the base branch", () => {
      retroWithForges({
        github: [
          github("g0", ["g00"], before),
          github("g1", ["g0", "aaa111"], after),
          github("g2", ["g1", "aaa222"], after),
        ],
      });
      expect(readMetrics().human_intervention).toMatchObject({
        mr_sync_commits: 2,
        mr_fix_commits: 0,
        mr_commits_after_open: 2,
      });
    });

    test("ARK-T252 counts a merged side branch of the MR as a fix commit, not a sync commit", () => {
      retroWithForges({
        github: [
          github("g0", ["g00"], before),
          github("gside", ["g0"], after),
          github("g1", ["g0", "gside"], after, "Merge feature/x"),
          github("g2", ["g1", "aaa222"], after, "Merge main"),
        ],
        gitlab: [
          gitlab("l0", ["l00"], before),
          gitlab("lside", ["l0"], after),
          gitlab("l1", ["l0", "lside"], after, "Merge branch 'feature/x'"),
          gitlab("l2", ["l1", "aaa333"], after, "Merge branch 'main'"),
        ],
        mergedHistory: ["gside", "lside"],
      });
      expect(readMetrics().human_intervention).toMatchObject({
        mr_sync_commits: 2,
        mr_fix_commits: 4,
        mr_commits_after_open: 6,
      });
    });

    test("ARK-T251 reports every MR number as unknown when a list hits the page cap", () => {
      retroWithForges({
        github: [github("g0", ["g00"], after)],
        gitlab: [gitlab("l0", ["l00"], after)],
        fullPages: true,
      });
      expect(readMetrics().human_intervention).toMatchObject({
        mr_comments: "unknown",
        mr_commits_after_open: "unknown",
        mr_sync_commits: "unknown",
        mr_fix_commits: "unknown",
      });
    });
  });

  test("ARK-T195 reports tool errors, context overflows, idle gaps, crashes, restarts and the cost of the run lead", () => {
    installAllSessions();
    retro(runId);
    expect(readMetrics().orchestration).toEqual({
      sessions: 3,
      restarts: 0,
      crashes: 1,
      stalled_workers: 0,
      dead_dispatches: 0,
      tool_errors: 2,
      tool_error_list: [{ tool: "unknown", word: "", count: 2, first_error: "" }],
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

  test("ARK-T185 counts the wait from manual pending to the manual answer as gate wait, not work time (600 s)", () => {
    writeEvents(runDirectory, [
      started,
      testRun("14:10:00.000", { "ARK-901-AC1": "manual pending" }),
      manualAnswer("14:20:00.000", "ARK-901-AC1"),
      ["14:30:00.000", "run.closed", { outcome: "aborted" }],
    ]);
    retro(runId);
    const { time } = readMetrics();
    expect(time.waiting_on_you_seconds).toBe(600);
    expect(time.working_seconds + time.waiting_to_merge_seconds + time.idle_seconds).toBe(1200);
    expect(time.wall_seconds).toBe(1800);
  });

  test("ARK-T185 the wait starts at the first manual pending, not at a repeated one", () => {
    writeEvents(runDirectory, [
      started,
      testRun("14:10:00.000", { "ARK-901-AC1": "manual pending" }),
      testRun("14:15:00.000", { "ARK-901-AC1": "manual pending" }),
      manualAnswer("14:20:00.000", "ARK-901-AC1"),
      ["14:30:00.000", "run.closed", { outcome: "aborted" }],
    ]);
    retro(runId);
    expect(readMetrics().time.waiting_on_you_seconds).toBe(600);
  });

  test("ARK-T185 a problem answer closes the wait and a later manual pending opens a new one", () => {
    writeEvents(runDirectory, [
      started,
      testRun("14:10:00.000", { "ARK-901-AC1": "manual pending" }),
      manualAnswer("14:12:00.000", "ARK-901-AC1", "problem"),
      testRun("14:20:00.000", { "ARK-901-AC1": "manual pending" }),
      manualAnswer("14:21:00.000", "ARK-901-AC1"),
      ["14:30:00.000", "run.closed", { outcome: "aborted" }],
    ]);
    retro(runId);
    expect(readMetrics().time.waiting_on_you_seconds).toBe(180);
  });

  test("ARK-T185 two manual criteria keep separate waits but count elapsed time once", () => {
    writeEvents(runDirectory, [
      started,
      testRun("14:10:00.000", { "ARK-901-AC1": "manual pending", "ARK-901-AC2": "manual pending" }),
      manualAnswer("14:11:00.000", "ARK-901-AC1"),
      manualAnswer("14:15:00.000", "ARK-901-AC2"),
      ["14:30:00.000", "run.closed", { outcome: "aborted" }],
    ]);
    retro(runId);
    // AC1 waits 60 s inside AC2's 300 s; an answer for AC1 must not close AC2, and the union is 300 s.
    expect(readMetrics().time.waiting_on_you_seconds).toBe(300);
  });

  test("ARK-T185 overlapping manual waits leave no idle time when they span the whole run", () => {
    writeEvents(runDirectory, [
      started,
      testRun("14:00:00.000", { "ARK-901-AC1": "manual pending", "ARK-901-AC2": "manual pending" }),
      manualAnswer("14:10:00.000", "ARK-901-AC1"),
      manualAnswer("14:10:00.000", "ARK-901-AC2"),
      ["14:10:00.000", "run.closed", { outcome: "aborted" }],
    ]);
    retro(runId);
    const time = readMetrics().time;
    expect(time.waiting_on_you_seconds).toBeLessThanOrEqual(time.wall_seconds);
    expect(time.idle_seconds).toBe(0);
  });

  test("ARK-T185 a manual pending still open at close counts as waiting on you up to the close", () => {
    writeEvents(runDirectory, [
      started,
      testRun("14:10:00.000", { "ARK-901-AC1": "manual pending" }),
      ["14:30:00.000", "run.closed", { outcome: "aborted" }],
    ]);
    retro(runId);
    expect(readMetrics().time.waiting_on_you_seconds).toBe(1200);
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

  /**
   * The review step runs in repos/platform. One file per step (ARK-348): the build session and the
   * review session each start inside their own step window. `main` is the review's own session model,
   * `sub` adds a second review file on another model, `helperModel` adds a helper call (purpose) to it.
   */
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

  test("ARK-T66 same vendor review is true when every model of the review step shares the implementer vendor", () => {
    reviewOnModels("claude-opus-5-5", "claude-sonnet-5");
    const out = runRetro();
    expect(readMetrics().same_vendor_review).toBe(true);
    expect(out).toContain("same vendor review: true (review with build in repos/platform)");
    expect(out).not.toContain("mixed");
  });

  test("ARK-T66 same vendor review is false and nothing is mixed when the review step ran on another vendor", () => {
    reviewOnModels("gpt-6.1-sol");
    const out = runRetro();
    expect(readMetrics().same_vendor_review).toBe(false);
    expect(out).toContain("same vendor review: false");
    expect(out).not.toContain("mixed");
  });

  test("ARK-348/AC2 ARK-T66 a validator on the implementer's vendor does not set same vendor review", () => {
    reviewOnModels("claude-opus-5-5");
    writeEvents(
      runDirectory,
      scenario.map(([time, type, data]): EventRow => [
        time,
        type,
        data.step === "review" ? { ...data, repo: "repos/platform", role: "validator" } : data,
      ]),
    );
    const out = runRetro();
    expect(readMetrics().same_vendor_review).toBe(false);
    expect(out).toContain("same vendor review: false");
  });

  test("ARK-T66 a review step with a codex model and an anthropic sub-session is mixed, not same vendor", () => {
    reviewOnModels("gpt-6.1-sol", "claude-opus-5-5");
    const out = runRetro();
    expect(readMetrics().same_vendor_review).toBe(false);
    expect(out).toContain("same vendor review: false");
    const mixedLine = out.split("\n").find((line) => line.includes("mixed"));
    expect(mixedLine).toBeDefined();
    expect(mixedLine).toContain("review");
  });

  test("ARK-T66 a helper call with a purpose field and another vendor does not make the review step mixed or changed", () => {
    reviewOnModels("claude-opus-5-5", undefined, "gpt-6-luna");
    const out = runRetro();
    expect(readMetrics().same_vendor_review).toBe(true);
    expect(out).toContain("same vendor review: true");
    expect(out).not.toContain("mixed");
    expect(out).not.toContain("gpt-6-luna");
  });

  // ARK-348: session files go whole to one owner. Every step and the run lead share the worktree "workspace".
  const sharedScenario: EventRow[] = scenario.map(([time, type, data]): EventRow => [
    time,
    type,
    data.repo ? { ...data, repo: "." } : data,
  ]);

  type SessionReply = {
    time: string;
    provider: string;
    model: string;
    costUsd: number;
    purpose?: string;
  };

  /**
   * One omp session file in the run's worktree: a session head at `start`, then one record per
   * reply. `prompt` records follow the head (before the first reply, as a real omp head holds
   * them); `after` records follow the last reply.
   */
  function writeOwnedSession(
    name: string,
    start: string,
    replies: SessionReply[],
    options: { prompt?: Record<string, unknown>[]; after?: Record<string, unknown>[] } = {},
  ): void {
    const head = {
      type: "session",
      version: 3,
      id: name,
      timestamp: day(start),
      cwd: join(runDirectory, "workspace"),
    };
    const records = replies.map((reply) => {
      const usage = {
        input: 10,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { total: reply.costUsd },
      };
      return reply.purpose === undefined
        ? {
            type: "message",
            timestamp: day(reply.time),
            message: {
              role: "assistant",
              provider: reply.provider,
              model: reply.model,
              content: [],
              usage,
            },
          }
        : {
            type: "model_usage",
            timestamp: day(reply.time),
            purpose: reply.purpose,
            provider: reply.provider,
            model: reply.model,
            usage,
          };
    });
    mkdirSync(join(ompRoot, "workspace"), { recursive: true });
    writeFileSync(
      join(ompRoot, "workspace", `${name}.jsonl`),
      `${[head, ...(options.prompt ?? []), ...records, ...(options.after ?? [])].map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
  }

  const anthropicReply = (
    time: string,
    costUsd: number,
    model = "claude-sonnet-5-5",
  ): SessionReply => ({
    time,
    provider: "anthropic",
    model,
    costUsd,
  });
  const openAiReply = (time: string, costUsd: number): SessionReply => ({
    time,
    provider: "openai-codex",
    model: "gpt-6.1-sol",
    costUsd,
  });

  /** The run lead starts before the first step and replies inside both step windows. */
  const writeRunLead = () =>
    writeOwnedSession("lead", "14:21:00.000", [
      anthropicReply("14:24:30.000", 0.5),
      anthropicReply("14:30:00.000", 0.5),
      anthropicReply("14:40:00.000", 0.5),
    ]);
  const writeImplementer = () =>
    writeOwnedSession("implementer", "14:24:10.000", [
      anthropicReply("14:24:20.000", 0.02, "claude-haiku-4-5"),
    ]);

  // The older event form: every start also records a worker.started with no usable session file.
  const unknownSessionScenario: EventRow[] = sharedScenario.flatMap((row): EventRow[] =>
    row[1] === "step.started"
      ? [
          row,
          [
            row[0],
            "worker.started",
            {
              step: row[2].step,
              dispatch: "ctx_1",
              terminal: "term_1",
              harness: "omp",
              session: "unknown",
            },
          ],
        ]
      : [row],
  );
  test.each([
    ["no worker.started event", sharedScenario],
    ["worker.started session unknown", unknownSessionScenario],
  ])(
    "ARK-T65 a run lead that overlaps the reviewer window stays out of the reviewer, and an unassigned file is its own cost line (%s)",
    (_form, rows) => {
      writeEvents(runDirectory, rows);
      writeRunLead();
      writeImplementer();
      writeOwnedSession("reviewer", "14:28:30.000", [
        openAiReply("14:29:00.000", 0.05),
        openAiReply("14:35:00.000", 0.05),
      ]);
      // Starts in the gap between the build and review windows: no step owns it.
      writeOwnedSession("unassigned", "14:27:00.000", [openAiReply("14:27:30.000", 0.09)]);

      const out = runRetro();
      const metrics = readMetrics();
      expect(metrics.actual_models.review).toEqual(["gpt-6.1-sol"]);
      expect(metrics.actual_models.build).toEqual(["claude-haiku-4-5"]);
      expect(metrics.cost.by_step.review.usd).toBeCloseTo(0.1, 6);
      expect(metrics.cost.by_step.build.usd).toBeCloseTo(0.02, 6);
      expect(metrics.cost.by_step.unassigned.usd).toBeCloseTo(0.09, 6);
      expect(metrics.cost.by_step.orchestration.usd).toBeCloseTo(1.5, 6);
      expect(metrics.cost.total_usd).toBeCloseTo(1.71, 6);
      expect(Object.keys(metrics.cost.by_role).sort()).toEqual([
        "implementer",
        "orchestration",
        "reviewer",
        "unassigned",
      ]);
      expect(metrics.cost.by_role.unassigned.usd).toBeCloseTo(0.09, 6);
      expect(metrics.cost.by_role.orchestration.usd).toBeCloseTo(1.5, 6);
      expect(out).toContain("unassigned: 1 file, $0.09");
      expect(out).toContain("unassigned.jsonl");
    },
  );

  // The current start path records step.started after the worker launched: its file starts before the step.
  test.each([
    ["A: no other file", false],
    ["B: an earlier unrecorded file", true],
  ])(
    "ARK-T309 a worker file recorded by worker.started that starts before the first step goes to its step, never to the run lead (%s)",
    (_variant, withLead) => {
      const file = join(ompRoot, "workspace", "worker.jsonl");
      writeEvents(
        runDirectory,
        sharedScenario.flatMap((row): EventRow[] =>
          row[1] === "step.started" && row[2].step === "build"
            ? [
                row,
                [
                  row[0],
                  "worker.started",
                  {
                    step: "build",
                    dispatch: "ctx_1",
                    terminal: "term_1",
                    harness: "omp",
                    session: file,
                  },
                ],
              ]
            : [row],
        ),
      );
      if (withLead)
        writeOwnedSession("lead", "14:21:00.000", [anthropicReply("14:30:00.000", 0.5)]);
      writeOwnedSession("worker", "14:23:30.000", [
        anthropicReply("14:24:20.000", 0.02, "claude-haiku-4-5"),
      ]);

      const out = runRetro();
      const { by_step: steps } = readMetrics().cost;
      expect(steps.build.usd).toBeCloseTo(0.02, 6);
      expect(steps.unassigned).toBeUndefined();
      expect(out).not.toContain("unassigned:");
      expect(steps.orchestration?.usd ?? 0).toBeCloseTo(withLead ? 0.5 : 0, 6);
    },
  );

  // ARK-460: a session is placed by the worker spec line of this run, which sits in its prompt records.
  const arkSkillText = [
    '[IMPORTANT: User invoked the "ark" skill; follow its instructions. Full skill below.]',
    "description: Entry point for Ark. Use `/skill:ark worker <run> <step>` to start a worker.",
    "|`worker`|`<run> <step>`|`playbooks/worker.md`|A run lead starts it, one per step.|",
  ].join("\n");

  /** The omp `skill-prompt` record of a started session: the skill text with its placeholder rows, then the task. */
  function skillPromptRecord(task: string, laterText = ""): Record<string, unknown> {
    return {
      type: "custom_message",
      customType: "skill-prompt",
      content: `${arkSkillText}\n\n---\n\n=== TASK === ${task}\nYou are working inside Orca.\n${laterText}`,
      details: {
        name: "ark",
        path: "/plugins/ark/skills/ark/SKILL.md",
        args: `=== TASK === ${task}`,
        prompt: `=== TASK ===\n/skill:ark ${task}`,
        lineCount: 40,
      },
      display: true,
      attribution: "user",
    };
  }
  const workerPrompt = (word: string, run = runId) => [skillPromptRecord(`worker ${run} ${word}`)];
  const runLeadPrompt = () => [skillPromptRecord(`run-lead ${runId}`)];

  /** What the run lead writes after its first reply when it starts a worker by hand. */
  const workerStartCall = (word: string): Record<string, unknown>[] => [
    {
      type: "message",
      timestamp: day("14:22:30.000"),
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        content: [
          {
            type: "toolCall",
            id: "call_1",
            name: "bash",
            arguments: {
              command: `orca orchestration worker-start --from lead --spec "=== TASK === worker ${runId} ${word}\\nYou are the worker"`,
            },
          },
        ],
        usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
      },
    },
    {
      type: "message",
      timestamp: day("14:22:31.000"),
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        content: [{ type: "text", text: "started" }],
      },
    },
  ];

  /** Events of a run whose steps all work in the run worktree; `sessionFiles` adds a worker.started per step id. */
  const placementRows = (
    steps: [id: string, role: string, start: string, end: string][],
    sessionFiles: Record<string, string> = {},
  ): EventRow[] => [
    [
      "14:20:00.000",
      "run.started",
      {
        run: runId,
        project: "demo",
        ticket: { id: "ARK-901", title: "t" },
        criteria: [],
        round_budget: 1,
      },
    ],
    ...steps.flatMap(([id, role, start, end]): EventRow[] => [
      [start, "step.started", { step: id, role, repo: ".", round: 1 }],
      ...(sessionFiles[id]
        ? [
            [
              start,
              "worker.started",
              {
                step: id,
                dispatch: "ctx_1",
                terminal: "term_1",
                harness: "omp",
                session: sessionFiles[id],
              },
            ] as EventRow,
          ]
        : []),
      [end, "step.finished", { step: id, outcome: "succeeded" }],
    ]),
    ["15:00:00.000", "run.closed", { outcome: "aborted" }],
  ];

  const rolesTotal = (roles: Record<string, { usd: number }>) =>
    Object.values(roles).reduce((sum, group) => sum + group.usd, 0);

  test.each([
    ["run lead first, writer second", "14:22:00.000", false],
    ["writer first: the earliest lead candidate", "14:20:30.000", false],
    [
      "run lead names the writer in a worker-start call after its first reply",
      "14:22:00.000",
      true,
    ],
  ])(
    "ARK-T376 ark retro gives the run lead, the test case writer, the test case reviewer and the implementer each its own role, with nothing unassigned and the roles adding up to the total (%s)",
    (_form, writerStart, leadStartsWriter) => {
      const implementerFile = join(ompRoot, "workspace", "implementer.jsonl");
      writeEvents(
        runDirectory,
        placementRows([["build", "implementer", "14:24:00.000", "14:25:00.000"]], {
          build: implementerFile,
        }),
      );
      writeOwnedSession("lead", "14:21:00.000", [anthropicReply("14:21:30.000", 1)], {
        prompt: runLeadPrompt(),
        after: leadStartsWriter ? workerStartCall("test-case-writer") : [],
      });
      writeOwnedSession("writer", writerStart, [anthropicReply("14:22:30.000", 0.2)], {
        prompt: workerPrompt("test-case-writer"),
      });
      writeOwnedSession(
        "reviewer",
        "14:23:00.000",
        [anthropicReply("14:23:30.000", 0.3, "claude-opus-5-5")],
        { prompt: workerPrompt("test-case-reviewer") },
      );
      writeOwnedSession(
        "implementer",
        "14:24:10.000",
        [anthropicReply("14:24:20.000", 0.04, "claude-haiku-4-5")],
        { prompt: workerPrompt("build") },
      );

      const out = runRetro();
      const metrics = readMetrics();
      const { by_role: roles, by_step: steps } = metrics.cost;
      expect(roles.orchestration.usd).toBeCloseTo(1, 6);
      expect(roles.test_writer.usd).toBeCloseTo(0.2, 6);
      expect(roles.test_reviewer.usd).toBeCloseTo(0.3, 6);
      expect(roles.implementer.usd).toBeCloseTo(0.04, 6);
      expect(metrics.orchestration.master_chief_and_run_lead_cost.usd).toBeCloseTo(1, 6);
      expect(roles.unassigned).toBeUndefined();
      expect(steps.unassigned).toBeUndefined();
      expect(steps.orchestration.usd).toBeCloseTo(1.5, 6);
      expect(steps.build.usd).toBeCloseTo(0.04, 6);
      expect(rolesTotal(roles)).toBeCloseTo(metrics.cost.total_usd, 6);
      expect(out).not.toContain("unassigned:");
    },
  );

  // Timeline of ARK-T377: build 14:24-14:30, check 14:34-14:36. Every file below starts in the run worktree.
  const placementScenario = () =>
    placementRows([
      ["build", "implementer", "14:24:00.000", "14:30:00.000"],
      ["check", "validator", "14:34:00.000", "14:36:00.000"],
    ]);
  /** The run lead and the implementer session, which the window rule places by itself. */
  const writeLeadAndImplementer = () => {
    writeOwnedSession("lead", "14:21:00.000", [anthropicReply("14:25:00.000", 1)], {
      prompt: runLeadPrompt(),
    });
    writeOwnedSession(
      "implementer",
      "14:24:30.000",
      [anthropicReply("14:25:30.000", 0.04, "claude-haiku-4-5")],
      { prompt: workerPrompt("build") },
    );
  };
  const validatorReply = anthropicReply("14:31:30.000", 0.3, "claude-opus-5-5");

  test("ARK-T377 ark retro places a session by the worker spec line of this run: a validator before its window goes to its step, a test case writer inside a window does not, a placeholder or another run id places nothing", () => {
    writeEvents(runDirectory, placementScenario());
    writeLeadAndImplementer();
    writeOwnedSession("validator", "14:31:00.000", [validatorReply], {
      prompt: workerPrompt("check"),
    });
    writeOwnedSession("writer", "14:25:00.000", [anthropicReply("14:26:00.000", 0.2)], {
      prompt: workerPrompt("test-case-writer"),
    });
    // Only placeholders: the skill text of a run lead head plus the run lead playbook lines.
    writeOwnedSession("placeholder", "14:32:00.000", [anthropicReply("14:32:30.000", 0.05)], {
      prompt: [
        skillPromptRecord(
          `run-lead ${runId}`,
          "/skill:ark worker <run> check\n<run> test-case-writer\n",
        ),
      ],
    });
    writeOwnedSession("otherrun", "14:32:30.000", [anthropicReply("14:32:45.000", 0.07)], {
      prompt: workerPrompt("check", "2026-10-29-ARK-999-1"),
    });
    // The id of this run followed by a digit: the match stops at the end of the id.
    writeOwnedSession("prefixrun", "14:33:00.000", [anthropicReply("14:33:30.000", 0.09)], {
      prompt: workerPrompt("check", `${runId}0`),
    });

    const out = runRetro();
    const metrics = readMetrics();
    const { by_role: roles, by_step: steps } = metrics.cost;
    expect(steps.check.usd).toBeCloseTo(0.3, 6);
    expect(roles.validator.usd).toBeCloseTo(0.3, 6);
    expect(metrics.actual_models.check).toEqual(["claude-opus-5-5"]);
    expect(roles.test_writer.usd).toBeCloseTo(0.2, 6);
    expect(steps.orchestration.usd).toBeCloseTo(1.2, 6);
    expect(steps.build.usd).toBeCloseTo(0.04, 6);
    expect(roles.implementer.usd).toBeCloseTo(0.04, 6);
    expect(metrics.actual_models.build).toEqual(["claude-haiku-4-5"]);
    expect(roles.orchestration.usd).toBeCloseTo(1, 6);
    expect(roles.unassigned.usd).toBeCloseTo(0.21, 6);
    expect(steps.unassigned.usd).toBeCloseTo(0.21, 6);
    expect(rolesTotal(roles)).toBeCloseTo(metrics.cost.total_usd, 6);
    expect(out).toContain("unassigned: 3 files");
    for (const name of ["placeholder.jsonl", "otherrun.jsonl", "prefixrun.jsonl"])
      expect(out).toContain(name);
  });

  test("ARK-T377 a step id that starts with another step id takes only its own spec line, and a step that never started places nothing", () => {
    writeEvents(
      runDirectory,
      placementRows([
        ["build", "implementer", "14:24:00.000", "14:25:00.000"],
        ["check", "validator", "14:28:00.000", "14:29:00.000"],
        ["check-2", "validator", "14:31:00.000", "14:32:00.000"],
      ]),
    );
    writePlan([
      ["build", "implementer", ".", "anthropic/claude-sonnet-5-5"],
      ["check", "validator", ".", "anthropic/claude-sonnet-5-5"],
      ["check-2", "validator", ".", "anthropic/claude-sonnet-5-5"],
      ["later", "validator", ".", "anthropic/claude-sonnet-5-5"],
    ]);
    writeOwnedSession("lead", "14:21:00.000", [anthropicReply("14:25:00.000", 1)], {
      prompt: runLeadPrompt(),
    });
    writeOwnedSession("implementer", "14:24:30.000", [anthropicReply("14:24:40.000", 0.04)], {
      prompt: workerPrompt("build"),
    });
    writeOwnedSession("first", "14:26:00.000", [anthropicReply("14:26:30.000", 0.3)], {
      prompt: workerPrompt("check"),
    });
    writeOwnedSession("second", "14:30:00.000", [anthropicReply("14:30:30.000", 0.5)], {
      prompt: workerPrompt("check-2"),
    });
    writeOwnedSession("ghost", "14:33:00.000", [anthropicReply("14:33:30.000", 0.07)], {
      prompt: workerPrompt("later"),
    });

    const out = runRetro();
    const { by_step: steps, by_role: roles } = readMetrics().cost;
    expect(steps.check.usd).toBeCloseTo(0.3, 6);
    expect(steps["check-2"].usd).toBeCloseTo(0.5, 6);
    expect(roles.validator.usd).toBeCloseTo(0.8, 6);
    expect(steps.later).toBeUndefined();
    expect(steps.unassigned.usd).toBeCloseTo(0.07, 6);
    expect(roles.unassigned.usd).toBeCloseTo(0.07, 6);
    expect(out).toContain("unassigned: 1 file");
    expect(out).toContain("ghost.jsonl");
  });

  test("ARK-T377 a Codex .zst session whose prompt follows injected context records is placed by its spec line", () => {
    writeEvents(runDirectory, placementScenario());
    writeLeadAndImplementer();
    const record = (time: string, type: string, payload: Record<string, unknown>) => ({
      timestamp: day(time),
      type,
      payload,
    });
    const message = (role: string, text: string) =>
      record("14:31:00.500", "response_item", {
        type: "message",
        role,
        content: [{ type: role === "user" ? "input_text" : "output_text", text }],
      });
    const rollout = [
      record("14:31:00.000", "session_meta", {
        id: "validator",
        cwd: join(runDirectory, "workspace"),
        model_provider: "openai",
      }),
      record("14:31:00.100", "turn_context", {
        cwd: join(runDirectory, "workspace"),
        model: "gpt-6.1-sol",
      }),
      message("user", "<recommended_plugins>\n- github\n</recommended_plugins>"),
      message(
        "user",
        `<environment_context>\n  <cwd>${join(runDirectory, "workspace")}</cwd>\n</environment_context>`,
      ),
      message(
        "user",
        `${arkSkillText}\n\n=== TASK === worker ${runId} check\nYou are the VALIDATOR.`,
      ),
      message("assistant", "Reading the plan."),
      record("14:31:30.000", "event_msg", {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: 30 },
          last_token_usage: { input_tokens: 20, output_tokens: 10 },
        },
      }),
    ];
    const folder = join(codexRoot, "2026", "10", "29");
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "rollout-2026-10-29T14-31-00-validator.jsonl.zst"),
      Bun.zstdCompressSync(
        Buffer.from(`${rollout.map((line) => JSON.stringify(line)).join("\n")}\n`),
      ),
    );

    const out = runRetro();
    const metrics = readMetrics();
    expect(metrics.actual_models.check).toEqual(["gpt-6.1-sol"]);
    expect(metrics.cost.by_step.check.tokens).toBe(30);
    expect(metrics.cost.by_role.validator.tokens).toBe(30);
    expect(metrics.cost.by_step.unassigned).toBeUndefined();
    expect(metrics.cost.by_role.unassigned).toBeUndefined();
    expect(out).not.toContain("unassigned:");
  });

  test.each([
    ["one file", false],
    ["two files: a later file does not take the lead slot", true],
  ])(
    "ARK-T378 ark retro keeps a session that nothing places as unassigned, apart from the run lead, and names its file in the output (%s)",
    (_form, withSecondFile) => {
      writeEvents(
        runDirectory,
        placementRows([["build", "implementer", "14:24:00.000", "14:25:00.000"]]),
      );
      writeOwnedSession("lead", "14:21:00.000", [anthropicReply("14:26:00.000", 1)], {
        prompt: runLeadPrompt(),
      });
      writeOwnedSession("implementer", "14:24:10.000", [anthropicReply("14:24:20.000", 0.04)], {
        prompt: workerPrompt("build"),
      });
      // Starts in the gap after the build window: no window, no spec line, no worker.started.
      writeOwnedSession("unassigned", "14:27:00.000", [openAiReply("14:27:30.000", 0.09)], {
        prompt: [skillPromptRecord("chief")],
      });
      if (withSecondFile)
        writeOwnedSession("unassigned-2", "14:28:00.000", [openAiReply("14:28:30.000", 0.11)], {
          prompt: [skillPromptRecord("chief")],
        });

      const out = runRetro();
      const metrics = readMetrics();
      const { by_role: roles, by_step: steps } = metrics.cost;
      const unassignedUsd = withSecondFile ? 0.2 : 0.09;
      expect(roles.orchestration.usd).toBeCloseTo(1, 6);
      expect(metrics.orchestration.master_chief_and_run_lead_cost.usd).toBeCloseTo(1, 6);
      expect(roles.unassigned.usd).toBeCloseTo(unassignedUsd, 6);
      expect(steps.unassigned.usd).toBeCloseTo(unassignedUsd, 6);
      expect(steps.orchestration.usd).toBeCloseTo(1, 6);
      expect(rolesTotal(roles)).toBeCloseTo(metrics.cost.total_usd, 6);
      expect(out).toContain(withSecondFile ? "unassigned: 2 files" : "unassigned: 1 file, $0.09");
      expect(out).toContain("unassigned.jsonl");
      if (withSecondFile) expect(out).toContain("unassigned-2.jsonl");
    },
  );

  test("ARK-348/AC2 ARK-T66 a cross-vendor reviewer with an overlapping Anthropic run lead and an Anthropic unassigned file is not same vendor and not mixed", () => {
    writeEvents(runDirectory, sharedScenario);
    writeRunLead();
    writeImplementer();
    writeOwnedSession("reviewer", "14:28:30.000", [openAiReply("14:29:00.000", 0.05)]);
    writeOwnedSession("unassigned", "14:27:00.000", [anthropicReply("14:27:30.000", 0.09)]);

    const out = runRetro();
    expect(readMetrics().same_vendor_review).toBe(false);
    expect(readMetrics().actual_models.review).toEqual(["gpt-6.1-sol"]);
    expect(out).toContain("same vendor review: false");
    expect(out).not.toContain("mixed");
  });

  test("ARK-348/AC2 ARK-T66 a reviewer step with no session of its own is not same vendor because of an Anthropic run lead", () => {
    writeEvents(runDirectory, sharedScenario);
    writeRunLead();
    writeImplementer();

    expect(runRetro()).toContain("same vendor review: false");
    expect(readMetrics().same_vendor_review).toBe(false);
    expect(readMetrics().actual_models.review).toEqual([]);
  });

  test("ARK-348/AC2 ARK-T66 helper calls are listed in helper_models with their cost, stay in the step cost, and older metrics.json without helper_models still load", () => {
    writeEvents(runDirectory, sharedScenario);
    writeRunLead();
    writeImplementer();
    writeOwnedSession("reviewer", "14:28:30.000", [
      openAiReply("14:29:00.000", 0.1),
      { ...openAiReply("14:30:00.000", 0.001), model: "gpt-6-luna", purpose: "job-widget" },
      { ...openAiReply("14:31:00.000", 0.002), model: "typesafe/jev-1.14", purpose: "find" },
      { ...anthropicReply("14:32:00.000", 0.003, "claude-haiku-4-5"), purpose: "job-caption" },
    ]);
    // An earlier closed run from before the change: its metrics.json has no helper_models.
    const earlier = join(arkHome, "projects", "demo", "runs", "2026-10-28-ARK-900-1");
    writeEvents(earlier, [["14:00:00.000", "run.closed", { outcome: "merged" }]]);
    writeFileSync(
      join(earlier, "metrics.json"),
      JSON.stringify({
        run: "2026-10-28-ARK-900-1",
        cost: { total_usd: 2 },
        time: { wall_seconds: 60 },
      }),
    );

    const out = runRetro();
    const metrics = readMetrics();
    expect(metrics.same_vendor_review).toBe(false);
    expect(metrics.actual_models.review).toEqual(["gpt-6.1-sol"]);
    expect(metrics.helper_models.review).toMatchObject([
      { model: "claude-haiku-4-5", purpose: "job-caption", usd: 0.003 },
      { model: "gpt-6-luna", purpose: "job-widget", usd: 0.001 },
      { model: "typesafe/jev-1.14", purpose: "find", usd: 0.002 },
    ]);
    expect(metrics.cost.by_step.review.usd).toBeCloseTo(0.106, 6);
    expect(out).toContain("helper models: review");
    expect(metrics.comparison.runs_compared).toBe(1);
  });

  test("ARK-T292 metrics.json holds the resources of the run and ark retro lists its top 3 by memory", () => {
    // Written by `ark test` (suites) and by the hub (agents): 4 agents, 2 suites at head.
    mkdirSync(join(runDirectory, "results"), { recursive: true });
    writeFileSync(
      join(runDirectory, "results", "resources.json"),
      JSON.stringify({
        suites: {
          unit: { head: { peak_mb: 700, cpu_s: 30, wall_s: 60, wait_s: 0 } },
          e2e: { head: { peak_mb: 450, cpu_s: 55, wall_s: 90, wait_s: 0 }, base: { cached: true } },
        },
        agents: {
          H1: { peak_mb: 500, cpu_s: 26 },
          H2: { peak_mb: 250, cpu_s: 12 },
          H3: { peak_mb: 100, cpu_s: 2 },
          H4: { peak_mb: 50, cpu_s: 1 },
        },
        gaps: [{ from: "2026-10-29T14:21:00.000Z", to: "2026-10-29T14:26:00.000Z" }],
      }),
    );
    const printed = captureRetro();
    const { resources } = readMetrics();
    // The peak is the largest entry, never a sum; the CPU seconds are 26+12+2+1 for agents and 30+55 for suites.
    expect(resources.peak_mb).toBe(700);
    expect(resources.cpu_s).toBe(126);
    expect(resources.top.map((entry: { name: string }) => entry.name)).toEqual([
      "unit head",
      "H1",
      "e2e head",
    ]);
    const line = printed.split("\n").find((text) => text.startsWith("resources:"))!;
    expect(line).toContain("suite unit head 700 MB");
    expect(line.indexOf("agent H1 500 MB")).toBeGreaterThan(line.indexOf("suite unit head 700 MB"));
    expect(line.indexOf("suite e2e head 450 MB")).toBeGreaterThan(line.indexOf("agent H1 500 MB"));
    expect(line).not.toContain("H2");
  });

  test("ARK-T292 a run with no resources.json completes with resources unknown, and an earlier run without it is not counted as zero", () => {
    const earlierId = "2026-10-28-ARK-900-1";
    const earlier = join(arkHome, "projects", "demo", "runs", earlierId);
    writeEvents(earlier, [
      [
        "14:00:00.000",
        "run.started",
        {
          run: earlierId,
          project: "demo",
          ticket: { id: "ARK-900", title: "t" },
          criteria: [],
          round_budget: 1,
        },
      ],
      ["14:10:00.000", "run.closed", { outcome: "merged" }],
    ]);
    writeFileSync(
      join(earlier, "metrics.json"),
      JSON.stringify({ run: earlierId, cost: { total_usd: 2 }, time: { wall_seconds: 60 } }),
    );
    const printed = captureRetro();
    expect(readMetrics().resources).toBe("unknown");
    expect(printed).toContain("resources: unknown");
    expect(readMetrics().comparison.runs_compared).toBe(1);
  });
});
