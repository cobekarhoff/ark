import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ark, tempArkHome } from "./helpers.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

type EventRow = { at: string; type: string; data?: Record<string, unknown> };

const start = Date.parse("2026-11-02T10:00:00Z");
/** The ISO instant `seconds` after run start. */
const after = (seconds: number): string => new Date(start + seconds * 1000).toISOString();
const row = (seconds: number, type: string, data: Record<string, unknown> = {}): EventRow => ({
  at: after(seconds),
  type,
  data,
});
const started = (seconds = 0) =>
  row(seconds, "run.started", {
    run: "x",
    project: "demo",
    ticket: { id: "ARK-901", title: "t" },
    criteria: ["ARK-901-AC1"],
    round_budget: 1,
  });
const stepStarted = (seconds: number, step: string) =>
  row(seconds, "step.started", { step, role: "implementer", repo: ".", round: 1 });
const stepFinished = (seconds: number, step: string, outcome = "succeeded") =>
  row(seconds, "step.finished", { step, outcome });
const planChecked = (seconds: number) =>
  row(seconds, "plan.checked", { valid: true, problems: [], plan_hash: "a", steps: [] });
const planAnswered = (seconds: number) =>
  row(seconds, "gate.answered", { gate: "plan", answer: "approve" });
const mergeOpened = (seconds: number) =>
  row(seconds, "merge_request.opened", { repo: ".", url: "https://x/1", number: 1 });
const closed = (seconds: number) => row(seconds, "run.closed", { outcome: "merged" });

let home: string;
let runCounter = 0;

beforeEach(() => {
  home = tempArkHome();
  runCounter = 0;
});

/** A closed run folder holding the given events; returns its id and folder. */
function makeRun(rows: EventRow[], day = "2026-11-02"): { runId: string; directory: string } {
  runCounter += 1;
  const runId = `${day}-ARK-901-${runCounter}`;
  const directory = join(home, "projects", "demo", "runs", runId);
  mkdirSync(directory, { recursive: true });
  const lines = rows.map((event, index) =>
    JSON.stringify({ seq: index + 1, time: event.at, type: event.type, data: event.data ?? {} }),
  );
  writeFileSync(join(directory, "events.ndjson"), `${lines.join("\n")}\n`);
  return { runId, directory };
}

/** Runs the real `ark retro` and reads the `time` block it wrote. */
function retroTime(rows: EventRow[]) {
  const { runId, directory } = makeRun(rows);
  const result = ark("retro", runId, "--project", "demo");
  expect(result.code, result.err).toBe(0);
  const metrics = JSON.parse(readFileSync(join(directory, "metrics.json"), "utf8"));
  return { time: metrics.time, out: result.out, metrics };
}

/** The four parts in order: waiting on you, working, waiting to merge, idle. */
const partsOf = (time: Record<string, number>) => [
  time.waiting_on_you_seconds,
  time.working_seconds,
  time.waiting_to_merge_seconds,
  time.idle_seconds,
];

/** Step a T+60..300 overlapping a plan gate T+200..400, step b T+500..560, two MRs, close at T+900. */
const base = (): EventRow[] => [
  started(),
  stepStarted(60, "a"),
  planChecked(200),
  stepFinished(300, "a"),
  planAnswered(400),
  stepStarted(500, "b"),
  stepFinished(560, "b"),
  mergeOpened(600),
  mergeOpened(700),
  closed(900),
];

describe("time split of ark retro", () => {
  test("ARK-T174 a run's time splits into waiting on you, working, waiting to merge and idle, adding up to the wall time with that precedence", () => {
    const { time } = retroTime(base());
    // The gate wins the overlap T+200..300; the first MR starts waiting to merge, the second does not move it.
    expect(partsOf(time)).toEqual([200, 200, 300, 200]);
    expect(partsOf(time).reduce((sum, part) => sum + part, 0)).toBe(time.wall_seconds);

    // (b) a gate still open at close runs to the close and wins over waiting to merge.
    const open = retroTime([
      started(),
      stepStarted(60, "a"),
      stepFinished(300, "a"),
      mergeOpened(600),
      row(800, "test.completed", { criteria: { "ARK-901-AC1": "manual pending" } }),
      closed(900),
    ]).time;
    expect(partsOf(open)).toEqual([100, 240, 200, 360]);
    expect(partsOf(open).reduce((sum, part) => sum + part, 0)).toBe(900);

    // (c) a step with no finish runs to the end of the run.
    const unfinished = retroTime([started(), stepStarted(850, "a"), closed(900)]).time;
    expect(partsOf(unfinished)).toEqual([0, 50, 0, 850]);

    // (d) nothing happened: all idle.
    const empty = retroTime([started(), closed(90)]).time;
    expect(partsOf(empty)).toEqual([0, 0, 0, 90]);
  });

  describe("escalation wait", () => {
    // ARK-310: a review that succeeded, 353 minutes of silence, a request and an answer 27 ms apart.
    const review = (outcome: string, extra: EventRow[] = []): EventRow[] => [
      { at: "2026-11-05T22:00:00.000Z", type: "run.started", data: started().data },
      { at: "2026-11-05T23:00:00.000Z", type: "step.started", data: stepStarted(0, "x").data },
      { at: "2026-11-06T00:21:43.929Z", type: "step.finished", data: { step: "x", outcome } },
      ...extra,
      { at: "2026-11-06T06:15:04.056Z", type: "escalation.requested", data: { reason: "r" } },
      {
        at: "2026-11-06T06:15:04.083Z",
        type: "gate.answered",
        data: { gate: "escalation", answer: "one_more_round" },
      },
      { at: "2026-11-06T06:20:00.000Z", type: "run.closed", data: { outcome: "aborted" } },
    ];
    const waited = (rows: EventRow[]) => retroTime(rows).time.waiting_on_you_seconds;

    test("ARK-T176 an escalation wait starts at the last step or test event before the escalation, whatever the step outcome", () => {
      // 00:21:43.929 to 06:15:04.083 is 353 min 20.154 s, not the 0.027 s from request to answer.
      expect(waited(review("succeeded"))).toBeCloseTo(21200.154, 3);
      expect(waited(review("failed"))).toBeCloseTo(21200.154, 3);
      // A test.completed after the step is the last event: the wait starts there.
      const tested = review("succeeded", [
        { at: "2026-11-06T00:30:00.000Z", type: "test.completed", data: { criteria: {} } },
      ]);
      expect(waited(tested)).toBeCloseTo(20704.083, 3);
      // An answer alone, with no request, ends and starts the same wait.
      const answerOnly = review("succeeded").filter(
        (event) => event.type !== "escalation.requested",
      );
      expect(waited(answerOnly)).toBeCloseTo(21200.154, 3);
      // Nothing before the request: the wait starts at the request and nothing throws.
      const nothingBefore = [
        started(),
        row(100, "escalation.requested", { reason: "r" }),
        row(130, "gate.answered", { gate: "escalation", answer: "one_more_round" }),
        closed(200),
      ];
      expect(waited(nothingBefore)).toBe(30);
      // A second escalation starts at its own last step, not at the first answer.
      const twice = [
        started(),
        stepStarted(10, "a"),
        stepFinished(20, "a"),
        row(100, "escalation.requested", { reason: "r" }),
        row(130, "gate.answered", { gate: "escalation", answer: "one_more_round" }),
        stepStarted(140, "a"),
        stepFinished(300, "a"),
        row(400, "escalation.requested", { reason: "r" }),
        row(430, "gate.answered", { gate: "escalation", answer: "one_more_round" }),
        closed(500),
      ];
      expect(waited(twice)).toBe(110 + 130);
    });
  });

  test("ARK-T178 ark retro writes the four time parts to metrics.json and compares runs on waiting on you", () => {
    const earlier = (time: Record<string, number>, day: string) => {
      const { directory } = makeRun([started(), closed(100)], day);
      const body = JSON.stringify({ time: { wall_seconds: 100, ...time } });
      writeFileSync(join(directory, "metrics.json"), body);
      return { directory, body };
    };
    earlier({ waiting_on_you_seconds: 100 }, "2026-10-30");
    const old = earlier({ gate_wait_seconds: 5000 }, "2026-10-31");

    const { time, out, metrics } = retroTime(base());

    expect(partsOf(time)).toEqual([200, 200, 300, 200]);
    expect(time).not.toHaveProperty("gate_wait_seconds");
    expect(time).not.toHaveProperty("work_seconds");
    expect(out).toContain("200s waiting on you, 200s working, 300s waiting to merge, 200s idle");
    expect(out).not.toContain("waiting at gates");
    // Only the new file counts: typical 100 s, not the 50 s that reading the old one as 0 would give.
    expect(metrics.comparison.median_waiting_on_you_seconds).toBe(100);
    expect(out).toContain("waiting on you: 200s here, 100s typical");
    expect(readFileSync(join(old.directory, "metrics.json"), "utf8")).toBe(old.body);
  });
});
