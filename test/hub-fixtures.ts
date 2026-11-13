// Fixtures for the hub tests, shared by test/hub.test.ts (Bun) and test/pw/hub.pw.ts (Node):
// no bun:test, no Bun.* globals. Every time comes from `new Date()`, never from a literal.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type FixtureStep = {
  id: string;
  role: string;
  harness: string;
  model: string;
  needs: string[];
  /** The step's repo; default `.`. */
  repo?: string;
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
  mergeRequests?: {
    repo: string;
    url: string;
    number: number;
    order?: number;
    waits_for?: number[];
  }[];
  /** The `repos` block of `plan.yml` (ARK-336). */
  repos?: {
    repo: string;
    why: string;
    depends_on?: { repo: string; kind: string; pin: string; evidence: string; bump?: string }[];
  }[];
  /** `worktree.created` events: `base` is a commit of the repo at `path`. */
  worktrees?: { repo: string; path: string; branch: string; base?: string }[];
  /** `bump.refreshed` events by bump step id. */
  bumpRefreshed?: Record<string, string>;
  /** Closed runs only: written as `metrics.json`. */
  metricsCostUsd?: number;
  /** Start of the run. Default: one hour ago. */
  startedAt?: Date;
  /** The ACs of the ticket. Default: `<ticket id>-AC1`. */
  criteria?: string[];
  /** Closed runs only: the `run.closed` outcome (default handed_off) and seconds after start (default 3500). */
  outcome?: "merged" | "aborted" | "abandoned" | "handed_off";
  closedAfter?: number;
  /** Closed runs only: the `test.completed` statuses by criterion id. */
  statuses?: Record<string, string>;
  /** Closed runs only: the verbatim text of `metrics.json`, written instead of `metricsCostUsd`. */
  metricsText?: string;
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
    criteria:
      fixture.phase === "awaiting_criteria"
        ? []
        : (fixture.criteria ?? [`${fixture.ticket.id}-AC1`]),
    round_budget: 3,
  });
  if (fixture.phase !== "awaiting_criteria") {
    add(10, "evaluation.recorded", { blockers: [], risks: [], surfaces: ["none"] });
    const steps = fixture.steps ?? [];
    if (steps.length > 0) {
      writeFileSync(
        join(directory, "plan.yml"),
        `${JSON.stringify({
          ...(fixture.repos ? { repos: fixture.repos } : {}),
          steps: steps.map((step) => ({
            id: step.id,
            role: step.role,
            repo: step.repo ?? ".",
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
      steps: steps.map((step) => ({ id: step.id, role: step.role, repo: step.repo ?? "." })),
    });
    if (fixture.phase !== "planning") {
      add(30, "gate.answered", { gate: "plan", answer: "approve" });
      for (const worktree of fixture.worktrees ?? []) add(31, "worktree.created", worktree);
      for (const step of steps) {
        if (step.startedAfter === undefined) continue;
        add(step.startedAfter, "step.started", {
          step: step.id,
          role: step.role,
          repo: step.repo ?? ".",
          round: 1,
        });
        if (step.finishedAfter !== undefined)
          add(step.finishedAfter, "step.finished", {
            step: step.id,
            outcome: step.outcome ?? "succeeded",
          });
      }
      for (const [step, value] of Object.entries(fixture.bumpRefreshed ?? {}))
        add(2900, "bump.refreshed", { step, value });
      for (const request of fixture.mergeRequests ?? []) add(3000, "merge_request.opened", request);
      if (fixture.statuses)
        add(3400, "test.completed", {
          passed: Object.values(fixture.statuses).every((status) => status === "passing"),
          criteria: fixture.statuses,
        });
      if (fixture.phase === "closed")
        add(fixture.closedAfter ?? 3500, "run.closed", {
          outcome: fixture.outcome ?? "handed_off",
        });
    }
  }
  writeFileSync(join(directory, "events.ndjson"), `${events.join("\n")}\n`);
  writeFileSync(
    join(directory, "ticket.md"),
    `---\nid: ${fixture.ticket.id}\ntitle: ${JSON.stringify(fixture.ticket.title)}\n---\n`,
  );
  if (fixture.metricsText !== undefined)
    writeFileSync(join(directory, "metrics.json"), fixture.metricsText);
  else if (fixture.metricsCostUsd !== undefined)
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
  kind?: string;
  milestone?: string;
  dependsOn?: string[];
  /** Text under `## Problem` and `## Change`. */
  problem?: string;
  change?: string;
  criteria?: {
    id: string;
    text: string;
    method?: string;
    manual?: boolean;
    /** Written as `verified_by: [...]`; left out when undefined. */
    verifiedBy?: string[];
  }[];
};

/** A project folder with no `ark.yml` and no runs is no project: give it a minimal config unless it has one. */
export function writeMinimalConfig(projectFolder: string): void {
  const file = join(projectFolder, "ark.yml");
  if (!existsSync(file)) writeFileSync(file, "ticket_source: github\n");
}

/** Writes `$ARK_HOME/projects/<project>/tickets/<id>.md` with the front matter the backlog reads. */
export function writeBacklogTicket(ticket: FixtureTicket): string {
  const file = join(
    process.env.ARK_HOME as string,
    "projects",
    ticket.project,
    "tickets",
    `${ticket.id}.md`,
  );
  mkdirSync(dirname(file), { recursive: true });
  writeMinimalConfig(join(dirname(file), ".."));
  const lines = [
    "---",
    `id: ${ticket.id}`,
    `title: ${JSON.stringify(ticket.title)}`,
    `status: ${ticket.status}`,
    ...(ticket.kind ? [`kind: ${ticket.kind}`] : []),
    ...(ticket.milestone ? [`milestone: ${ticket.milestone}`] : []),
    ...(ticket.dependsOn?.length ? [`depends_on: [${ticket.dependsOn.join(", ")}]`] : []),
    ...(ticket.criteria?.length
      ? [
          "acceptance_criteria:",
          ...ticket.criteria.flatMap((criterion) => [
            `  - id: ${criterion.id}`,
            ...(criterion.method ? [`    method: ${criterion.method}`] : []),
            ...(criterion.manual ? ["    manual: true"] : []),
            ...(criterion.verifiedBy
              ? [`    verified_by: [${criterion.verifiedBy.join(", ")}]`]
              : []),
            `    text: ${JSON.stringify(criterion.text)}`,
          ]),
        ]
      : []),
    "---",
    "",
    ...(ticket.problem ? ["## Problem", "", ticket.problem, ""] : []),
    ...(ticket.change ? ["## Change", "", ticket.change, ""] : []),
    ...(ticket.criteria?.length
      ? [
          "## Acceptance criteria",
          "",
          "| ID | Criterion |",
          "| --- | --- |",
          ...ticket.criteria.map((criterion) => `| ${criterion.id} | ${criterion.text} |`),
          "",
        ]
      : []),
  ];
  writeFileSync(file, lines.join("\n"));
  return file;
}

/**
 * Writes `test/cases/<id>.md` in a git repo (made on first use) and commits it, so the case has one
 * more version. `fields` are the front matter keys, each written as a JSON string.
 */
export function commitCase(repository: string, id: string, fields: Record<string, string>): void {
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  };
  mkdirSync(join(repository, "test", "cases"), { recursive: true });
  if (!existsSync(join(repository, ".git"))) {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Ark Test");
    git("config", "user.email", "ark@example.com");
  }
  const front = Object.entries({ id, ...fields }).map(
    ([key, value]) => `${key}: ${JSON.stringify(value)}`,
  );
  writeFileSync(
    join(repository, "test", "cases", `${id}.md`),
    ["---", ...front, "---", "", "## Objective", "", "A fixture case.", ""].join("\n"),
  );
  git("add", "-A");
  git("commit", "-q", "-m", `${id} ${fields.changed_by ?? ""}`);
}

/** `purpose` makes the entry an omp helper call (a `model_usage` record, as omp writes for job-caption). */
export type FixtureMessage = { time: Date; costUsd: number; model?: string; purpose?: string };

/** One OMP session file: a `session` record with the cwd, then one assistant message per entry. */
export function ompSessionText(
  cwd: string,
  messages: FixtureMessage[],
  start: Date = new Date(),
): string {
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "fixture", timestamp: start, cwd }),
  ];
  for (const message of messages)
    lines.push(
      JSON.stringify(
        message.purpose !== undefined
          ? {
              type: "model_usage",
              id: "h",
              timestamp: message.time.toISOString(),
              purpose: message.purpose,
              provider: "openai-codex",
              model: message.model ?? "claude-fixture",
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                cost: { total: message.costUsd },
              },
            }
          : {
              type: "message",
              id: "m",
              timestamp: message.time.toISOString(),
              message: {
                role: "assistant",
                provider: "anthropic",
                model: message.model ?? "claude-fixture",
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
            },
      ),
    );
  return `${lines.join("\n")}\n`;
}

export function writeOmpSession(
  sessionsRoot: string,
  name: string,
  cwd: string,
  messages: FixtureMessage[],
  start?: Date,
): string {
  const file = join(sessionsRoot, `${name}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, ompSessionText(cwd, messages, start));
  return file;
}

export type FakeToolOptions = {
  /** Orca answers: terminals, orchestration runs, workers and tasks, as the JSON each command prints. */
  orca?: {
    terminals?: unknown[];
    runs?: unknown[];
    workers?: unknown[];
    tasks?: unknown[];
    /** `worker-list --run <id>` answers `workersByRun[id]` when it has one, else `workers`: a run lead is only in Master Chief's list. */
    workersByRun?: Record<string, unknown[]>;
    /** `inbox` messages; none by default. */
    messages?: unknown[];
    /** `worktree ps` worktrees, each with a path and agents. */
    worktrees?: unknown[];
  };
  /** Seconds each Orca call sleeps before it answers. */
  orcaSleepSeconds?: number;
  /** `orca terminal switch` exits 1. Every call is logged in `orca.log` either way. */
  orcaSwitchFails?: boolean;
  /** `up` answers, `down` fails every call, `twice` answers each command twice and then fails. */
  orcaMode?: "up" | "down" | "twice";
  plannotatorMode?: "up" | "down" | "twice";
  plannotatorSessions?: { index: number; target: string; url: string }[];
  /** Merge request URLs whose `gh pr view` reports a failing check. */
  failingMergeRequests?: string[];
  /** Merge request URLs whose `gh pr view` fails. */
  failingMergeRequestViews?: string[];
  /** The `gh pr view` answer for a URL, as the JSON gh prints (default: one passing and one other check). */
  mergeRequestViews?: Record<string, unknown>;
  /** `orca worktree ps --agent-wait --json` exits 1. */
  orcaPsFails?: boolean;
  /** The full `orca orchestration inbox` read (any `--limit` but the liveness read's 200) exits 1; every other call still answers. */
  orcaInboxFails?: boolean;
  /** `up` answers `omp usage --json`, `down` fails, `once` answers once and then exits 1. */
  ompMode?: "up" | "down" | "once";
  /** The JSON `omp usage --json` prints. */
  ompUsage?: unknown;
};

/** Writes the state files the fake `orca`, `gh` and `plannotator` read. Call again to change an answer. */
export function writeFakeToolState(stateDirectory: string, options: FakeToolOptions): void {
  mkdirSync(stateDirectory, { recursive: true });
  const put = (name: string, value: string) => writeFileSync(join(stateDirectory, name), value);
  const wrap = (value: unknown[] | undefined, key: string) =>
    JSON.stringify({ result: { [key]: value ?? [] } });
  put("orca.terminals", wrap(options.orca?.terminals, "terminals"));
  // Every project of the fixture (and `p`) has a Master Chief Run, so the hub's queue source answers (an empty queue) and shows no stale chip.
  const projectsFolder = join(process.env.ARK_HOME ?? "", "projects");
  const projects = new Set([
    "p",
    ...(existsSync(projectsFolder) ? readdirSync(projectsFolder) : []),
  ]);
  const runs = options.orca?.runs ?? [];
  const objectives = new Set(runs.map((run) => (run as { objective?: string }).objective));
  put(
    "orca.runs",
    wrap(
      [
        ...runs,
        ...[...projects]
          .filter((project) => !objectives.has(`Master Chief: ${project} tickets`))
          .map((project) => ({
            id: `orca-chief-${project}`,
            objective: `Master Chief: ${project} tickets`,
          })),
      ],
      "runs",
    ),
  );
  put("orca.workers", wrap(options.orca?.workers, "workers"));
  put("orca.tasks", wrap(options.orca?.tasks, "tasks"));
  put("orca.inbox", wrap(options.orca?.messages, "messages"));
  put("orca.inboxfails", options.orcaInboxFails ? "1" : "0");
  for (const [orcaRun, workers] of Object.entries(options.orca?.workersByRun ?? {}))
    put(`orca.workers.${orcaRun}`, wrap(workers, "workers"));
  put("orca.sleep", String(options.orcaSleepSeconds ?? 0));
  put("orca.switchfails", options.orcaSwitchFails ? "1" : "0");
  put("orca.mode", options.orcaMode ?? "up");
  put("plannotator.mode", options.plannotatorMode ?? "up");
  put("plannotator.sessions", JSON.stringify(options.plannotatorSessions ?? []));
  put("gh.failing", `${(options.failingMergeRequests ?? []).join("\n")}\n`);
  put("gh.viewfailing", `${(options.failingMergeRequestViews ?? []).join("\n")}\n`);
  const checkRun = (conclusion: string) => ({
    __typename: "CheckRun",
    name: "ci",
    status: "COMPLETED",
    conclusion,
    detailsUrl: "https://ci.example/run/1",
  });
  const view = (conclusion: string) =>
    JSON.stringify({
      state: "OPEN",
      statusCheckRollup: [checkRun("SUCCESS"), checkRun(conclusion)],
      additions: 12,
      deletions: 3,
      changedFiles: 4,
      createdAt: new Date().toISOString(),
    });
  put("gh.pass", view("SUCCESS"));
  put("gh.fail", view("FAILURE"));
  for (const [url, answer] of Object.entries(options.mergeRequestViews ?? {}))
    put(`gh.view.${url.replace(/[^A-Za-z0-9]/g, "_")}`, JSON.stringify(answer));
  put("orca.ps", JSON.stringify({ result: { worktrees: options.orca?.worktrees ?? [] } }));
  put("orca.psfails", options.orcaPsFails ? "1" : "0");
  put("omp.mode", options.ompMode ?? "up");
  put("omp.usage", JSON.stringify(options.ompUsage ?? { reports: [] }));
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

/**
 * Holds a fake tool until the file named by ARK_FAKE_GATE exists (no variable: no wait). A tool
 * also has its own variable, ARK_FAKE_GATE_<TOOL> (`ARK_FAKE_GATE_ORCA`), which wins over the shared
 * one, so a test can release the tools one at a time. A separate loop, not part of `modeGate`,
 * because `omp` and `gh` have none. Bounded at 60 s so a test that never releases cannot hang the suite.
 */
export const fakeGateEnvironment = "ARK_FAKE_GATE";
type FakeTool = "orca" | "gh" | "omp" | "plannotator";
export const fakeToolGateEnvironment = (tool: FakeTool) => `ARK_FAKE_GATE_${tool.toUpperCase()}`;
const gateWaitFor = (
  tool: FakeTool,
) => `gate="\${${fakeToolGateEnvironment(tool)}:-\${ARK_FAKE_GATE:-}}"
waited=0
while [ -n "$gate" ] && [ ! -e "$gate" ] && [ "$waited" -lt 600 ]; do sleep 0.1; waited=$((waited + 1)); done`;

/** Shell scripts for the fake `orca`, `gh` and `plannotator`. None of them touches the network or a real tool. */
export function fakeToolScripts(state: string): {
  orca: string;
  gh: string;
  plannotator: string;
  omp: string;
} {
  return {
    orca: `echo "$*" >> '${state}/orca.log'
${gateWaitFor("orca")}
sleep "$(cat '${state}/orca.sleep')"
cmd=$(printf '%s %s' "$1" "$2" | tr -c 'a-z' '_')
# The hub's queue source reads task-list with --ready or --status: its own count, so it never uses up the agents' two answers.
case " $* " in *" --ready "*|*" --status "*) cmd="\${cmd}_queue" ;; esac
${modeGate(state, "orca", "$cmd")}
run=""; previous=""; for argument in "$@"; do [ "$previous" = --run ] && run="$argument"; previous="$argument"; done
case "$1 $2" in
  "terminal list") cat '${state}/orca.terminals' ;;
  "terminal switch") [ "$(cat '${state}/orca.switchfails')" = 1 ] && exit 1; echo '{"result":{}}' ;;
  "orchestration run-list") cat '${state}/orca.runs' ;;
  "orchestration worker-list") if [ -f "${state}/orca.workers.$run" ]; then cat "${state}/orca.workers.$run"; else cat '${state}/orca.workers'; fi ;;
  "orchestration task-list") cat '${state}/orca.tasks' ;;
  "orchestration inbox") case " $* " in *" --limit 200 "*) ;; *) [ "$(cat '${state}/orca.inboxfails')" = 1 ] && exit 1 ;; esac; cat '${state}/orca.inbox' ;;
  "worktree ps") [ "$(cat '${state}/orca.psfails')" = 1 ] && exit 1; cat '${state}/orca.ps' ;;
  *) exit 1 ;;
esac`,
    // `gh pr view` is the one call the hub makes: state, the checks, diff size and creation time.
    gh: `echo "$*" >> '${state}/gh.log'
${gateWaitFor("gh")}
case "$1 $2" in
  "pr view")
    if grep -qxF "$3" '${state}/gh.viewfailing'; then exit 1; fi
    key=$(printf '%s' "$3" | tr -c 'A-Za-z0-9' _)
    if [ -f "${state}/gh.view.$key" ]; then cat "${state}/gh.view.$key"; exit 0; fi
    if grep -qxF "$3" '${state}/gh.failing'; then cat '${state}/gh.fail'; else cat '${state}/gh.pass'; fi ;;
  *) exit 1 ;;
esac`,
    // Answers `usage --json` once, then exits 1 in mode `once` (counted in the state folder).
    omp: `[ "$1 $2" = "usage --json" ] || exit 1
${gateWaitFor("omp")}
mode=$(cat '${state}/omp.mode' 2>/dev/null || echo up)
[ "$mode" = down ] && exit 1
count=$(cat '${state}/omp.count' 2>/dev/null || echo 0)
count=$((count + 1))
printf '%s' "$count" > '${state}/omp.count'
[ "$mode" = once ] && [ "$count" -gt 1 ] && exit 1
cat '${state}/omp.usage'`,
    plannotator: `${gateWaitFor("plannotator")}
${modeGate(state, "plannotator", "sessions")}
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

/** One extra entry of a transcript fixture: a long text, or a tool call with its result (none: a call still running; no `id`: a record with no call id). */
export type ExtraEntry =
  | { kind: "user" | "assistant" | "thinking" | "context"; text: string }
  | {
      kind: "call";
      id?: string;
      /** Default: the harness's bash tool. */
      name?: string;
      args: Record<string, unknown>;
      /** Result text; undefined writes no result record. */
      result?: string;
      failed?: boolean;
      /** How a Codex output is written: `{output, metadata}` JSON (default) or the bare string. */
      codexOutput?: "json" | "plain";
    };

/** A text entry: omp has a `custom_message` for context, Claude and Codex show injected text as a user message. */
function extraTextRecord(
  harness: SessionHarness,
  timestamp: string,
  cwd: string,
  kind: "user" | "assistant" | "thinking" | "context",
  text: string,
): unknown {
  if (harness === "omp") {
    if (kind === "context") return { type: "custom_message", timestamp, content: text };
    const content =
      kind === "thinking" ? [{ type: "thinking", thinking: text }] : [{ type: "text", text }];
    return {
      type: "message",
      timestamp,
      message: { role: kind === "user" ? "user" : "assistant", content },
    };
  }
  const asUser = kind === "user" || kind === "context";
  if (harness === "claude")
    return {
      type: asUser ? "user" : "assistant",
      timestamp,
      cwd,
      message: {
        role: asUser ? "user" : "assistant",
        content: asUser
          ? text
          : [kind === "thinking" ? { type: "thinking", thinking: text } : { type: "text", text }],
      },
    };
  const payload =
    kind === "thinking"
      ? { type: "reasoning", summary: [{ type: "summary_text", text }] }
      : {
          type: "message",
          role: asUser ? "user" : "assistant",
          content: [{ type: asUser ? "input_text" : "output_text", text }],
        };
  return { timestamp, type: "response_item", payload };
}

/** The call record and, when the entry has a result, its result record. */
function extraCallRecords(
  harness: SessionHarness,
  callTimestamp: string,
  resultTimestamp: string,
  entry: Extract<ExtraEntry, { kind: "call" }>,
): unknown[] {
  const { id, args, result, failed } = entry;
  const hasResult = result !== undefined && id !== undefined;
  if (harness === "omp")
    return [
      {
        type: "message",
        timestamp: callTimestamp,
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id, name: entry.name ?? "bash", arguments: args }],
        },
      },
      ...(hasResult
        ? [
            {
              type: "message",
              timestamp: resultTimestamp,
              message: {
                role: "toolResult",
                toolCallId: id,
                isError: failed === true,
                content: [{ type: "text", text: result }],
              },
            },
          ]
        : []),
    ];
  if (harness === "claude")
    return [
      {
        type: "assistant",
        timestamp: callTimestamp,
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id, name: entry.name ?? "Bash", input: args }],
        },
      },
      ...(hasResult
        ? [
            {
              type: "user",
              timestamp: resultTimestamp,
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: id,
                    content: result,
                    is_error: failed === true,
                  },
                ],
              },
            },
          ]
        : []),
    ];
  const output =
    entry.codexOutput === "plain"
      ? result
      : JSON.stringify({ output: result, metadata: { exit_code: failed ? 1 : 0 } });
  return [
    {
      timestamp: callTimestamp,
      type: "response_item",
      payload: {
        type: "function_call",
        name: entry.name ?? "shell",
        call_id: id,
        arguments: JSON.stringify(args),
      },
    },
    ...(hasResult
      ? [
          {
            timestamp: resultTimestamp,
            type: "response_item",
            payload: { type: "function_call_output", call_id: id, output },
          },
        ]
      : []),
  ];
}

/**
 * One session file of the given harness, in the shape the real files have: a user message, a
 * thinking block, an assistant text, one tool call that succeeds and one that fails. Record `n`
 * is stamped `start + n` seconds; the first stamp is `start`, the cwd is in the head.
 */
export function transcriptText(
  harness: SessionHarness,
  options: {
    cwd: string;
    start: Date;
    tag?: string;
    /** Characters of an extra `padding` string field in the arguments of the first call. */
    argumentPadding?: number;
    /** Characters of padding appended to the user message. */
    messagePadding?: number;
    /** Characters of padding appended to the result of the first call, after its tail. */
    resultPadding?: number;
    /** Entries appended after the standard ones, in the shape of the harness (ARK-324: long texts, results of any size, a call with no id). */
    extra?: ExtraEntry[];
  },
): string {
  const { cwd, start } = options;
  const text = transcriptTexts(options.tag ?? harness);
  const extraArguments = options.argumentPadding
    ? { padding: "a".repeat(options.argumentPadding) }
    : {};
  const user = text.user + "u".repeat(options.messagePadding ?? 0);
  const at = (second: number) => iso(start, second);
  const okResult = `${text.okFirstLine}\nsecond line\n${text.tail}${"r".repeat(options.resultPadding ?? 0)}`;
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
      message(1, { role: "user", content: [{ type: "text", text: user }] }),
      message(2, {
        role: "assistant",
        content: [
          { type: "thinking", thinking: text.thinking },
          { type: "text", text: text.assistant },
          {
            type: "toolCall",
            id: "c1",
            name: "bash",
            arguments: { command: text.command, ...extraArguments },
          },
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
      record(0, "user", user),
      record(1, "assistant", [
        { type: "thinking", thinking: text.thinking },
        { type: "text", text: text.assistant },
        {
          type: "tool_use",
          id: "c1",
          name: "Bash",
          input: { command: text.command, ...extraArguments },
        },
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
        content: [{ type: "input_text", text: user }],
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
        arguments: JSON.stringify({ command: ["bash", "-lc", text.command], ...extraArguments }),
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
  const extraEntries = options.extra ?? [];
  const firstExtraSecond = 20;
  extraEntries.forEach((entry, position) => {
    const second = firstExtraSecond + position * 2;
    if (entry.kind !== "call") {
      records.push(extraTextRecord(harness, at(second), cwd, entry.kind, entry.text));
      return;
    }
    records.push(...extraCallRecords(harness, at(second), at(second + 1), entry));
  });
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

export type FixtureRoadmap = {
  vision?: string;
  /** `[id, name, outcome, state]`. Default: `M4` active. */
  milestones?: [string, string, string, string][];
  now?: string[];
  next?: string[];
  later?: string[];
};

/** Writes `$ARK_HOME/projects/<project>/ROADMAP.md` in the format of docs/reference/roadmap.md. */
export function writeRoadmap(project: string, roadmap: FixtureRoadmap = {}): void {
  const list = (title: string, ids: string[] = []) => [
    `## ${title}`,
    "",
    ...ids.map((id) => `- ${id}`),
    "",
  ];
  const milestones = roadmap.milestones ?? [
    ["M4", "Fixture milestone", "A fixture outcome.", "active"],
  ];
  const text = [
    "# Roadmap",
    "",
    "## Vision",
    "",
    roadmap.vision ?? "A fixture vision.",
    "",
    "## Milestones",
    "",
    "| id | name | outcome | state |",
    "| --- | --- | --- | --- |",
    ...milestones.map((row) => `| ${row.join(" | ")} |`),
    "",
    ...list("Now", roadmap.now),
    ...list("Next", roadmap.next),
    ...list("Later", roadmap.later),
  ].join("\n");
  writeFileSync(join(process.env.ARK_HOME as string, "projects", project, "ROADMAP.md"), text);
}

// ---------------------------------------------------------------- ARK-339: multi-repo runs

/**
 * Git repos at `<root>/<repo>`, each on the branch `branch` with `ahead` commits beyond its first commit
 * (`bases[repo]`). A repo with `gitlink` records a submodule pointer for `gitlink.pin` in that first commit, so
 * `git ls-tree HEAD <pin>` answers `gitlink.sha`. The caller writes the project config with `workspace: root`.
 */
export function writeRepoWorkspace(
  root: string,
  branch: string,
  repos: Record<string, { ahead: number; gitlink?: { pin: string; sha: string } }>,
): { bases: Record<string, string> } {
  const git = (repo: string, ...args: string[]) => {
    const done = spawnSync(
      "git",
      ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", ...args],
      { cwd: join(root, repo), encoding: "utf8" },
    );
    if (done.status !== 0) throw new Error(`git ${args.join(" ")} in ${repo}: ${done.stderr}`);
    return done.stdout.trim();
  };
  const bases: Record<string, string> = {};
  for (const [repo, { ahead, gitlink }] of Object.entries(repos)) {
    mkdirSync(join(root, repo), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "commit", "-q", "--allow-empty", "-m", "first");
    if (gitlink) {
      git(repo, "update-index", "--add", "--cacheinfo", `160000,${gitlink.sha},${gitlink.pin}`);
      git(repo, "commit", "-q", "-m", "pointer");
    }
    bases[repo] = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "-b", branch);
    for (let number = 0; number < ahead; number++)
      git(repo, "commit", "-q", "--allow-empty", "-m", `work ${number}`);
  }
  return { bases };
}

/** The sha that `writeRepoWorkspace` records for the submodule pointer of the fixture's web repo. */
export const submodulePointerSha = "0123456789abcdef0123456789abcdef01234567";

/**
 * A run over the repo chain core-lib -> service -> web (-> e2e with four repos). `service` depends on `core-lib` by
 * a package edge with the bump step `service-bump`, `web` on `service` by a submodule edge with `web-bump`, `e2e` on
 * `web` by a package edge with `e2e-bump`. The `why` of core-lib holds markup, which the page shows as text.
 * - `building`: no MR; `web-bump` is the running step, later steps wait. The run started 10 minutes ago.
 * - `mr`: every step done, one MR per repo (!11 core-lib, !12 service waits for !11, !13 web waits for !12,
 *   !14 e2e waits for !13), `service-bump` refreshed to `1.4.0`.
 * - `handed_off`: closed, every step done, no MR; the branches stay for a person.
 * `workspace` holds the repos (`writeRepoWorkspace`); each worktree is the repo itself on branch `branch`.
 */
export function repoRunFixture(options: {
  project: string;
  run: string;
  ticket: { id: string; title: string };
  repoCount: 3 | 4;
  mode: "building" | "mr" | "handed_off";
  workspace: string;
  branch: string;
  bases: Record<string, string>;
  /** The GitHub owner in the MR URLs (default `example`): a test that answers `gh pr view` per URL gives each run its own. */
  owner?: string;
  /** Two repos share the MR number `!12`, so a wait on `!12` is told apart by the repo (see `mergeRequests` below). */
  sameNumber?: boolean;
}): FixtureRun {
  const four = options.repoCount === 4;
  const model = "anthropic/claude-sonnet-5-5";
  const step = (
    id: string,
    role: string,
    repo: string,
    needs: string[],
    at: number,
  ): FixtureStep => ({ id, role, harness: "omp", model, needs, repo, startedAfter: at });
  const planned: FixtureStep[] = [
    step("core-impl", "implementer", "core-lib", [], 20),
    step("service-bump", "implementer", "service", ["core-impl"], 60),
    step("service-impl", "implementer", "service", ["service-bump"], 100),
    step("web-bump", "implementer", "web", ["service-impl"], 140),
    step("web-impl", "implementer", "web", ["web-bump"], 180),
    step("web-tests", "validator", "web", ["web-impl"], 220),
    ...(four
      ? [
          step("e2e-bump", "implementer", "e2e", ["web-tests"], 260),
          step("e2e-review", "reviewer", "e2e", ["e2e-bump"], 300),
        ]
      : []),
  ];
  // `building`: finished up to service-impl, web-bump runs. Otherwise every step is done.
  const doneUpTo = options.mode === "building" ? 3 : planned.length;
  const steps = planned.map((item, index) => ({
    ...item,
    ...(index < doneUpTo ? { finishedAfter: (item.startedAfter ?? 0) + 30 } : {}),
    ...(index > doneUpTo ? { startedAfter: undefined } : {}),
  }));
  const repoNames = four ? ["core-lib", "service", "web", "e2e"] : ["core-lib", "service", "web"];
  const edge = (repo: string, kind: string, pin: string, bump: string) => ({
    repo,
    kind,
    pin,
    evidence: `${pin}:1`,
    bump,
  });
  const repos = [
    // listed out of merge order on purpose: the page must show the order `repoGraph` gives
    ...(four
      ? [
          {
            repo: "e2e",
            why: "End-to-end suite",
            depends_on: [edge("web", "package", "@acme/web", "e2e-bump")],
          },
        ]
      : []),
    {
      repo: "web",
      why: "Web app that embeds the service",
      depends_on: [edge("service", "submodule", "vendor/service", "web-bump")],
    },
    {
      repo: "service",
      why: "Service that consumes the core",
      depends_on: [edge("core-lib", "package", "@acme/core", "service-bump")],
    },
    { repo: "core-lib", why: "Shared <b>core</b> types", depends_on: [] },
  ];
  // `sameNumber`: core-lib and service both own `!12` (numbers are per repo); service and web both wait for `!12`.
  const mergeRequests = repoNames.map((repo, index) => {
    const number = options.sameNumber ? [12, 12, 13, 14][index]! : 11 + index;
    return {
      repo,
      url: `https://github.com/${options.owner ?? "example"}/${repo}/pull/${number}`,
      number,
      order: index + 1,
      waits_for: index === 0 ? [] : [options.sameNumber ? 12 : 10 + index],
    };
  });
  return {
    project: options.project,
    run: options.run,
    ticket: options.ticket,
    phase:
      options.mode === "building"
        ? "building"
        : options.mode === "mr"
          ? "merge_requests_open"
          : "closed",
    startedAt: options.mode === "building" ? new Date(Date.now() - 600_000) : undefined,
    steps,
    repos,
    worktrees: repoNames.map((repo) => ({
      repo,
      path: join(options.workspace, repo),
      branch: options.branch,
      base: options.bases[repo],
    })),
    ...(options.mode === "mr"
      ? {
          mergeRequests: mergeRequests.slice(0, repoNames.length),
          bumpRefreshed: { "service-bump": "1.4.0" },
        }
      : {}),
    ...(options.mode === "handed_off" ? { outcome: "handed_off" as const } : {}),
  };
}

/** An `ark.yml` that loads for a workspace made by `writeRepoWorkspace` (its suite names the repo `core-lib`). */
export const repoProjectConfig = (workspace: string): Record<string, unknown> => ({
  workspace,
  ticket_source: "local",
  suites: [{ name: "unit", level: "unit", repo: "core-lib", command: "true", parser: "bun" }],
  roles: {
    implementer: { harness: "omp", model: "m" },
    validator: { harness: "omp", model: "m" },
    reviewer: { harness: "omp", model: "m" },
    chief: { harness: "claude", model: "claude-opus" },
  },
});
