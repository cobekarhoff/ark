// Fixtures for the hub tests, shared by test/hub.test.ts (Bun) and test/pw/hub.pw.ts (Node):
// no bun:test, no Bun.* globals. Every time comes from `new Date()`, never from a literal.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type FixtureStep = {
  id: string;
  role: string;
  harness: string;
  model: string;
  needs: string[];
  /** Seconds after the run started that the step started and finished. `finishedAfter` undefined: still running. */
  startedAfter?: number;
  finishedAfter?: number;
  outcome?: "succeeded" | "failed" | "stopped";
};

export type FixtureRun = {
  project: string;
  /** `<date>-<ticket id>-<number>`: also the run folder name. */
  run: string;
  ticket: { id: string; title: string };
  phase: "awaiting_criteria" | "planning" | "building" | "merge_requests_open" | "closed";
  steps?: FixtureStep[];
  mergeRequests?: { repo: string; url: string; number: number }[];
  /** Closed runs only: written as `metrics.json`. */
  metricsCostUsd?: number;
  /** Start of the run. Default: one hour ago. */
  startedAt?: Date;
};

/** `YYYY-MM-DD` of today, for run ids. */
export const today = (): string => new Date().toISOString().slice(0, 10);

export const runDirectoryOf = (project: string, run: string): string =>
  join(process.env.ARK_HOME as string, "projects", project, "runs", run);

/**
 * Writes a run folder: `events.ndjson` (what `deriveState` reads), `plan.yml` and `ticket.md`.
 * The events are written directly, so a fixture can stand in any phase without walking the gates.
 */
export function writeRun(fixture: FixtureRun): string {
  const directory = runDirectoryOf(fixture.project, fixture.run);
  mkdirSync(directory, { recursive: true });
  const started = (fixture.startedAt ?? new Date(Date.now() - 3_600_000)).getTime();
  let seq = 0;
  const events: string[] = [];
  const add = (secondsAfterStart: number, type: string, data: Record<string, unknown>) =>
    events.push(
      JSON.stringify({
        seq: ++seq,
        time: new Date(started + secondsAfterStart * 1000).toISOString(),
        type,
        data,
      }),
    );

  add(0, "run.started", {
    run: fixture.run,
    project: fixture.project,
    ticket: fixture.ticket,
    // No criteria at start: the run waits at the criteria gate.
    criteria: fixture.phase === "awaiting_criteria" ? [] : [`${fixture.ticket.id}-AC1`],
    round_budget: 3,
  });
  if (fixture.phase !== "awaiting_criteria") {
    add(10, "evaluation.recorded", { blockers: [], risks: [], surfaces: ["none"] });
    const steps = fixture.steps ?? [];
    if (steps.length > 0) {
      writeFileSync(
        join(directory, "plan.yml"),
        `${JSON.stringify({
          steps: steps.map((step) => ({
            id: step.id,
            role: step.role,
            repo: ".",
            harness: step.harness,
            model: step.model,
            needs: step.needs,
            criteria: [`${fixture.ticket.id}-AC1`],
          })),
        })}\n`,
      );
    }
    add(20, "plan.checked", {
      valid: true,
      plan_hash: "fixture",
      steps: steps.map((step) => ({ id: step.id, role: step.role, repo: "." })),
    });
    if (fixture.phase !== "planning") {
      add(30, "gate.answered", { gate: "plan", answer: "approve" });
      for (const step of steps) {
        if (step.startedAfter === undefined) continue;
        add(step.startedAfter, "step.started", {
          step: step.id,
          role: step.role,
          repo: ".",
          round: 1,
        });
        if (step.finishedAfter !== undefined)
          add(step.finishedAfter, "step.finished", {
            step: step.id,
            outcome: step.outcome ?? "succeeded",
          });
      }
      for (const request of fixture.mergeRequests ?? []) add(3000, "merge_request.opened", request);
      if (fixture.phase === "closed") add(3500, "run.closed", { outcome: "handed_off" });
    }
  }
  writeFileSync(join(directory, "events.ndjson"), `${events.join("\n")}\n`);
  writeFileSync(
    join(directory, "ticket.md"),
    `---\nid: ${fixture.ticket.id}\ntitle: ${JSON.stringify(fixture.ticket.title)}\n---\n`,
  );
  if (fixture.metricsCostUsd !== undefined)
    writeFileSync(
      join(directory, "metrics.json"),
      JSON.stringify({ cost: { total_usd: fixture.metricsCostUsd, by_step: {} } }),
    );
  return directory;
}

/** Appends one event to a run's log, stamped now, the way a run lead does. */
export function appendRawEvent(
  directory: string,
  type: string,
  data: Record<string, unknown>,
  seq: number,
): void {
  appendFileSync(
    join(directory, "events.ndjson"),
    `${JSON.stringify({ seq, time: new Date().toISOString(), type, data })}\n`,
  );
}

export type FixtureTicket = {
  project: string;
  id: string;
  title: string;
  status: string;
  milestone?: string;
  dependsOn?: string[];
};

/** Writes `$ARK_HOME/projects/<project>/tickets/<id>.md` with the front matter the backlog reads. */
export function writeBacklogTicket(ticket: FixtureTicket): void {
  const file = join(
    process.env.ARK_HOME as string,
    "projects",
    ticket.project,
    "tickets",
    `${ticket.id}.md`,
  );
  mkdirSync(dirname(file), { recursive: true });
  const lines = [
    "---",
    `id: ${ticket.id}`,
    `title: ${JSON.stringify(ticket.title)}`,
    `status: ${ticket.status}`,
    ...(ticket.milestone ? [`milestone: ${ticket.milestone}`] : []),
    ...(ticket.dependsOn?.length ? [`depends_on: [${ticket.dependsOn.join(", ")}]`] : []),
    "---",
    "",
  ];
  writeFileSync(file, lines.join("\n"));
}

export type FixtureMessage = { time: Date; costUsd: number };

/** One OMP session file: a `session` record with the cwd, then one assistant message per entry. */
export function ompSessionText(cwd: string, messages: FixtureMessage[]): string {
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "fixture", timestamp: new Date(), cwd }),
  ];
  for (const message of messages)
    lines.push(
      JSON.stringify({
        type: "message",
        id: "m",
        timestamp: message.time.toISOString(),
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-fixture",
          content: [],
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { total: message.costUsd },
          },
          stopReason: "stop",
        },
      }),
    );
  return `${lines.join("\n")}\n`;
}

export function writeOmpSession(
  sessionsRoot: string,
  name: string,
  cwd: string,
  messages: FixtureMessage[],
): string {
  const file = join(sessionsRoot, `${name}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, ompSessionText(cwd, messages));
  return file;
}

export type FakeToolOptions = {
  /** Orca answers: terminals, orchestration runs, workers and tasks, as the JSON each command prints. */
  orca?: {
    terminals?: unknown[];
    runs?: unknown[];
    workers?: unknown[];
    tasks?: unknown[];
    /** `inbox` messages; none by default. */
    messages?: unknown[];
  };
  /** Seconds each Orca call sleeps before it answers. */
  orcaSleepSeconds?: number;
  /** `orca terminal switch` exits 1. Every call is logged in `orca.log` either way. */
  orcaSwitchFails?: boolean;
  /** `up` answers, `down` fails every call, `twice` answers each command twice and then fails. */
  orcaMode?: "up" | "down" | "twice";
  plannotatorMode?: "up" | "down" | "twice";
  plannotatorSessions?: { index: number; target: string; url: string }[];
  /** Merge request URLs whose `gh pr checks` reports a failing check. */
  failingMergeRequests?: string[];
  /** Merge request URLs whose `gh pr view` fails. */
  failingMergeRequestViews?: string[];
};

/** Writes the state files the fake `orca`, `gh` and `plannotator` read. Call again to change an answer. */
export function writeFakeToolState(stateDirectory: string, options: FakeToolOptions): void {
  mkdirSync(stateDirectory, { recursive: true });
  const put = (name: string, value: string) => writeFileSync(join(stateDirectory, name), value);
  const wrap = (value: unknown[] | undefined, key: string) =>
    JSON.stringify({ result: { [key]: value ?? [] } });
  put("orca.terminals", wrap(options.orca?.terminals, "terminals"));
  put("orca.runs", wrap(options.orca?.runs, "runs"));
  put("orca.workers", wrap(options.orca?.workers, "workers"));
  put("orca.tasks", wrap(options.orca?.tasks, "tasks"));
  put("orca.inbox", wrap(options.orca?.messages, "messages"));
  put("orca.sleep", String(options.orcaSleepSeconds ?? 0));
  put("orca.switchfails", options.orcaSwitchFails ? "1" : "0");
  put("orca.mode", options.orcaMode ?? "up");
  put("plannotator.mode", options.plannotatorMode ?? "up");
  put("plannotator.sessions", JSON.stringify(options.plannotatorSessions ?? []));
  put("gh.failing", `${(options.failingMergeRequests ?? []).join("\n")}\n`);
  put("gh.viewfailing", `${(options.failingMergeRequestViews ?? []).join("\n")}\n`);
}

/** The mode switch both fakes share. `twice` counts calls per command in the state folder. */
const modeGate = (state: string, tool: string, key: string) => `
mode=$(cat "${state}/${tool}.mode" 2>/dev/null || echo up)
[ "$mode" = down ] && exit 1
if [ "$mode" = twice ]; then
  count=$(cat "${state}/${tool}.count.${key}" 2>/dev/null || echo 0)
  count=$((count + 1))
  printf '%s' "$count" > "${state}/${tool}.count.${key}"
  [ "$count" -gt 2 ] && exit 1
fi`;

/** Shell scripts for the fake `orca`, `gh` and `plannotator`. None of them touches the network or a real tool. */
export function fakeToolScripts(state: string): {
  orca: string;
  gh: string;
  plannotator: string;
} {
  return {
    orca: `echo "$*" >> '${state}/orca.log'
sleep "$(cat '${state}/orca.sleep')"
cmd=$(printf '%s %s' "$1" "$2" | tr -c 'a-z' '_')
${modeGate(state, "orca", "$cmd")}
case "$1 $2" in
  "terminal list") cat '${state}/orca.terminals' ;;
  "terminal switch") [ "$(cat '${state}/orca.switchfails')" = 1 ] && exit 1; echo '{"result":{}}' ;;
  "orchestration run-list") cat '${state}/orca.runs' ;;
  "orchestration worker-list") cat '${state}/orca.workers' ;;
  "orchestration task-list") cat '${state}/orca.tasks' ;;
  "orchestration inbox") cat '${state}/orca.inbox' ;;
  *) exit 1 ;;
esac`,
    // `gh pr checks` exits 1 for a failing check and 8 for a pending one, and still prints the checks.
    gh: `echo "$*" >> '${state}/gh.log'
case "$1 $2" in
  "pr checks")
    if grep -qxF "$3" '${state}/gh.failing'; then echo '[{"bucket":"fail"},{"bucket":"pass"}]'; exit 1; fi
    echo '[{"bucket":"pass"}]' ;;
  "pr view")
    if grep -qxF "$3" '${state}/gh.viewfailing'; then exit 1; fi
    echo '{"state":"OPEN"}' ;;
  *) exit 1 ;;
esac`,
    plannotator: `${modeGate(state, "plannotator", "sessions")}
cat '${state}/plannotator.sessions'`,
  };
}

/** Orca answers for one open run with a live run lead and one live implementer. */
export function orcaAnswersFor(run: string): NonNullable<FakeToolOptions["orca"]> {
  return {
    terminals: [
      {
        handle: "term-lead",
        connected: true,
        agentIdentity: "omp",
        model: "anthropic/claude-lead-model",
      },
      { handle: "term-worker", connected: true, agentIdentity: "codex" },
    ],
    runs: [{ id: `orca-${run}`, objective: `Ark run ${run}`, coordinator_handle: "term-lead" }],
    workers: [
      {
        taskId: "task-1",
        state: "running",
        agentTerminalHandle: "term-worker",
        projection: { provider: { model: "openai/gpt-worker-model" } },
      },
    ],
    tasks: [{ id: "task-1", title: "hub-server (implementer, .)" }],
  };
}

// ---------------------------------------------------------------- ARK-284

export type SessionHarness = "omp" | "claude" | "codex";

/** Texts a transcript fixture holds, from its `tag`: a test looks for them in the page. */
export const transcriptTexts = (tag: string) => ({
  user: `hello ${tag}`,
  thinking: `pondering ${tag}`,
  assistant: `answer ${tag}`,
  command: `ls -la /tmp/${tag}`,
  okFirstLine: `listing ok ${tag}`,
  failFirstLine: `boom ${tag}`,
  /** On the second line of a result: it must never reach the page. */
  tail: `FULL-RESULT-TAIL ${tag}`,
});

const iso = (start: Date, second: number) =>
  new Date(start.getTime() + second * 1000).toISOString();

/**
 * One session file of the given harness, in the shape the real files have: a user message, a
 * thinking block, an assistant text, one tool call that succeeds and one that fails. Record `n`
 * is stamped `start + n` seconds; the first stamp is `start`, the cwd is in the head.
 */
export function transcriptText(
  harness: SessionHarness,
  options: { cwd: string; start: Date; tag?: string },
): string {
  const { cwd, start } = options;
  const text = transcriptTexts(options.tag ?? harness);
  const at = (second: number) => iso(start, second);
  const okResult = `${text.okFirstLine}\nsecond line\n${text.tail}`;
  const failResult = `${text.failFirstLine}\n${text.tail}`;
  const records: unknown[] = [];
  if (harness === "omp") {
    const message = (second: number, body: Record<string, unknown>) => ({
      type: "message",
      id: `m${second}`,
      timestamp: at(second),
      message: body,
    });
    records.push(
      { type: "session", version: 3, id: "fixture", timestamp: at(0), cwd },
      message(1, { role: "user", content: [{ type: "text", text: text.user }] }),
      message(2, {
        role: "assistant",
        content: [
          { type: "thinking", thinking: text.thinking },
          { type: "text", text: text.assistant },
          { type: "toolCall", id: "c1", name: "bash", arguments: { command: text.command } },
          { type: "toolCall", id: "c2", name: "bash", arguments: { command: "false" } },
        ],
      }),
      message(3, {
        role: "toolResult",
        toolCallId: "c1",
        isError: false,
        content: [{ type: "text", text: okResult }],
      }),
      message(4, {
        role: "toolResult",
        toolCallId: "c2",
        isError: true,
        content: [{ type: "text", text: failResult }],
      }),
    );
  } else if (harness === "claude") {
    const record = (second: number, type: "user" | "assistant", content: unknown) => ({
      type,
      uuid: `u${second}`,
      timestamp: at(second),
      cwd,
      message: { role: type, content },
    });
    records.push(
      record(0, "user", text.user),
      record(1, "assistant", [
        { type: "thinking", thinking: text.thinking },
        { type: "text", text: text.assistant },
        { type: "tool_use", id: "c1", name: "Bash", input: { command: text.command } },
        { type: "tool_use", id: "c2", name: "Bash", input: { command: "false" } },
      ]),
      record(2, "user", [
        { type: "tool_result", tool_use_id: "c1", content: okResult },
        { type: "tool_result", tool_use_id: "c2", content: failResult, is_error: true },
      ]),
    );
  } else {
    const item = (second: number, payload: Record<string, unknown>) => ({
      timestamp: at(second),
      type: "response_item",
      payload,
    });
    const output = (result: string, exit: number) =>
      JSON.stringify({ output: result, metadata: { exit_code: exit } });
    records.push(
      { timestamp: at(0), type: "session_meta", payload: { id: "fixture", cwd } },
      item(1, {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: text.user }],
      }),
      item(2, { type: "reasoning", summary: [{ type: "summary_text", text: text.thinking }] }),
      item(3, {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: text.assistant }],
      }),
      item(4, {
        type: "function_call",
        name: "shell",
        call_id: "c1",
        arguments: JSON.stringify({ command: ["bash", "-lc", text.command] }),
      }),
      item(5, { type: "function_call_output", call_id: "c1", output: output(okResult, 0) }),
      item(6, {
        type: "function_call",
        name: "shell",
        call_id: "c2",
        arguments: JSON.stringify({ command: ["false"] }),
      }),
      item(7, { type: "function_call_output", call_id: "c2", output: output(failResult, 1) }),
    );
  }
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

/** An omp session file of `count` user messages `m0`, `m1`, ...: it pages at 200 entries. */
export function ompMessagesText(cwd: string, start: Date, count: number): string {
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "fixture", timestamp: iso(start, 0), cwd }),
  ];
  for (let number = 0; number < count; number++)
    lines.push(
      JSON.stringify({
        type: "message",
        id: `m${number}`,
        timestamp: iso(start, number + 1),
        message: { role: "user", content: [{ type: "text", text: `m${number}` }] },
      }),
    );
  return `${lines.join("\n")}\n`;
}

/** Writes `text` to `<root>/<relative>` and returns the path. */
export function writeSessionFile(root: string, relative: string, text: string): string {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

/**
 * Replaces a run's `events.ndjson` with the given events, one per line, `seconds` after `started`,
 * plus any raw lines (a damaged one) at the position given. Use it for a run that needs event
 * types `writeRun` does not write.
 */
export function writeEventLog(
  directory: string,
  started: Date,
  events: { after: number; type: string; data: Record<string, unknown> }[],
  rawLines: { before: number; text: string }[] = [],
): void {
  const lines: string[] = [];
  events.forEach((event, index) => {
    for (const raw of rawLines) if (raw.before === index) lines.push(raw.text);
    lines.push(
      JSON.stringify({
        seq: index + 1,
        time: iso(started, event.after),
        type: event.type,
        data: event.data,
      }),
    );
  });
  writeFileSync(join(directory, "events.ndjson"), `${lines.join("\n")}\n`);
}
