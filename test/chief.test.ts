import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent } from "../cli/events";
import { ark, tempArkHome, tempGitRepo, writeProject } from "./helpers";

// ark chief keeps its process alive until the 10 s Orca reader timer fires, so each call takes about 10 s.
setDefaultTimeout(60_000);

const project = "demo";
const openRun = "2026-11-02-ARK-900-1";
const closedRun = "2026-11-01-ARK-899-1";

// Fake `orca`: logs every call's argv ($FAKE_ORCA_LOG, arguments joined by \x1f, calls ended by \x1e)
// and answers from $FAKE_ORCA_DIR/scenario.json written by setScenario. Like the real orca,
// `worker-list` shows only the Run named by --run. A shell script: a bun script starts too slowly.
const fakeOrca = `#!/bin/sh
printf '%s\\037' "$@" >> "$FAKE_ORCA_LOG"
printf '\\036' >> "$FAKE_ORCA_LOG"
d=$FAKE_ORCA_DIR
[ -f "$d/fail" ] && exit 1
case "$1 $2" in
  "orchestration run-list") cat "$d/run-list" ;;
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
  fail?: boolean;
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
  if (scenario.fail) writeFileSync(join(fakeDirectory, "fail"), "");
  reply("run-list", { runs: scenario.runs ?? [] });
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
  writeFileSync(
    join(runsRoot, closedRun, "retro.md"),
    "# Retro\n\n## Close check\n\n- Biggest pain:\n- Change now:\n- Surprise:\n",
  );
});

afterEach(() => {
  process.env.PATH = originalPath;
});

const chiefOrcaRun = {
  id: "run_chief",
  objective: `Master Chief: ${project} tickets`,
  coordinator_handle: "term_chief",
};

test("ARK-244-AC1 chief state prints each live source in one Markdown snapshot", () => {
  setScenario({
    runs: [
      chiefOrcaRun,
      { id: "run_ark", objective: `Ark run ${openRun}`, coordinator_handle: "term_lead" },
    ],
    workers: {
      // The run lead is a worker in Master Chief's own Run. The step worker is in the Ark run's Run.
      run_chief: [{ dispatchId: "ctx_lead", runId: "run_chief", agentTerminalHandle: "term_lead" }],
      run_ark: [{ dispatchId: "ctx_step", runId: "run_ark", agentTerminalHandle: "term_step" }],
    },
    ready: [{ id: "task_ready", task_title: "Ready ticket ARK-1", status: "ready" }],
    pending: [{ id: "task_pending", task_title: "Pending ticket ARK-2", status: "pending" }],
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
  expect(section(out, "Closed runs with an empty Close check")).toContain(closedRun);
  expect(section(out, "Disk")).toMatch(/\d+ GiB/);
});

test("ARK-244-AC1 chief state lists the run lead from Master Chief's own Run, not step workers", () => {
  setScenario({
    runs: [
      chiefOrcaRun,
      { id: "run_ark", objective: `Ark run ${openRun}`, coordinator_handle: "term_lead" },
    ],
    workers: {
      run_chief: [
        { dispatchId: "ctx_lead", runId: "run_chief", agentTerminalHandle: "term_lead" },
        // A worker of Master Chief's Run that leads no open Ark run.
        { dispatchId: "ctx_other", runId: "run_chief", agentTerminalHandle: "term_other" },
      ],
      run_ark: [{ dispatchId: "ctx_step", runId: "run_ark", agentTerminalHandle: "term_step" }],
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
