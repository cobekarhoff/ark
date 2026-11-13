import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendEvent } from "../cli/events";
import { ark, tempArkHome, tempGitRepo, writeProject } from "./helpers";

// ark chief keeps its process alive until the 10 s Orca reader timer fires, so each call takes about 10 s.
setDefaultTimeout(60_000);

const project = "demo";
const openRun = "2026-11-02-ARK-900-1";
const closedRun = "2026-11-01-ARK-899-1";

// Fake `orca`: logs every call's argv ($FAKE_ORCA_LOG, arguments joined by \x1f, calls ended by \x1e)
// and answers from $FAKE_ORCA_DIR/scenario.json written by setScenario. Like the real orca,
// `worker-list` shows only the Run named by --run, and `run-list` pages: 10 rows when --limit is
// absent, at most 100 with it, and a `nextCursor` (`c<offset>`) that --cursor continues.
// A shell script: a bun script starts too slowly.
const fakeOrca = `#!/bin/sh
# One append per call, so concurrent calls cannot interleave their records.
record=$(printf '%s\\037' "$@"; printf '\\036')
printf '%s' "$record" >> "$FAKE_ORCA_LOG"
d=$FAKE_ORCA_DIR
if [ -f "$d/fail" ]; then
  read -r only code < "$d/fail"
  if [ "$only" = all ] || [ "$only" = "$2" ]; then
    [ -f "$d/hang" ] && exec sleep 30
    [ -f "$d/stderr" ] && cat "$d/stderr" >&2
    exit "$code"
  fi
fi
case "$1 $2" in
  "orchestration run-list")
    limit=10; offset=0
    while [ $# -gt 0 ]; do
      case "$1" in
        --limit) limit=$2 ;;
        --cursor) offset=\${2#c} ;;
      esac
      shift
    done
    [ "$limit" -gt 100 ] && limit=100
    total=$(wc -l < "$d/runs.ndjson")
    rows=$(sed -n "$((offset + 1)),$((offset + limit))p" "$d/runs.ndjson" | paste -sd, -)
    next=$((offset + limit))
    if [ "$next" -lt "$total" ]; then next="\\"c$next\\""; else next=null; fi
    printf '{"result":{"runs":[%s],"nextCursor":%s}}\\n' "$rows" "$next" ;;
  "orchestration worker-list")
    while [ $# -gt 0 ]; do [ "$1" = --run ] && run=$2; shift; done
    cat "$d/workers-$run" 2>/dev/null || echo '{"result":{"workers":[]}}' ;;
  "orchestration task-list")
    case "$*" in *--ready*) cat "$d/ready" ;; *) cat "$d/pending" ;; esac ;;
  "terminal list") cat "$d/terminals" ;;
  "agent launch") cat "$d/launch" ;;
  *) exit 2 ;;
esac
`;

let fakeDirectory = "";
let logFile = "";
let workspace = "";
const originalPath = process.env.PATH;

type Scenario = {
  /** Makes `verb` (default every verb) exit `code` (default 1) after writing `stderr`; `hang` sleeps instead. */
  fail?: { verb?: string; code?: number; stderr?: string; hang?: boolean } | true;
  runs?: unknown[];
  /** Workers by Orca Run id. */
  workers?: Record<string, unknown[]>;
  ready?: unknown[];
  pending?: unknown[];
  terminals?: unknown[];
  launch?: unknown;
};

function setScenario(scenario: Scenario) {
  const reply = (name: string, result: unknown) =>
    writeFileSync(join(fakeDirectory, name), JSON.stringify({ result }));
  if (scenario.fail) {
    const fail = scenario.fail === true ? {} : scenario.fail;
    writeFileSync(join(fakeDirectory, "fail"), `${fail.verb ?? "all"} ${fail.code ?? 1}\n`);
    if (fail.stderr) writeFileSync(join(fakeDirectory, "stderr"), fail.stderr);
    if (fail.hang) writeFileSync(join(fakeDirectory, "hang"), "");
  }
  writeFileSync(
    join(fakeDirectory, "runs.ndjson"),
    (scenario.runs ?? []).map((row) => `${JSON.stringify(row)}\n`).join(""),
  );
  for (const [run, workers] of Object.entries(scenario.workers ?? {}))
    reply(`workers-${run}`, { workers });
  reply("ready", { tasks: scenario.ready ?? [] });
  reply("pending", { tasks: scenario.pending ?? [] });
  reply("terminals", { terminals: scenario.terminals ?? [] });
  reply("launch", { outcome: scenario.launch });
}

function orcaCalls(): string[][] {
  return existsSync(logFile)
    ? readFileSync(logFile, "utf8")
        .split("\x1e")
        .filter(Boolean)
        .map((call) => call.split("\x1f").slice(0, -1))
    : [];
}

const callsTo = (...words: string[]) =>
  orcaCalls().filter((argv) => words.every((word, index) => argv[index] === word));

/** The text of one `## ` section of the snapshot, up to the next section. */
function section(output: string, heading: string): string {
  const parts = output.split(/^## /m).find((part) => part.startsWith(heading));
  expect(parts).toBeDefined();
  return parts!;
}

beforeEach(() => {
  tempArkHome();
  fakeDirectory = mkdtempSync(join(tmpdir(), "ark-fake-orca-"));
  logFile = join(fakeDirectory, "calls.ndjson");
  const binary = join(fakeDirectory, "bin");
  mkdirSync(binary);
  writeFileSync(join(binary, "orca"), fakeOrca);
  chmodSync(join(binary, "orca"), 0o755);
  process.env.PATH = `${binary}:${originalPath}`;
  process.env.FAKE_ORCA_LOG = logFile;
  process.env.FAKE_ORCA_DIR = fakeDirectory;
  delete process.env.ARK_PROJECT;

  workspace = tempGitRepo();
  writeProject(project, {
    workspace,
    ticket_source: "local",
    suites: [{ name: "unit", level: "unit", repo: ".", command: "true", parser: "bun" }],
    roles: {
      implementer: { harness: "claude", model: "claude-sonnet" },
      validator: { harness: "codex", model: "gpt-codex" },
      reviewer: { harness: "codex", model: "gpt-codex" },
      chief: { harness: "claude", model: "claude-opus" },
    },
    concurrency: 3,
    gates: { plan: "auto", strategy: "auto" },
  });
  const runsRoot = join(process.env.ARK_HOME as string, "projects", project, "runs");
  for (const run of [openRun, closedRun]) {
    mkdirSync(join(runsRoot, run), { recursive: true });
    appendEvent(join(runsRoot, run), "run.started", {
      run,
      project,
      round_budget: 2,
      ticket: { id: run.slice(11, -2), title: `Ticket of ${run}` },
      criteria: [],
    });
  }
  appendEvent(join(runsRoot, closedRun), "run.closed", { outcome: "aborted" });
});

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.ARK_ORCA_TIMEOUT_MS;
});

const chiefOrcaRun = {
  id: "run_chief",
  objective: `Master Chief: ${project} tickets`,
  coordinator_handle: "term_chief",
};

/** A `worker-list --json` row as Orca returns it. A structured worker has no terminal handle and `unverifiable` liveness. */
const workerRow = (dispatchId: string, terminal: string, liveness: string, run: string) => ({
  dispatchId,
  taskId: `task_${dispatchId}`,
  terminal,
  liveness,
  workspace: `host_1::${join(process.env.ARK_HOME as string, "projects", project, "runs", run, "workspace")}`,
});

/** A `task-list --json` row as Orca returns it: the title is `title`. */
const taskRow = (id: string, status: string, title: string) => ({
  id,
  status,
  title,
  dispatchId: `ctx_${id}`,
  assignee: null,
});

test("ARK-T115 chief state prints each live source in one Markdown snapshot", () => {
  setScenario({
    runs: [
      chiefOrcaRun,
      { id: "run_ark", objective: `Ark run ${openRun}`, coordinator_handle: "term_lead" },
    ],
    workers: {
      // The run lead is a worker in Master Chief's own Run. The step worker is in the Ark run's Run.
      run_chief: [workerRow("ctx_lead", "term_lead", "live", openRun)],
      run_ark: [workerRow("ctx_step", "term_step", "live", openRun)],
    },
    ready: [taskRow("task_ready", "ready", "Ready ticket ARK-1")],
    pending: [taskRow("task_pending", "pending", "Pending ticket ARK-2")],
  });

  const result = ark("chief", "state", "--project", project);
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  const out = result.out;

  const statusLine = ark("status", "--project", project).out.trim();
  const [, phase, step] = statusLine.split(/\s{2,}/);
  const openRuns = section(out, "Open runs");
  expect(openRuns).toContain(openRun);
  expect(openRuns).toContain(phase!);
  expect(openRuns).toContain(step!);
  expect(openRuns).not.toContain(closedRun);

  const queue = section(out, "Queued Orca Tasks");
  expect(queue).toContain("Ready ticket ARK-1");
  expect(queue).toContain("Pending ticket ARK-2");

  const head = Bun.spawnSync(["git", "log", "-1", "--format=%h", "main"], { cwd: workspace })
    .stdout.toString()
    .trim();
  expect(out).toContain(head);
  expect(out).toMatch(/plan\W+auto/);
  expect(out).toMatch(/strategy\W+auto/);
  expect(out).toMatch(/concurrency\W+3/);
  expect(section(out, "Interview")).toMatch(/last interview: 1\s*$/);
  expect(section(out, "Host")).toMatch(/free disk: \d+ GB/);
  // Nothing is installed for this project: the refused launchctl and no plist both read as not installed.
  expect(section(out, "Services").match(/not installed/g)).toHaveLength(3);
});

test("ARK-T297 chief state prints the services block of ark services status, with the pid of a running one and the last log line", () => {
  setScenario({ runs: [chiefOrcaRun] });
  const home = mkdtempSync(join(tmpdir(), "ark-chief-services-home-"));
  const launchctl = join(home, "launchctl");
  // `list <label>` prints the real dict: a PID line only for the label with a pid file; exit 113 for an unknown one.
  writeFileSync(
    launchctl,
    `#!/bin/sh
[ "$1" = list ] || exit 0
[ -e "${home}/$2.loaded" ] || exit 113
printf '{\\n\\t"Label" = "%s";\\n' "$2"
[ -s "${home}/$2.loaded" ] && printf '\\t"PID" = %s;\\n' "$(cat "${home}/$2.loaded")"
printf '};\\n'
`,
  );
  chmodSync(launchctl, 0o755);
  const agents = join(home, "Library", "LaunchAgents");
  mkdirSync(agents, { recursive: true });
  const logs = join(process.env.ARK_HOME as string, "projects", project, "services");
  mkdirSync(logs, { recursive: true });
  for (const service of ["auto-merger", "temp-cleaner"])
    writeFileSync(join(agents, `dev.ark.${project}.${service}.plist`), "");
  writeFileSync(join(home, `dev.ark.${project}.auto-merger.loaded`), "");
  writeFileSync(join(home, `dev.ark.${project}.temp-cleaner.loaded`), "4242");
  writeFileSync(join(logs, "temp-cleaner.log"), "swept\nfree 31 GB\n\n");

  const previous = { HOME: process.env.HOME, ARK_LAUNCHCTL: process.env.ARK_LAUNCHCTL };
  process.env.HOME = home;
  process.env.ARK_LAUNCHCTL = launchctl;
  try {
    const state = ark("chief", "state", "--project", project);
    const status = ark("services", "status", "--project", project);
    expect(state.code, state.err).toBe(0);
    expect(status.code, status.err).toBe(0);
    expect(
      section(state.out, "Services")
        .replace(/^Services\s*/, "")
        .trim(),
    ).toBe(status.out.trim());
    expect(status.out).toMatch(/^auto-merger\s+loaded\s+pid -/m);
    expect(status.out).toMatch(/^temp-cleaner\s+running\s+pid 4242\s+last log: free 31 GB$/m);
    expect(status.out).toMatch(/^sweep\s+not installed$/m);
  } finally {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test("ARK-244-AC1 chief state lists the run lead from Master Chief's own Run, not step workers", () => {
  setScenario({
    runs: [
      chiefOrcaRun,
      { id: "run_ark", objective: `Ark run ${openRun}`, coordinator_handle: "term_lead" },
    ],
    workers: {
      run_chief: [
        workerRow("ctx_lead", "term_lead", "live", openRun),
        // A worker of Master Chief's Run that leads no open Ark run.
        workerRow("ctx_other", "term_other", "live", "2026-11-02-ARK-777-1"),
      ],
      run_ark: [workerRow("ctx_step", "term_step", "live", openRun)],
    },
  });

  const result = ark("chief", "state", "--project", project);
  expect(result.err).toBe("");
  expect(result.code).toBe(0);

  const leads = section(result.out, "Run leads");
  const leadRow = leads.split("\n").find((line) => line.includes("ctx_lead"));
  expect(leadRow).toBeDefined();
  expect(leadRow).toContain(openRun);
  expect(leadRow).toContain("term_lead");
  expect(leads).not.toContain("ctx_step");
  expect(leads).not.toContain("term_step");
  expect(leads).not.toContain("ctx_other");

  const workerLists = callsTo("orchestration", "worker-list");
  expect(workerLists.length).toBeGreaterThan(0);
  for (const argv of workerLists) expect(argv).toContain("--include-remote");
  expect(workerLists.map((argv) => argv[argv.indexOf("--run") + 1])).toEqual(
    workerLists.map(() => "run_chief"),
  );
});

function startOpenRun(run: string): void {
  const directory = join(process.env.ARK_HOME as string, "projects", project, "runs", run);
  mkdirSync(directory, { recursive: true });
  appendEvent(directory, "run.started", {
    run,
    project,
    round_budget: 2,
    ticket: { id: run.slice(11, -2), title: `Ticket of ${run}` },
    criteria: [],
  });
}

test("ARK-310-AC1 chief state lists a structured run lead with liveness unverifiable and a terminal lead, and notes only the run with no lead", () => {
  const terminalRun = "2026-11-02-ARK-901-1";
  const leadlessRun = "2026-11-02-ARK-902-1";
  startOpenRun(terminalRun);
  startOpenRun(leadlessRun);
  setScenario({
    runs: [
      chiefOrcaRun,
      // A structured lead has no terminal handle, so its Run names no coordinator_handle.
      { id: "run_structured", objective: `Ark run ${openRun}` },
      { id: "run_terminal", objective: `Ark run ${terminalRun}`, coordinator_handle: "term_lead" },
    ],
    workers: {
      run_chief: [
        workerRow("ctx_structured", "structworker_abc123", "unverifiable", openRun),
        workerRow("ctx_terminal", "term_lead", "live", terminalRun),
      ],
    },
  });

  const result = ark("chief", "state", "--project", project);
  expect(result.code).toBe(0);
  const leads = section(result.out, "Run leads");
  const structuredRow = leads.split("\n").find((line) => line.includes("ctx_structured"));
  expect(structuredRow).toBeDefined();
  expect(structuredRow).toContain(openRun);
  const terminalRow = leads.split("\n").find((line) => line.includes("ctx_terminal"));
  expect(terminalRow).toBeDefined();
  expect(terminalRow).toContain(terminalRun);
  const notes = leads.split("\n").filter((line) => line.includes("has no live run lead"));
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain(leadlessRun);
});

test("ARK-310-AC2 chief state prints the title of every row that task-list --json returns", () => {
  setScenario({
    runs: [chiefOrcaRun],
    ready: [
      taskRow("task_a", "ready", "ARK-1 run lead"),
      taskRow("task_b", "ready", "ARK-2 run lead"),
    ],
    pending: [taskRow("task_c", "pending", "ARK-3 run lead")],
  });

  const result = ark("chief", "state", "--project", project);
  expect(result.code).toBe(0);
  const rows = section(result.out, "Queued Orca Tasks")
    .split("\n")
    .filter((line) => line.startsWith("| task_"));
  expect(rows).toHaveLength(3);
  for (const [index, title] of ["ARK-1 run lead", "ARK-2 run lead", "ARK-3 run lead"].entries())
    expect(rows[index]!.split("|").map((cell) => cell.trim())).toContain(title);
});

test("ARK-244-AC1 chief state says unavailable for Orca sections and still prints the rest", () => {
  setScenario({ fail: true });

  const result = ark("chief", "state", "--project", project);
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  const out = result.out;

  expect(section(out, "Run leads")).toContain("unavailable");
  expect(section(out, "Run leads")).not.toMatch(/\bnone\b/);
  expect(section(out, "Queued Orca Tasks")).toContain("unavailable");
  expect(section(out, "Queued Orca Tasks")).not.toMatch(/\bnone\b/);
  expect(section(out, "Open runs")).toContain(openRun);
  const head = Bun.spawnSync(["git", "log", "-1", "--format=%h", "main"], { cwd: workspace })
    .stdout.toString()
    .trim();
  expect(out).toContain(head);
});

test("ARK-244-AC2 chief handover starts a new Master Chief in a terminal and prints its handle", () => {
  setScenario({
    runs: [chiefOrcaRun],
    terminals: [{ handle: "term_chief", worktreePath: workspace, connected: true }],
    launch: { kind: "terminal", handle: "term_new" },
  });

  const result = ark("chief", "handover", "--project", project);
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  expect(result.out.trim()).toBe("term_new");

  const launches = callsTo("agent", "launch");
  expect(launches).toHaveLength(1);
  const argv = launches[0]!;
  expect(argv[argv.indexOf("--surface") + 1]).toBe("terminal");
  const prompt = argv[argv.indexOf("--prompt") + 1]!;
  expect(prompt).toContain("term_chief");
  expect(prompt).toMatch(/wait/i);
  expect(prompt).toMatch(/exit/i);
  expect(prompt).toContain("run-use");
  expect(prompt).toContain("run_chief");
  expect(callsTo("terminal", "close")).toHaveLength(0);
});

test("ARK-244-AC2 chief handover refuses and starts nothing when no Master Chief is live", () => {
  setScenario({ runs: [chiefOrcaRun], terminals: [] });

  const result = ark("chief", "handover", "--project", project);
  expect(result.code).not.toBe(0);
  expect(result.err).toMatch(/no live Master Chief/i);
  expect(callsTo("agent", "launch")).toHaveLength(0);
});

const rowsPerPage = 100;

/** `count` Runs with the Master Chief Run at row `chiefRow` and the open Ark run just before it (1-based). */
function manyRuns(count: number, chiefRow: number | null) {
  return Array.from({ length: count }, (_, index) => {
    const row = index + 1;
    if (row === chiefRow) return chiefOrcaRun;
    if (row === (chiefRow ?? -1) - 1)
      return { id: "run_ark", objective: `Ark run ${openRun}`, coordinator_handle: "term_lead" };
    return { id: `run_filler_${row}`, objective: `Filler ${row}`, coordinator_handle: "term_x" };
  });
}

const leadScenario = (count: number, chiefRow: number | null): Scenario => ({
  runs: manyRuns(count, chiefRow),
  workers: {
    run_chief: [workerRow("ctx_lead", "term_lead", "live", openRun)],
  },
  ready: [taskRow("task_ready", "ready", "Ready ticket ARK-1")],
  pending: [taskRow("task_pending", "pending", "Pending ticket ARK-2")],
});

const runListPages = () => callsTo("orchestration", "run-list").length;

test("ARK-306-AC1 chief state finds the Master Chief Run at row 12 of 12 and row 205 of 230", () => {
  for (const [count, chiefRow, pages] of [
    [12, 12, 1],
    [230, 205, 3],
  ] as const) {
    setScenario(leadScenario(count, chiefRow));
    const before = runListPages();

    const result = ark("chief", "state", "--project", project);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);

    const leadRow = section(result.out, "Run leads")
      .split("\n")
      .find((line) => line.includes("ctx_lead"));
    expect(leadRow).toContain(openRun);
    const queue = section(result.out, "Queued Orca Tasks");
    expect(queue).toContain("Ready ticket ARK-1");
    expect(queue).toContain("Pending ticket ARK-2");
    expect(runListPages() - before).toBe(pages);
  }
});

test("ARK-306-AC2 chief handover and readTerminals find the live Master Chief at row 12 of 12 and 205 of 230", () => {
  for (const [count, chiefRow] of [
    [12, 12],
    [230, 205],
  ] as const) {
    setScenario({
      runs: manyRuns(count, chiefRow),
      terminals: [{ handle: "term_chief", worktreePath: workspace, connected: true }],
      launch: { kind: "terminal", handle: "term_new" },
    });

    const result = ark("chief", "handover", "--project", project);
    expect(result.err).toBe("");
    expect(result.out.trim()).toBe("term_new");

    // In a child process: Bun resolves `orca` with the PATH it started with, not the test's.
    const read = Bun.spawnSync(
      [
        "bun",
        "-e",
        `import { readTerminals } from "${join(import.meta.dir, "..", "cli", "orca.ts")}";
        const read = await readTerminals();
        console.log(JSON.stringify({ count: read?.runs.length, chief: read?.runs.some((run) => run.id === "run_chief") }));`,
      ],
      { env: process.env },
    );
    expect(JSON.parse(read.stdout.toString())).toEqual({ count, chief: true });
  }
});

test("ARK-306-AC2 the text --cursor is in exactly one file of cli/ and hub/", () => {
  const root = join(import.meta.dir, "..");
  const holders: string[] = [];
  for (const directory of ["cli", "hub"])
    for (const file of readdirSync(join(root, directory), { recursive: true, encoding: "utf8" })) {
      const path = join(root, directory, file);
      if (
        /\.(ts|tsx|js|jsx|css|html)$/.test(file) &&
        readFileSync(path, "utf8").includes("--cursor")
      )
        holders.push(join(directory, file));
    }
  expect(holders).toEqual([join("cli", "orca.ts")]);
});

const noRunListFailure = (out: string, reason: string) => {
  for (const heading of ["Run leads", "Queued Orca Tasks"]) {
    const text = section(out, heading);
    expect(text).toContain(`unavailable: orca orchestration run-list failed: ${reason}`);
    expect(text).not.toMatch(/\bnone\b/);
  }
};

test("ARK-306-AC3 a failing run-list names the first non-empty stderr line", () => {
  setScenario({ fail: { stderr: "\n  \nconnection refused\nsecond line\n", code: 4 } });
  const result = ark("chief", "state", "--project", project);
  expect(result.code).toBe(0);
  noRunListFailure(result.out, "connection refused");
  expect(result.out).not.toContain("second line");
  expect(section(result.out, "Open runs")).toContain(openRun);
});

test("ARK-306-AC3 a failing run-list with empty stderr names the exit code", () => {
  setScenario({ fail: { code: 3 } });
  noRunListFailure(ark("chief", "state", "--project", project).out, "exit 3");
});

test("ARK-306-AC3 a run-list that does not answer in time names the timeout", () => {
  process.env.ARK_ORCA_TIMEOUT_MS = "1000";
  setScenario({ fail: { hang: true } });
  noRunListFailure(ark("chief", "state", "--project", project).out, "timed out after 1 s");
});

test("ARK-306-AC3 a missing orca names orca not found on PATH", () => {
  setScenario({});
  process.env.PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
  noRunListFailure(ark("chief", "state", "--project", project).out, "orca not found on PATH");
});

test("ARK-306-AC3 a failing worker-list names itself and the other sections still print", () => {
  setScenario({ ...leadScenario(12, 12), fail: { verb: "worker-list", stderr: "no workers\n" } });
  const { out } = ark("chief", "state", "--project", project);
  const leads = section(out, "Run leads");
  expect(leads).toContain("unavailable: orca orchestration worker-list failed: no workers");
  expect(leads).not.toMatch(/\bnone\b/);
  expect(section(out, "Queued Orca Tasks")).toContain("Ready ticket ARK-1");
  expect(section(out, "Open runs")).toContain(openRun);
});

test("ARK-306-AC3 a failing task-list names itself and the other sections still print", () => {
  setScenario({ ...leadScenario(12, 12), fail: { verb: "task-list", code: 7 } });
  const { out } = ark("chief", "state", "--project", project);
  const queue = section(out, "Queued Orca Tasks");
  expect(queue).toContain("unavailable: orca orchestration task-list failed: exit 7");
  expect(queue).not.toMatch(/\bnone\b/);
  expect(section(out, "Run leads")).toContain("ctx_lead");
  expect(section(out, "Open runs")).toContain(openRun);
});

test("ARK-306-AC3 230 Runs without a Master Chief Run print the no Orca Run text, not none", () => {
  setScenario(leadScenario(230, null));
  const { out } = ark("chief", "state", "--project", project);
  expect(runListPages()).toBe(Math.ceil(230 / rowsPerPage));
  for (const heading of ["Run leads", "Queued Orca Tasks"]) {
    const text = section(out, heading);
    expect(text).toContain(`unavailable: no Orca Run "Master Chief: ${project} tickets"`);
    expect(text).not.toMatch(/\bnone\b/);
  }
});

test("ARK-306-AC5 the ARK-244 chief tests and the releaseSettledWorkers tests are present", () => {
  const chief = readFileSync(join(import.meta.dir, "chief.test.ts"), "utf8");
  const run = readFileSync(join(import.meta.dir, "run.test.ts"), "utf8");
  expect(chief).toMatch(/^test\("ARK-244-AC1 /m);
  expect(chief).toMatch(/^test\("ARK-244-AC2 /m);
  expect(run).toMatch(/^test\("ARK-278-AC1 run close releases/m);
});

const day = 86_400_000;
const baseTime = Date.parse("2026-10-01T00:00:00Z");

/** Closes a fresh run at `baseTime + days` (the event time is set by the fixture clock, not by the code under test). */
function closeRunAt(runsRoot: string, name: string, days: number) {
  const directory = join(runsRoot, name);
  mkdirSync(directory, { recursive: true });
  process.env.ARK_NOW = new Date(baseTime + days * day).toISOString();
  try {
    appendEvent(directory, "run.started", {
      run: name,
      project,
      round_budget: 2,
      ticket: { id: name.slice(11, -2), title: `Ticket of ${name}` },
      criteria: [],
    });
    appendEvent(directory, "run.closed", { outcome: "aborted" });
  } finally {
    delete process.env.ARK_NOW;
  }
  writeFileSync(join(directory, "retro.md"), "# Retro\n\n## Close check\n\n- Biggest pain:\n");
}

function range(length: number, start: number): number[] {
  return Array.from({ length }, (_, index) => start + index);
}

// Days after baseTime. An interview file is stamped half a day after its day, so a run closed on that day is before it.
const interviewCases: {
  id: string;
  files: number[] | null;
  closedDays: number[];
  count: number;
  due: boolean;
}[] = [
  { id: "D1", files: null, closedDays: range(10, 1), count: 10, due: true },
  { id: "D2", files: null, closedDays: range(9, 1), count: 9, due: false },
  { id: "D3", files: [], closedDays: range(10, 1), count: 10, due: true },
  { id: "D4", files: [20], closedDays: [...range(4, 1), ...range(10, 21)], count: 10, due: true },
  { id: "D5", files: [20], closedDays: [...range(10, 1), ...range(9, 21)], count: 9, due: false },
  {
    id: "D6",
    files: [10, 20],
    closedDays: [...range(10, 11), ...range(3, 21)],
    count: 3,
    due: false,
  },
];

for (const { id, files, closedDays, count, due } of interviewCases) {
  test(`ARK-T110 ${id} ark chief state has no close-check section and flags an interview due at 10 closed runs since the newest interview file`, () => {
    const projectRoot = join(process.env.ARK_HOME as string, "projects", project);
    const runsRoot = join(projectRoot, "runs");
    rmSync(join(runsRoot, closedRun), { recursive: true });
    closedDays.forEach((days, index) =>
      closeRunAt(runsRoot, `2026-10-01-ARK-${100 + index}-1`, days),
    );
    if (files !== null) {
      const interviews = join(projectRoot, "interviews");
      mkdirSync(interviews);
      files.forEach((days, index) => {
        const file = join(interviews, `interview-${index}.md`);
        writeFileSync(file, "# Interview\n");
        const seconds = (baseTime + days * day + day / 2) / 1000;
        utimesSync(file, seconds, seconds);
      });
    }
    setScenario({});

    const result = ark("chief", "state", "--project", project);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(result.out).not.toContain("Close check");

    const openRuns = section(result.out, "Open runs");
    expect(openRuns).toContain(openRun);
    expect(openRuns).not.toContain("ARK-10");
    expect(section(result.out, "Interview")).toMatch(
      new RegExp(`interview: ${count}${due ? " \\(due\\)" : ""}\\s*$`),
    );
  });
}
