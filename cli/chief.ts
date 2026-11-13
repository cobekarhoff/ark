import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { ArkError } from "./errors.ts";
import { deriveState, readEvents, type RunState } from "./events.ts";
import { exec, execJson } from "./exec.ts";
import {
  findChiefRun,
  findLiveChief,
  orcaPages,
  orcaTimeoutMilliseconds,
  readChiefTasks,
  readTerminals,
} from "./orca.ts";
import { cpus } from "node:os";
import { holdReasons, readHost } from "./host.ts";
import { servicesStatusText } from "./services.ts";
import { readTestLock } from "./test-lock.ts";
import { projectDirectory, resolveProject, runsDirectory } from "./paths.ts";

type OrcaRunRow = { id: string; objective?: string; coordinator_handle?: string };
/** A `worker-list --json` row. A structured worker has `liveness: "unverifiable"` and no terminal handle; its `workspace` is `<host>::<run folder>/workspace`. */
type WorkerRow = { dispatchId: string; terminal?: string; workspace?: string };

const unavailable = (verb: string, reason: string): string =>
  `unavailable: orca orchestration ${verb} failed: ${reason}`;

function table(headers: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n");
}

/** Each readable run's state and, when closed, the time of its `run.closed` event in milliseconds; the names of the runs whose events cannot be read. */
function readStates(project: string): {
  runs: { state: RunState; closedAt: number | null }[];
  unreadable: string[];
} {
  const runsRoot = runsDirectory(project);
  const runs: { state: RunState; closedAt: number | null }[] = [];
  const unreadable: string[] = [];
  if (!existsSync(runsRoot)) return { runs, unreadable };
  for (const name of readdirSync(runsRoot).sort()) {
    try {
      const events = readEvents(join(runsRoot, name));
      if (events.length === 0) continue;
      const closed = events.findLast((event) => event.type === "run.closed");
      runs.push({ state: deriveState(events), closedAt: closed ? Date.parse(closed.time) : null });
    } catch {
      unreadable.push(name);
    }
  }
  return { runs, unreadable };
}

function elapsed(since: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
}

/** One Markdown section per live source. A source that fails says "unavailable"; it never reads as empty. */
export async function chiefState(inProject?: string): Promise<void> {
  const project = resolveProject(inProject);
  const config = loadConfig(project);
  const workspace = resolve(config.workspace);
  const { runs, unreadable } = readStates(project);
  const openRuns = runs.map(({ state }) => state).filter((state) => state.phase !== "closed");
  const sections: string[] = [`# Chief state: ${project} (${new Date().toISOString()})`];

  sections.push(
    "## Open runs",
    [
      openRuns.length === 0 && unreadable.length === 0 ? "none" : "",
      openRuns.length > 0
        ? table(
            ["Run", "Phase", "Current step"],
            openRuns.map((state) => [state.run, state.phase, state.current_step ?? "-"]),
          )
        : "",
      unreadable.length > 0 ? `unavailable: events of ${unreadable.join(", ")} cannot be read` : "",
    ]
      .filter((part) => part !== "")
      .join("\n\n"),
  );

  // Open runs only. A run's last full test.completed decides: a file it no longer records is gone from here.
  const redRows = openRuns.flatMap((state) => state.red_on_main.map((file) => [state.run, file]));
  sections.push(
    "## Red on main",
    [
      redRows.length === 0 && unreadable.length === 0 ? "none" : "",
      redRows.length > 0 ? table(["Run", "File"], redRows) : "",
      unreadable.length > 0 ? `unavailable: events of ${unreadable.join(", ")} cannot be read` : "",
    ]
      .filter((part) => part !== "")
      .join("\n\n"),
  );

  // The budget is host-wide: it names runs of every project.
  const { running, waiting } = readTestLock();
  if (running.length > 0 || waiting.length > 0)
    sections.push(
      "## ark test budget",
      [
        ...running.map(
          (ticket) =>
            `- running: ${ticket.run} (pid ${ticket.pid}), ${ticket.cores} cores, running ${elapsed(ticket.started!)}`,
        ),
        ...waiting.map(
          (ticket) =>
            `- waiting: ${ticket.run} (pid ${ticket.pid}), ${ticket.cores} cores, waited ${elapsed(ticket.arrival)}`,
        ),
      ].join("\n"),
    );

  // `--full` keeps coordinator_handle, which the concise rows lack.
  const orcaRuns = await orcaPages<OrcaRunRow>(
    "run-list",
    "runs",
    ["--full"],
    orcaTimeoutMilliseconds,
  );
  const chiefRun = orcaRuns.ok ? findChiefRun(project, orcaRuns.value) : null;
  const chiefRunId = chiefRun?.ok ? chiefRun.value : undefined;
  const noChiefRun = `unavailable: ${chiefRun && !chiefRun.ok ? chiefRun.reason : ""}`;
  // A run lead is a worker in Master Chief's own Orca Run. It is the lead of the Ark run whose
  // Orca Run names the worker's terminal as its coordinator.
  const runOfLead = new Map(
    (orcaRuns.ok ? orcaRuns.value : [])
      .filter((orcaRun) => orcaRun.objective?.startsWith("Ark run ") && orcaRun.coordinator_handle)
      .map((orcaRun) => [orcaRun.coordinator_handle!, orcaRun.objective!.slice("Ark run ".length)]),
  );
  const openRunNames = new Set(openRuns.map((state) => state.run));
  let leadsText = noChiefRun;
  let queueText = noChiefRun;
  if (!orcaRuns.ok) {
    leadsText = queueText = unavailable("run-list", orcaRuns.reason);
  } else if (chiefRunId) {
    const [workers, tasks] = await Promise.all([
      orcaPages<WorkerRow>(
        "worker-list",
        "workers",
        ["--run", chiefRunId, "--terminal-state", "active", "--include-remote"],
        orcaTimeoutMilliseconds,
      ),
      readChiefTasks(chiefRunId, orcaTimeoutMilliseconds),
    ]);
    if (workers.ok) {
      const rows = workers.value.flatMap((worker) => {
        const run =
          runOfLead.get(worker.terminal ?? "") ??
          worker.workspace?.match(/\/runs\/([^/]+)\/workspace$/)?.[1];
        return run && openRunNames.has(run)
          ? [[run, worker.dispatchId, worker.terminal ?? "-"]]
          : [];
      });
      const leadless = openRuns.filter((state) => !rows.some((row) => row[0] === state.run));
      leadsText =
        [
          rows.length === 0 ? "" : table(["Run", "Dispatch", "Terminal"], rows),
          ...leadless.map((state) => `Note: open run ${state.run} has no live run lead.`),
          ...unreadable.map(
            (run) => `Note: run ${run} cannot be read, so its run lead cannot be matched.`,
          ),
        ]
          .filter(Boolean)
          .join("\n\n") || "none";
    } else leadsText = unavailable("worker-list", workers.reason);
    if (!tasks.ok) queueText = `unavailable: ${tasks.reason}`;
    else
      queueText =
        tasks.value.length === 0
          ? "none"
          : table(
              ["Task", "Status", "Title"],
              tasks.value.map((task) => [task.id, task.status, task.title]),
            );
  }
  sections.push("## Run leads", leadsText, "## Queued Orca Tasks", queueText);

  const head = await exec(["git", "-C", workspace, "log", "-1", "--format=%h %s", "main"]);
  sections.push(
    "## Workspace main",
    head === null
      ? `unavailable: \`git log main\` failed in ${workspace}`
      : `- Head: ${head.trim()}`,
  );

  sections.push(
    "## Config",
    `- gates: ${Object.entries(config.gates)
      .map(([gate, answerer]) => `${gate}: ${answerer}`)
      .join(", ")}`,
    `- concurrency: ${config.concurrency} (${openRuns.length} open${unreadable.length > 0 ? `, ${unreadable.length} unreadable: ${unreadable.join(", ")}` : ""})`,
  );

  sections.push("## Services", servicesStatusText(project));

  const interviews = join(projectDirectory(project), "interviews");
  const lastInterview = existsSync(interviews)
    ? Math.max(
        0,
        ...readdirSync(interviews).map((name) => statSync(join(interviews, name)).mtimeMs),
      )
    : 0;
  const sinceInterview = runs.filter(
    ({ state, closedAt }) => state.phase === "closed" && (closedAt ?? 0) > lastInterview,
  ).length;
  const interviewCount =
    unreadable.length > 0
      ? `unavailable: events of ${unreadable.join(", ")} cannot be read`
      : `${sinceInterview}${sinceInterview >= 10 ? " (due)" : ""}`;
  sections.push("## Interview", `- Closed runs since the last interview: ${interviewCount}`);

  const host = await readHost();
  const reasons = holdReasons(host, {
    minimumFreePercent: config.test_min_free_memory_percent,
    maximumSwapGigabytes: config.test_max_swap_gb,
    cores: cpus().length,
  });
  const reading = <value>(value: value | null, show: (value: value) => string) =>
    value === null ? "unavailable" : show(value);
  sections.push(
    "## Host",
    [
      `free memory: ${reading(host.freeMemoryPercent, (percent) => `${percent}%`)}`,
      `swap used: ${reading(host.swapUsedGigabytes, (used) => `${used.toFixed(1)} GB of ${host.swapTotalGigabytes?.toFixed(1) ?? "unavailable"} GB`)}`,
      `load (5 min): ${reading(host.load, (load) => load.toFixed(1))}`,
      `free disk: ${reading(host.freeDiskGigabytes, (gigabytes) => `${gigabytes} GB`)}`,
      `tests: running ${running.length}, waiting ${waiting.length}`,
      `hold new runs: ${reasons.length === 0 ? "no" : reasons.join("; ")}`,
    ].join("\n"),
  );

  console.log(sections.join("\n\n"));
}

/**
 * Starts a new Master Chief in a new Orca terminal and prints its handle. It never closes the old
 * terminal: chief.md tells the old Master Chief to do that after this command returns.
 */
export async function chiefHandover(inProject?: string): Promise<void> {
  const project = resolveProject(inProject);
  const chief = loadConfig(project).roles.chief;
  if (!chief)
    throw new ArkError(
      `Prerequisite missing: \`roles.chief\` (harness and model) is not set in \`${project}/ark.yml\`. Add it, for example \`chief: { harness: omp, model: anthropic/claude-sonnet-5-5 }\`, then run \`ark chief handover\` again.`,
    );
  const workspace = resolve(loadConfig(project).workspace);
  const snapshot = await readTerminals();
  if (!snapshot) throw new ArkError("Orca did not answer. Nothing started.");
  const oldChief = findLiveChief(snapshot, project, workspace);
  const objective = `Master Chief: ${project} tickets`;
  const chiefRun = snapshot.runs.find((orcaRun) => orcaRun.objective === objective);
  if (!oldChief || !chiefRun)
    throw new ArkError(
      `No live Master Chief for project ${project}: no terminal found for the Run "${objective}". Nothing started.`,
    );
  const prompt = [
    `You are the new Master Chief for project ${project}. Run /skill:ark chief.`,
    `You replace the Master Chief in terminal ${oldChief.handle}. That terminal is still running. Do not act on any run, ticket or gate yet.`,
    `1. Wait for that terminal to exit. Poll \`orca terminal list --json\` every 10 seconds until the handle ${oldChief.handle} is gone or shows as disconnected. If it is still listed after 10 minutes, ask the human what to do.`,
    `2. Bind this terminal to the existing Master Chief Run: \`orca orchestration run-use --id ${chiefRun.id}\`. If that Run is not found, find it by the objective "${objective}" and follow chief.md section 2 for a dead handle. Do not create another Run.`,
    `3. Run \`ark chief state --project ${project}\` and work from that output. Read \`handoff.md\` for standing rules only.`,
  ].join("\n\n");
  const launched = await execJson<{ result?: { outcome?: { kind?: string; handle?: string } } }>(
    [
      "orca",
      "agent",
      "launch",
      "--agent",
      chief.harness,
      "--model",
      chief.model,
      "--worktree",
      `path:${workspace}`,
      "--surface",
      "terminal",
      "--prompt",
      prompt,
      "--json",
    ],
    orcaTimeoutMilliseconds,
  );
  const outcome = launched?.result?.outcome;
  if (outcome?.kind !== "terminal" || !outcome.handle)
    throw new ArkError("`orca agent launch --surface terminal` gave no terminal handle");
  console.log(outcome.handle);
}
