import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent } from "../cli/events.ts";
import { addWorktree, fakeSessionFolder, useFakeOrca } from "./fake-orca.ts";
import {
  ark,
  recordEvaluation,
  tempArkHome,
  tempGitRepo,
  writeProject,
  writeTicket,
} from "./helpers.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

// ARK-T210 to ARK-T216: `ark run step <run> <step> start|interrupted` against a fake `orca` on PATH, a fake omp
// session folder and the test clock (ARK_NOW, set for each `ark` call, so no test waits 60 s). No real orca, omp or
// test-runner starts, and the scratch folders go in afterEach.
const orca = useFakeOrca();

const model = "anthropic/claude-sonnet-5-5";
const ticketId = "ARK-900";
const acText = [
  "A step starts with `--first` and `second-literal`.",
  "Another step uses `not-for-step-a`.",
  "A criterion with no literal at all.",
];
const risks = [
  "Risk one: the `start` order matters",
  "Risk two without backticks",
  "Risk `three`: colon and `backticks`",
];
const learnings = [
  "# Learnings applied: learning one on the first line",
  "# learning two on the second line",
];
const startClock = "2026-11-10T10:00:00Z";

const planOf = () => ({
  design: { interfaces: [{ name: "fixture plan", callers: ["ark run step"] }] },
  summary: {
    why: "Fixture.",
    changes: [1, 2, 3].map((number) => ({
      criterion: `${ticketId}/AC${number}`,
      where: "cli",
      now: "None.",
      fix: "Fixture.",
    })),
  },
  steps: [
    ...["a", "b", "c", "d", "e"].map((id) => ({
      id,
      role: "implementer",
      repo: ".",
      harness: "omp",
      model,
      needs: [],
      criteria: [`${ticketId}/AC1`],
    })),
    // A validator on claude: the one harness here with a session folder and no restore command.
    {
      id: "v",
      role: "validator",
      repo: ".",
      harness: "claude",
      model: "claude-sonnet",
      needs: [],
      criteria: [`${ticketId}/AC1`],
    },
    {
      id: "other",
      role: "implementer",
      repo: ".",
      harness: "omp",
      model,
      needs: [],
      criteria: [`${ticketId}/AC2`, `${ticketId}/AC3`],
    },
  ],
  test_cases: [1, 2, 3].map((number) => ({
    id: `ARK-T90${number}`,
    action: "add",
    level: "integration",
    given: [],
    when: ["act"],
    // oxlint-disable-next-line unicorn/no-thenable -- plan test-case field `then: string[]`, not a Promise-like
    then: ["ok"],
    expected: "ok",
  })),
});

type Run = { runId: string; directory: string; worktree: string };

/** `ark` at the test clock `time`. */
function arkAt(time: string, ...args: string[]) {
  process.env.ARK_NOW = time;
  return ark(...args);
}

let previousClock: string | undefined;
beforeEach(() => {
  previousClock = process.env.ARK_NOW;
  tempArkHome();
  delete process.env.ARK_PROJECT;
  process.env.ARK_NOW = startClock;
});
afterEach(() => {
  if (previousClock === undefined) delete process.env.ARK_NOW;
  else process.env.ARK_NOW = previousClock;
});

/** A building run of `planOf()` with its worktree recorded; `worktree` defaults to a scratch git repo. */
function buildRun(options: { learningLines?: string[]; worktreeInRunFolder?: boolean } = {}): Run {
  writeProject("demo", {
    workspace: tempGitRepo(),
    ticket_source: "local",
    suites: [{ name: "e2e", level: "e2e", repo: ".", command: "true", parser: "bun" }],
    roles: {
      implementer: { harness: "omp", model },
      validator: { harness: "claude", model: "claude-sonnet" },
      reviewer: { harness: "omp", model },
    },
  });
  const ticketFile = writeTicket(
    "demo",
    ticketId,
    acText.map((text, index) => ({
      id: `AC${index + 1}`,
      text,
      verified_by: [`ARK-T90${index + 1}`],
    })),
  );
  const started = ark("run", "start", ticketFile, "--project", "demo");
  expect(started.err).toBe("");
  const runId = started.out.trim();
  const directory = join(process.env.ARK_HOME as string, "projects", "demo", "runs", runId);
  writeFileSync(
    join(directory, "evaluation.md"),
    `## Blockers\n\n## Risks\n\n${risks.map((risk) => `- ${risk}`).join("\n")}\n\n## Surfaces\n\n- none\n`,
  );
  recordEvaluation(directory, [], risks);
  writeFileSync(
    join(directory, "plan.yml"),
    `${[...(options.learningLines ?? learnings), "# Learnings read and not applied: not a spec line"].join("\n")}\n${JSON.stringify(planOf())}\n`,
  );
  for (const args of [
    ["plan", "check", runId],
    ["gate", "record", runId, "plan", "approve"],
  ]) {
    const result = ark(...args);
    if (result.code !== 0) throw new Error(`${args.join(" ")} failed: ${result.err}${result.out}`);
  }
  let worktree: string | undefined;
  if (options.worktreeInRunFolder) {
    worktree = join(directory, "workspace");
    mkdirSync(worktree, { recursive: true });
  }
  return { runId, directory, worktree: addWorktree(directory, ".", worktree) };
}

type Recorded = { type: string; data: Record<string, any> };
const eventsOf = (directory: string): Recorded[] =>
  readFileSync(join(directory, "events.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const workerOf = (directory: string, step: string): Record<string, string> =>
  eventsOf(directory).findLast(
    (event) => event.type === "worker.started" && event.data.step === step,
  )!.data;
const flagOf = (args: string[], name: string) => args[args.indexOf(name) + 1];
const workerStarts = () => orca.calls().filter((call) => call[1] === "worker-start");
const start = (run: Run, step: string) => ark("run", "step", run.runId, step, "start");
const interrupt = (run: Run, step: string) => ark("run", "step", run.runId, step, "interrupted");
/** The status of `step` in the run's persisted state, the one `ark status` derives. */
const stepStatus = (run: Run, step: string): string =>
  JSON.parse(readFileSync(join(run.directory, "state.json"), "utf8")).steps.find(
    (entry: { id: string }) => entry.id === step,
  ).status;
const started = (run: Run, step: string) => {
  const result = start(run, step);
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
};

test("ARK-T210 start calls worker-start once with the step's worktree, harness and model and records the dispatch, terminal and session", () => {
  const run = buildRun();
  started(run, "a");
  const calls = workerStarts();
  expect(calls).toHaveLength(1);
  expect(flagOf(calls[0], "--worktree")).toBe(`path:${run.worktree}`);
  expect(flagOf(calls[0], "--agent")).toBe("omp");
  expect(flagOf(calls[0], "--model")).toBe(model);
  expect(flagOf(calls[0], "--from")).toBe("orca_session_id:run-lead-1");
  expect(
    eventsOf(run.directory)
      .map((event) => event.type)
      .slice(-2),
  ).toEqual(["step.started", "worker.started"]);
  const worker = workerOf(run.directory, "a");
  expect(worker.dispatch).toMatch(/^ctx_/);
  expect(Object.keys(orca.terminals())).toEqual([worker.terminal]);
  expect(worker.harness).toBe("omp");
  expect(worker.session.startsWith(fakeSessionFolder())).toBe(true);
  expect(existsSync(worker.session)).toBe(true);
  expect(stepStatus(run, "a")).toBe("running");
});

test("ARK-T210 a worker whose session file never shows records the session as unknown after 60 s on the test clock, and the step is running", () => {
  const run = buildRun();
  orca.configure({ writeSession: false });
  const before = Date.now();
  started(run, "b");
  expect(Date.now() - before).toBeLessThan(20_000);
  expect(workerOf(run.directory, "b").session).toBe("unknown");
  expect(stepStatus(run, "b")).toBe("running");
});

test("ARK-T210 a run with a step.started and no worker event still derives and its step can be marked interrupted", () => {
  const run = buildRun();
  appendEvent(run.directory, "step.started", {
    step: "a",
    role: "implementer",
    repo: ".",
    round: 1,
  });
  const status = ark("status", run.runId);
  expect(status.code).toBe(0);
  expect(stepStatus(run, "a")).toBe("running");
  expect(interrupt(run, "a").code).toBe(0);
  expect(stepStatus(run, "a")).toBe("interrupted");
});

/** Starts step `step` and returns the terminal handle of its worker. */
function runningWorker(run: Run, step: string): string {
  started(run, step);
  return workerOf(run.directory, step).terminal;
}

type Snapshot = { status: string; tracked: string; untracked: string };
function dirtyWorktree(worktree: string): Snapshot {
  writeFileSync(join(worktree, "README.md"), "# edited by the worker\n");
  writeFileSync(join(worktree, "scratch.txt"), "work in progress\n");
  return snapshotOf(worktree);
}
const snapshotOf = (worktree: string): Snapshot => ({
  status: Bun.spawnSync(["git", "status", "--porcelain"], { cwd: worktree }).stdout.toString(),
  tracked: readFileSync(join(worktree, "README.md"), "utf8"),
  untracked: readFileSync(join(worktree, "scratch.txt"), "utf8"),
});

test("ARK-T211 interrupted is refused while Orca lists the worker terminal as connected", () => {
  const run = buildRun();
  const terminal = runningWorker(run, "a");
  const before = eventsOf(run.directory).length;
  const refused = interrupt(run, "a");
  expect(refused.code).not.toBe(0);
  expect(refused.err).toContain(terminal);
  expect(eventsOf(run.directory)).toHaveLength(before);
  expect(stepStatus(run, "a")).toBe("running");
});

test("ARK-T211 interrupted is refused while Orca lists the worker terminal as disconnected", () => {
  const run = buildRun();
  const terminal = runningWorker(run, "b");
  orca.configure({ terminals: { [terminal]: { connected: false } } });
  const before = eventsOf(run.directory).length;
  const refused = interrupt(run, "b");
  expect(refused.code).not.toBe(0);
  expect(refused.err).toContain(terminal);
  expect(refused.err).toContain("disconnected");
  expect(eventsOf(run.directory)).toHaveLength(before);
  expect(stepStatus(run, "b")).toBe("running");
});

test("ARK-T211 interrupted is refused while Orca fails to answer the terminal list", () => {
  const run = buildRun();
  runningWorker(run, "c");
  // The terminal is gone from Orca's state too, so only the failed answer can refuse.
  orca.configure({ failList: true, terminals: {} });
  const before = eventsOf(run.directory).length;
  const refused = interrupt(run, "c");
  expect(refused.code).not.toBe(0);
  expect(refused.err).toContain("list failed");
  expect(eventsOf(run.directory)).toHaveLength(before);
  expect(stepStatus(run, "c")).toBe("running");
});

test("ARK-T211 a terminal absent from a successful list gives the round back, leaves the dirty worktree byte-identical and lets the step start again at round 1", () => {
  const run = buildRun();
  const saved = dirtyWorktree(run.worktree);
  runningWorker(run, "d");
  orca.configure({ terminals: {} });
  const interrupted = interrupt(run, "d");
  expect(interrupted.err).toBe("");
  expect(interrupted.code).toBe(0);
  expect(eventsOf(run.directory).at(-1)).toMatchObject({
    type: "step.finished",
    data: { step: "d", outcome: "interrupted" },
  });
  expect(stepStatus(run, "d")).toBe("interrupted");
  expect(snapshotOf(run.worktree)).toEqual(saved);
  started(run, "d");
  const restarts = eventsOf(run.directory).filter(
    (event) => event.type === "step.started" && event.data.step === "d",
  );
  expect(restarts.map((event) => event.data.round)).toEqual([1, 1]);
});

/** Starts `step`, makes its worker die (Orca no longer lists it), and marks the step interrupted. */
function interruptedStep(
  run: Run,
  step: string,
  options: { session: boolean },
): Record<string, string> {
  orca.configure({ writeSession: options.session });
  runningWorker(run, step);
  const dead = workerOf(run.directory, step);
  orca.configure({ terminals: {}, writeSession: true });
  expect(interrupt(run, step).code).toBe(0);
  return dead;
}
function interruptedBrief(spec: string): void {
  expect(spec).toMatch(/earlier worker.*interrupted/i);
  expect(spec).toContain("`git status`");
}

test("ARK-T212 the next start of an interrupted step restores the recorded session with omp --restore in a bound terminal and starts no fresh worker", () => {
  const run = buildRun();
  const dead = interruptedStep(run, "a", { session: true });
  expect(dead.session).not.toBe("unknown");
  const freshBefore = workerStarts().length;
  started(run, "a");
  const calls = orca.calls();
  const create = calls.find((call) => call[0] === "terminal" && call[1] === "create")!;
  expect(flagOf(create, "--command")).toBe(`omp --restore ${dead.session}`);
  expect(flagOf(create, "--worktree")).toBe(`path:${run.worktree}`);
  const starts = workerStarts().slice(freshBefore);
  expect(starts).toHaveLength(1);
  expect(starts[0]).toContain("--terminal");
  expect(starts[0]).not.toContain("--agent");
  const restored = workerOf(run.directory, "a");
  expect(restored.session).toBe(dead.session);
  expect(restored.terminal).not.toBe(dead.terminal);
  expect(Object.keys(orca.terminals())).toEqual([restored.terminal]);
  expect(stepStatus(run, "a")).toBe("running");
});

test("ARK-T212 a step whose session is unknown restarts as a fresh worker briefed to read git status and git diff, with no restore command", () => {
  const run = buildRun();
  expect(interruptedStep(run, "b", { session: false }).session).toBe("unknown");
  started(run, "b");
  expect(orca.calls().some((call) => call[0] === "terminal" && call[1] === "create")).toBe(false);
  const fresh = orca.workers().at(-1)!;
  expect(fresh.kind).toBe("agent");
  interruptedBrief(fresh.spec);
  expect(fresh.spec).toContain("`git diff`");
  expect(stepStatus(run, "b")).toBe("running");
});

test("ARK-T212 a step whose harness has no restore command restarts as a fresh worker even with a recorded session", () => {
  const run = buildRun();
  const dead = interruptedStep(run, "v", { session: true });
  expect(dead.harness).toBe("claude");
  expect(dead.session.startsWith(fakeSessionFolder("claude"))).toBe(true);
  started(run, "v");
  expect(orca.calls().some((call) => call[0] === "terminal" && call[1] === "create")).toBe(false);
  const fresh = orca.workers().at(-1)!;
  expect(fresh.kind).toBe("agent");
  expect(flagOf(fresh.args, "--agent")).toBe("claude");
  interruptedBrief(fresh.spec);
  expect(fresh.spec).toContain("`git diff`");
});

for (const failure of ["failTerminalCreate", "failBind"]) {
  test(`ARK-T212 a restore that fails (${failure}) falls back to a fresh worker with the same brief and leaves no terminal of the failed restore`, () => {
    const run = buildRun();
    interruptedStep(run, "a", { session: true });
    orca.configure({ [failure]: true });
    started(run, "a");
    const fresh = orca.workers().at(-1)!;
    expect(fresh.kind).toBe("agent");
    interruptedBrief(fresh.spec);
    expect(fresh.spec).toContain("`git diff`");
    const worker = workerOf(run.directory, "a");
    expect(Object.keys(orca.terminals())).toEqual([worker.terminal]);
    expect(stepStatus(run, "a")).toBe("running");
  });
}

// ARK-T213: the events are written as the CLI would write them, at fixed instants, so the retro and status
// code derive them for real. Each run has its own folder under the scratch ARK_HOME.
type EventRow = [time: string, type: string, data: Record<string, unknown>];
const instant = (time: string) => `2026-11-10T${time}Z`;
const planStepsOf = (rows: EventRow[]) =>
  [
    ...new Set(
      rows.filter(([, type]) => type === "step.started").map(([, , data]) => data.step as string),
    ),
  ].map((id) => ({ id, role: "implementer", repo: ".", needs: [], criteria: [] }));

function writeRun(name: string, rows: EventRow[]): string {
  const runId = `2026-11-10-ARK-901-${name}`;
  const directory = join(process.env.ARK_HOME as string, "projects", "demo", "runs", runId);
  mkdirSync(directory, { recursive: true });
  const head: EventRow[] = [
    [
      "09:00:00",
      "run.started",
      {
        run: runId,
        project: "demo",
        ticket: { id: "ARK-901", title: "t" },
        criteria: ["ARK-901-AC1"],
        round_budget: 2,
      },
    ],
    [
      "09:01:00",
      "plan.checked",
      { valid: true, problems: [], plan_hash: "a", steps: planStepsOf(rows) },
    ],
    ["09:02:00", "gate.answered", { gate: "plan", answer: "approve" }],
  ];
  const lines = [...head, ...rows].map(([time, type, data], index) =>
    JSON.stringify({ seq: index + 1, time: instant(time), type, data }),
  );
  writeFileSync(join(directory, "events.ndjson"), `${lines.join("\n")}\n`);
  return runId;
}
const stepStart = (time: string, step: string, round: number, merge = false): EventRow => [
  time,
  "step.started",
  { step, role: "implementer", repo: ".", round, ...(merge ? { merge: true } : {}) },
];
const stepEnd = (time: string, step: string, outcome: string, merge = false): EventRow => [
  time,
  "step.finished",
  { step, outcome, ...(merge ? { merge: true } : {}) },
];

function metricsOf(runId: string) {
  const result = ark("retro", runId);
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  const directory = join(process.env.ARK_HOME as string, "projects", "demo", "runs", runId);
  return JSON.parse(readFileSync(join(directory, "metrics.json"), "utf8"));
}

test("ARK-T213 an interrupted window counts no round and no merge step, and counts as working time", () => {
  // Interrupted once, started again at the same round and finished; a merge start interrupted the same way.
  const interruptedRun = writeRun("1", [
    stepStart("09:10:00", "s1", 1),
    stepEnd("09:11:00", "s1", "interrupted"),
    stepStart("09:12:00", "s1", 1),
    stepEnd("09:16:00", "s1", "succeeded"),
    stepStart("09:20:00", "s1", 2, true),
    stepEnd("09:21:00", "s1", "interrupted", true),
    stepStart("09:22:00", "s1", 2, true),
    stepEnd("09:23:00", "s1", "succeeded", true),
    ["09:30:00", "run.closed", { outcome: "aborted" }],
  ]);
  // The same run with no interrupt.
  const plainRun = writeRun("2", [
    stepStart("09:10:00", "s1", 1),
    stepEnd("09:16:00", "s1", "succeeded"),
    stepStart("09:20:00", "s1", 2, true),
    stepEnd("09:23:00", "s1", "succeeded", true),
    ["09:30:00", "run.closed", { outcome: "aborted" }],
  ]);
  const interrupted = metricsOf(interruptedRun);
  expect(interrupted.rework.rounds).toBe(metricsOf(plainRun).rework.rounds);
  expect(interrupted.rework.merge_steps).toBe(1);
  // Both windows of s1 (60 s + 240 s) and both of the merge step (60 s + 60 s) are working time; the gaps are idle.
  expect(interrupted.time.working_seconds).toBe(60 + 240 + 60 + 60);
});

test("ARK-T213 a round 2 start that is interrupted and never restarted leaves the run at 1 round, and a real round 2 counts", () => {
  const rework = (name: string, lastEnd: EventRow) =>
    writeRun(name, [
      stepStart("09:10:00", "s3", 1),
      stepEnd("09:20:00", "s3", "failed"),
      ["09:20:00", "escalation.requested", { reason: "review failed" }],
      ["09:21:00", "gate.answered", { gate: "escalation", answer: "one_more_round" }],
      stepStart("09:22:00", "s3", 2),
      lastEnd,
      ["09:40:00", "run.closed", { outcome: "aborted" }],
    ]);
  const interruptedAtEnd = rework("3", stepEnd("09:30:00", "s3", "interrupted"));
  const realSecondRound = rework("4", stepEnd("09:30:00", "s3", "succeeded"));
  expect(metricsOf(interruptedAtEnd).rework.rounds).toBe(1);
  expect(metricsOf(realSecondRound).rework.rounds).toBe(2);
  const status = ark("status", interruptedAtEnd);
  expect(status.code).toBe(0);
  expect(status.out).toContain("current step: s3 (interrupted)");
  expect(status.out).toMatch(/round: 1\//);
});

// ARK-T214
const specOf = (index = 0) => orca.workers()[index].spec;
const acLiterals = ["`--first`", "`second-literal`"];

test("ARK-T214 the spec names the role and step and holds the risks, the applied learnings and only the backticked strings of the step's ACs", () => {
  const run = buildRun();
  started(run, "a");
  const spec = specOf();
  expect(spec).toMatch(/implementer/i);
  expect(spec).toContain("step a");
  const positions = risks.map((risk) => spec.indexOf(risk));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((left, right) => left - right));
  for (const line of learnings) expect(spec.split("\n")).toContain(line);
  expect(spec).not.toContain("not a spec line");
  for (const literal of acLiterals) expect(spec).toContain(literal);
  expect(spec).not.toContain("`not-for-step-a`");
  expect(spec).not.toContain("no literal at all");
  expect(spec).not.toMatch(/Rules/);
});

test("ARK-T214 a `none (…)` learnings line is held as that line", () => {
  const run = buildRun({ learningLines: ["# Learnings applied: none (no learning fits)"] });
  started(run, "b");
  expect(specOf().split("\n")).toContain("# Learnings applied: none (no learning fits)");
});

test("ARK-T214 the rules file of the run folder is held verbatim", () => {
  const run = buildRun();
  const rules = [
    "- Rule one: never edit `events.ndjson`",
    "- Rule two: run format before a commit",
  ];
  writeFileSync(join(run.directory, "rules.md"), `${rules.join("\n")}\n`);
  started(run, "c");
  for (const rule of rules) expect(specOf().split("\n")).toContain(rule);
});

test("ARK-T215 a refused start makes no worker-start call and appends no event", () => {
  const run = buildRun();
  started(run, "a");
  expect(ark("run", "step", run.runId, "a", "finish", "--failed").code).toBe(0);
  started(run, "a");
  expect(ark("run", "step", run.runId, "a", "finish", "--failed").code).toBe(0);
  const calls = orca.calls().length;
  const events = eventsOf(run.directory).length;
  const refused = start(run, "a");
  expect(refused.code).not.toBe(0);
  expect(refused.err).toContain("round budget spent");
  expect(orca.calls()).toHaveLength(calls);
  expect(eventsOf(run.directory)).toHaveLength(events);
});

test("ARK-T215 a worker-start that fails records the step as not started, spends no round, and a later start takes round 1", () => {
  const run = buildRun();
  orca.configure({ failWorkerStart: true });
  const failed = start(run, "a");
  expect(failed.code).not.toBe(0);
  expect(failed.err).toContain("worker-start");
  expect(eventsOf(run.directory).at(-1)).toMatchObject({
    type: "step.finished",
    data: { step: "a", outcome: "failed", not_started: true },
  });
  expect(eventsOf(run.directory).some((event) => event.type === "worker.started")).toBe(false);
  expect(stepStatus(run, "a")).not.toBe("running");
  orca.configure({ failWorkerStart: false });
  const control = start(run, "a");
  expect(control.code).toBe(0);
  expect(
    eventsOf(run.directory).findLast((event) => event.type === "step.started")!.data.round,
  ).toBe(1);
  expect(stepStatus(run, "a")).toBe("running");
});

// ARK-T216: the session files are built by the test at the instants of the step windows, because the fake Orca
// writes its file before step.started is recorded. Each worker event's `session` path is the file the test fills.
const message = (time: string, input: number, output: number) =>
  JSON.stringify({
    type: "message",
    id: `m-${time}`,
    timestamp: instant(time),
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      content: [],
      usage: {
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input + output,
        cost: { total: 0.001 },
      },
      stopReason: "stop",
    },
  });
function fillSession(file: string, cwd: string, headTime: string, messages: string[]): void {
  const head = JSON.stringify({ type: "session", id: file, timestamp: instant(headTime), cwd });
  writeFileSync(file, `${[head, ...messages].join("\n")}\n`);
}

/** Runs step a through start, interrupt and a second start on the test clock; the worktree is the run's workspace folder. */
function twoWindows(options: { restore: boolean }) {
  const run = buildRun({ worktreeInRunFolder: true });
  const workspace = run.worktree;
  const arkTime = (time: string, ...args: string[]) => arkAt(instant(time), ...args);
  expect(arkTime("10:00:00", "run", "step", run.runId, "a", "start").code).toBe(0);
  const first = workerOf(run.directory, "a").session;
  orca.configure({ terminals: {}, ...(options.restore ? {} : { failTerminalCreate: true }) });
  expect(arkTime("10:10:00", "run", "step", run.runId, "a", "interrupted").code).toBe(0);
  expect(arkTime("10:20:00", "run", "step", run.runId, "a", "start").code).toBe(0);
  const second = workerOf(run.directory, "a").session;
  expect(arkTime("10:30:00", "run", "step", run.runId, "a", "finish").code).toBe(0);
  return { run, workspace, first, second };
}

test("ARK-T216 a restored step keeps its one session file with one owner, counting its tokens once", () => {
  const { run, workspace, first, second } = twoWindows({ restore: true });
  expect(second).toBe(first);
  expect(first.startsWith(fakeSessionFolder())).toBe(true);
  fillSession(first, workspace, "10:00:30", [
    message("10:01:00", 10, 5),
    message("10:21:00", 20, 10),
  ]);
  const printed = ark("retro", run.runId);
  expect(printed.code).toBe(0);
  expect(printed.out).not.toContain("unassigned");
  const metrics = JSON.parse(readFileSync(join(run.directory, "metrics.json"), "utf8"));
  expect(metrics.cost.by_step.a.tokens).toBe(45);
  expect(metrics.cost.tokens).toBe(45);
  expect(metrics.orchestration.restarts).toBe(0);
});

test("ARK-T216 a fresh restart keeps two session files, each with one owner, counting no token twice or dropped", () => {
  const { run, workspace, first, second } = twoWindows({ restore: false });
  expect(second).not.toBe(first);
  for (const file of [first, second]) expect(file.startsWith(fakeSessionFolder())).toBe(true);
  fillSession(first, workspace, "10:00:30", [message("10:01:00", 10, 5)]);
  fillSession(second, workspace, "10:20:30", [message("10:21:00", 20, 10)]);
  const printed = ark("retro", run.runId);
  expect(printed.code).toBe(0);
  expect(printed.out).not.toContain("unassigned");
  const metrics = JSON.parse(readFileSync(join(run.directory, "metrics.json"), "utf8"));
  expect(metrics.cost.by_step.a.tokens).toBe(45);
  expect(metrics.cost.tokens).toBe(45);
  expect(metrics.orchestration.restarts).toBe(1);
});
