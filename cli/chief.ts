import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { ArkError } from "./errors.ts";
import { deriveState, readEvents, type RunState } from "./events.ts";
import { exec, execJson } from "./hub/exec.ts";
import { retroUnanswered } from "./hub/ark.ts";
import { findLiveChief, readTerminals } from "./hub/orca.ts";
import { listProjects, runsDirectory } from "./paths.ts";

/** Orca can be slow to answer a list; the hub's 2 s reader limit is too short for a one-off command. */
const orcaTimeoutMilliseconds = 10_000;

type OrcaRunRow = { id: string; objective?: string; coordinator_handle?: string };
type WorkerRow = { dispatchId: string; agentTerminalHandle?: string };
type TaskRow = { id: string; task_title: string; status?: string };

const unavailable = (what: string): string => `unavailable: ${what} did not answer`;

function resolveProject(project: string | undefined): string {
  const chosen = project ?? process.env.ARK_PROJECT;
  if (!chosen)
    throw new ArkError("cannot tell the project: pass --project <name> or set ARK_PROJECT");
  if (!listProjects().includes(chosen)) throw new ArkError(`project ${chosen} does not exist`);
  return chosen;
}

const orcaOrchestration = async <T>(...args: string[]): Promise<T | null> =>
  (
    await execJson<{ result?: T }>(
      ["orca", "orchestration", ...args, "--json"],
      orcaTimeoutMilliseconds,
    )
  )?.result ?? null;

function table(headers: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n");
}

function readStates(project: string): RunState[] {
  const runsRoot = runsDirectory(project);
  if (!existsSync(runsRoot)) return [];
  return readdirSync(runsRoot)
    .sort()
    .map((name) => ({ directory: join(runsRoot, name), events: readEvents(join(runsRoot, name)) }))
    .filter(({ events }) => events.length > 0)
    .map(({ events }) => deriveState(events));
}

/** One Markdown section per live source. A source that fails says "unavailable"; it never reads as empty. */
export async function chiefState(inProject?: string): Promise<void> {
  const project = resolveProject(inProject);
  const config = loadConfig(project);
  const workspace = resolve(config.workspace);
  const states = readStates(project);
  const openRuns = states.filter((state) => state.phase !== "closed");
  const sections: string[] = [`# Chief state: ${project} (${new Date().toISOString()})`];

  sections.push(
    "## Open runs",
    openRuns.length === 0
      ? "none"
      : table(
          ["Run", "Phase", "Current step"],
          openRuns.map((state) => [state.run, state.phase, state.current_step ?? "-"]),
        ),
  );

  const orcaRuns = (await orcaOrchestration<{ runs?: OrcaRunRow[] }>("run-list"))?.runs;
  const chiefRunId = (orcaRuns ?? []).find(
    (orcaRun) => orcaRun.objective === `Master Chief: ${project} tickets`,
  )?.id;
  // A run lead is a worker in Master Chief's own Orca Run. It is the lead of the Ark run whose
  // Orca Run names the worker's terminal as its coordinator.
  const runOfLead = new Map(
    (orcaRuns ?? [])
      .filter((orcaRun) => orcaRun.objective?.startsWith("Ark run ") && orcaRun.coordinator_handle)
      .map((orcaRun) => [orcaRun.coordinator_handle!, orcaRun.objective!.slice("Ark run ".length)]),
  );
  const openRunNames = new Set(openRuns.map((state) => state.run));
  let leadsText = unavailable("`orca orchestration worker-list`");
  if (orcaRuns && chiefRunId) {
    const answer = await orcaOrchestration<{ workers?: WorkerRow[] }>(
      "worker-list",
      "--run",
      chiefRunId,
      "--include-remote",
    );
    if (answer) {
      const rows = (answer.workers ?? []).flatMap((worker) => {
        const run = runOfLead.get(worker.agentTerminalHandle ?? "");
        return run && openRunNames.has(run)
          ? [[run, worker.dispatchId, worker.agentTerminalHandle!]]
          : [];
      });
      leadsText = rows.length === 0 ? "none" : table(["Run", "Dispatch", "Terminal"], rows);
    }
  } else if (orcaRuns) leadsText = `unavailable: no Orca Run "Master Chief: ${project} tickets"`;
  sections.push("## Run leads", leadsText);

  // The queue is the set of Tasks in Master Chief's own Orca Run.
  let queueText = unavailable("`orca orchestration task-list`");
  if (orcaRuns && chiefRunId) {
    const [ready, pending] = await Promise.all([
      orcaOrchestration<{ tasks?: TaskRow[] }>("task-list", "--run", chiefRunId, "--ready"),
      orcaOrchestration<{ tasks?: TaskRow[] }>(
        "task-list",
        "--run",
        chiefRunId,
        "--status",
        "pending",
      ),
    ]);
    if (ready && pending) {
      const tasks = [
        ...(ready.tasks ?? []).map((task) => [task.id, "ready", task.task_title]),
        ...(pending.tasks ?? []).map((task) => [task.id, "pending", task.task_title]),
      ];
      queueText = tasks.length === 0 ? "none" : table(["Task", "Status", "Title"], tasks);
    }
  } else if (orcaRuns) queueText = `unavailable: no Orca Run "Master Chief: ${project} tickets"`;
  sections.push("## Queued Orca Tasks", queueText);

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
    `- concurrency: ${config.concurrency} (${openRuns.length} open)`,
  );

  const unanswered = states.filter(
    (state) => state.phase === "closed" && retroUnanswered(join(runsDirectory(project), state.run)),
  );
  sections.push(
    "## Closed runs with an empty Close check",
    unanswered.length === 0
      ? "none"
      : unanswered.map((state) => `- ${state.run} (${state.outcome ?? "unknown"})`).join("\n"),
  );

  const df = await exec(["df", "-k", "/"]);
  const availableKilobytes = Number(df?.trim().split("\n")[1]?.trim().split(/\s+/)[3]);
  sections.push(
    "## Disk",
    Number.isFinite(availableKilobytes)
      ? `- Free: ${Math.floor(availableKilobytes / 1024 / 1024)} GiB on \`/\``
      : "unavailable: `df -k /` failed",
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
      `Prerequisite missing: \`roles.chief\` (harness and model) is not set in \`${project}/ark.yml\`. Add it, for example \`chief: { harness: claude, model: claude-opus }\`, then run \`ark chief handover\` again.`,
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
