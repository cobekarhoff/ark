import { beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { retro, runningCost } from "../cli/retro.ts";
import { parseClaudeSession } from "../cli/usage/claude.ts";
import { readUsage } from "../cli/usage/index.ts";
import { parseOmpSession } from "../cli/usage/omp.ts";
import { tempArkHome } from "./helpers.ts";

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
  const lines = rows.map(([time, type, data], index) => JSON.stringify({ seq: index + 1, time: `2026-10-29T${time}Z`, type, data }));
  writeFileSync(join(directory, "events.ndjson"), `${lines.join("\n")}\n`);
}

const day = (time: string) => `2026-10-29T${time}Z`;

// The run lead works in the workspace root; build runs in repos/platform, review in repos/shared.
const scenario: EventRow[] = [
  ["14:20:00.000", "run.started", { run: runId, project: "demo", ticket: { id: "ARK-901", title: "t" }, criteria: ["ARK-901-AC1"], round_budget: 2 }],
  ["14:20:30.000", "plan.checked", { valid: true, problems: [], plan_hash: "a", steps: [] }],
  ["14:21:00.000", "gate.answered", { gate: "plan", answer: "change" }],
  ["14:21:30.000", "plan.checked", { valid: true, problems: [], plan_hash: "b", steps: [] }],
  ["14:22:00.000", "gate.answered", { gate: "plan", answer: "approve" }],
  ["14:24:00.000", "step.started", { step: "build", role: "implementer", repo: "repos/platform", round: 1 }],
  ["14:25:00.000", "step.finished", { step: "build", outcome: "succeeded" }],
  ["14:28:00.000", "step.started", { step: "review", role: "reviewer", repo: "repos/shared", round: 1 }],
  ["14:55:00.000", "step.finished", { step: "review", outcome: "failed" }],
  ["14:55:30.000", "gate.answered", { gate: "escalation", answer: "one_more_round" }],
  ["14:56:00.000", "step.started", { step: "build", role: "implementer", repo: "repos/platform", round: 2 }],
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
    expect(session.messages.map(({ time, model, provider, input, output, cacheRead, cacheWrite, costUsd, toolError }) => ({ time, model, provider, input, output, cacheRead, cacheWrite, costUsd, toolError }))).toEqual([
      { time: day("14:24:42.254"), model: "claude-haiku-4-5", provider: "anthropic", input: 10, output: 305, cacheRead: 0, cacheWrite: 15713, costUsd: 0.032961, toolError: false },
      { time: day("14:24:43.535"), model: "claude-haiku-4-5", provider: "anthropic", input: 8, output: 44, cacheRead: 15713, cacheWrite: 327, costUsd: 0.0024533000000000003, toolError: false },
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
    expect(first).toMatchObject({ model: "claude-sonnet-5", provider: "anthropic", input: 2, output: 175, cacheRead: 0, cacheWrite: 32857 });
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
    writeFileSync(join(ompRoot, "elsewhere", "other.jsonl"), readFileSync(join(fixtures, "omp", "build.jsonl"), "utf8").replaceAll("__RUN__", "/somewhere/else"));
    const files = readUsage(runDirectory).map((session) => session.file.replace(ompRoot, "omp").replace(claudeRoot, "claude")).sort();
    expect(files).toEqual(["claude/workspace/session-lead.jsonl", "omp/platform/session-build.jsonl", "omp/platform/session-build/Helper.jsonl", "omp/shared/session-review.jsonl"]);
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
    expect(Object.keys(JSON.parse(first))).toEqual(["run", "cost", "time", "rework", "human_intervention", "escaped_defects", "orchestration", "comparison"]);
  });

  test("ARK-160-AC1 compares with the project's other closed runs that have metrics", () => {
    const projectRuns = join(arkHome, "projects", "demo", "runs");
    const closed = (name: string, cost: number, wallSeconds: number, closing = true) => {
      const directory = join(projectRuns, name);
      writeEvents(directory, [["10:00:00.000", "run.started", {}], ...(closing ? ([["10:05:00.000", "run.closed", {}]] as EventRow[]) : [])]);
      writeFileSync(join(directory, "metrics.json"), JSON.stringify({ cost: { total_usd: cost }, time: { wall_seconds: wallSeconds } }));
    };
    closed("2026-10-01-ARK-900-1", 1, 10);
    closed("2026-10-02-ARK-900-1", 3, 30);
    closed("2026-10-03-ARK-900-1", 100, 1000, false); // still open: ignored
    retro(runId);
    expect(readMetrics().comparison).toEqual({ runs_compared: 2, median_cost_usd: 2, median_wall_seconds: 20 });
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
    expect(Object.keys(cost.by_model)).toEqual(["claude-future-9", "claude-haiku-4-5", "claude-opus-5-5", "claude-sonnet-5"]);
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
    expect(cost.by_model["claude-future-9"]).toEqual({ usd: "unknown", tokens: 12, includes_unknown: true });
    expect(orchestration.master_chief_and_run_lead_cost.includes_unknown).toBe(true);
    expect(orchestration.master_chief_and_run_lead_cost.usd).toBeCloseTo(0.1440014, 5); // the known part only
    expect(runningCost(runDirectory).usd).toBe("unknown");
  });

  test("ARK-160-AC3 reports unknown, not zero, when no session usage exists", () => {
    retro(runId);
    const { cost, orchestration } = readMetrics();
    expect(cost).toMatchObject({ total_usd: "unknown", tokens: 0, includes_unknown: true, review_to_build_ratio: "unknown" });
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

  test("ARK-160-AC5 reports rework, plan changes and escaped defects linked to the run", () => {
    writeFileSync(
      join(arkHome, "projects", "demo", "escaped-defects.yml"),
      `- { ticket: ARK-901, run: ${runId}, note: "rounding bug found in production" }\n- { ticket: ARK-777, run: 2026-09-01-ARK-777-1, note: "other run" }\n`,
    );
    retro(runId);
    const metrics = readMetrics();
    expect(metrics.rework).toEqual({ rounds: 2, escalations: 1, findings_sent_back: 1 });
    expect(metrics.human_intervention).toEqual({ plan_changes: 1, mr_comments: 0, mr_commits_after_open: 0 });
    expect(metrics.escaped_defects).toEqual([{ ticket: "ARK-901", run: runId, note: "rounding bug found in production" }]);
  });

  describe("merge request activity", () => {
    const originalPath = process.env.PATH;
    const withMergeRequest: EventRow[] = [
      ...scenario.slice(0, -1),
      ["14:56:30.000", "merge_request.opened", { repo: "repos/platform", url: "https://github.com/acme/platform/pull/7", number: 7 }],
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
      expect(readMetrics().human_intervention).toMatchObject({ mr_comments: 3, mr_commits_after_open: 1 });
    });

    test("ARK-160-AC5 reports unknown MR activity when gh cannot answer", () => {
      const emptyBin = mkdtempSync(join(tmpdir(), "ark-no-gh-"));
      process.env.PATH = emptyBin;
      try {
        retro(runId);
      } finally {
        process.env.PATH = originalPath;
      }
      expect(readMetrics().human_intervention).toMatchObject({ mr_comments: "unknown", mr_commits_after_open: "unknown" });
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
});
