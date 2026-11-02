import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execJson } from "../cli/exec.ts";
import { deriveState, readEvents, type ArkEvent, type RunState } from "../cli/events.ts";
import { orcaOrchestration, type OrcaRun, type OrcaTerminal } from "../cli/orca.ts";
import { listProjects, projectDirectory, runsDirectory } from "../cli/paths.ts";
import { loadPlan, type PlanStep } from "../cli/plan.ts";
import { stepWindows, type StepWindow } from "../cli/retro.ts";
import type { Agent, TicketView } from "./types.ts";

/** Each reader is given a hard timeout, so a hung tool delays its own source and nothing else. */
const githubTimeoutMilliseconds = 10_000;

// ---------------------------------------------------------------- Ark files

export type ArkRun = {
  directory: string;
  state: RunState;
  events: ArkEvent[];
  plan: PlanStep[] | null;
  windows: StepWindow[];
};
export type ArkValue = { runs: ArkRun[]; tickets: TicketView[] };

export const signatureOf = (file: string): string | null => {
  try {
    const stat = statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
};

/**
 * Reads Ark's files again only where a file changed (size and mtime). A run whose log is being
 * written at this moment can end on a half line: that run keeps its last good value.
 */
export function createArkReader() {
  const runCache = new Map<string, { signature: string; run: ArkRun }>();
  const ticketCache = new Map<string, { signature: string; ticket: TicketView | null }>();

  function readRun(directory: string): ArkRun | null {
    const log = join(directory, "events.ndjson");
    const logSignature = signatureOf(log);
    if (logSignature === null) return null;
    const signature = `${logSignature}|${signatureOf(join(directory, "plan.yml"))}`;
    const known = runCache.get(directory);
    if (known?.signature === signature) return known.run;
    try {
      const events = readEvents(directory);
      if (events.length === 0) return null;
      let plan: PlanStep[] | null = null;
      try {
        plan = loadPlan(directory).steps;
      } catch {
        // No plan yet, or one that does not parse: the run has no plan to draw.
      }
      const run = {
        directory,
        state: deriveState(events),
        events,
        plan,
        windows: stepWindows(events),
      };
      runCache.set(directory, { signature, run });
      return run;
    } catch {
      return known?.run ?? null;
    }
  }

  function readTicket(project: string, file: string, name: string): TicketView | null {
    const signature = signatureOf(file);
    if (signature === null) return null;
    const known = ticketCache.get(file);
    if (known?.signature === signature) return known.ticket;
    const unreadable: TicketView = {
      project,
      id: name.replace(/\.md$/, ""),
      title: null,
      status: "unreadable",
      milestone: null,
      depends_on: [],
    };
    let ticket = unreadable;
    try {
      const match = readFileSync(file, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const fields = match ? (Bun.YAML.parse(match[1]) as Record<string, unknown> | null) : null;
      if (fields && typeof fields.id === "string" && typeof fields.title === "string") {
        ticket = {
          project,
          id: fields.id,
          title: fields.title,
          status: typeof fields.status === "string" ? fields.status : "unknown",
          milestone: typeof fields.milestone === "string" ? fields.milestone : null,
          depends_on: Array.isArray(fields.depends_on) ? fields.depends_on.map(String) : [],
        };
      }
    } catch {
      // A ticket file that does not parse shows as unreadable and hides no other ticket.
    }
    ticketCache.set(file, { signature, ticket });
    return ticket;
  }

  return {
    /** Every run (open and closed, newest first) and every ticket of every project. */
    read(): ArkValue {
      const runs: ArkRun[] = [];
      const tickets: TicketView[] = [];
      for (const project of listProjects()) {
        const runsRoot = runsDirectory(project);
        if (existsSync(runsRoot)) {
          for (const name of readdirSync(runsRoot)) {
            const run = readRun(join(runsRoot, name));
            if (run) runs.push(run);
          }
        }
        const ticketsRoot = join(projectDirectory(project), "tickets");
        if (existsSync(ticketsRoot)) {
          for (const name of readdirSync(ticketsRoot).sort()) {
            if (!name.endsWith(".md")) continue;
            const ticket = readTicket(project, join(ticketsRoot, name), name);
            if (ticket) tickets.push(ticket);
          }
        }
      }
      runs.sort((left, right) =>
        right.state.run.localeCompare(left.state.run, undefined, { numeric: true }),
      );
      return { runs, tickets };
    },
    /** Folders to watch: each run folder (events.ndjson, plan.yml), the runs roots and the tickets folders. */
    watchPaths(): string[] {
      const paths: string[] = [];
      for (const project of listProjects()) {
        const runsRoot = runsDirectory(project);
        const ticketsRoot = join(projectDirectory(project), "tickets");
        for (const root of [runsRoot, ticketsRoot]) if (existsSync(root)) paths.push(root);
        if (existsSync(runsRoot))
          for (const name of readdirSync(runsRoot)) paths.push(join(runsRoot, name));
      }
      return paths;
    },
  };
}

// ---------------------------------------------------------------- Orca

export type OrcaValue = { agents: Map<string, Agent[]> };

type OrcaWorker = {
  taskId?: string;
  state?: string;
  liveness?: string;
  terminal?: string;
  agentTerminalHandle?: string;
  projection?: { provider?: { model?: string }; liveness?: { verdict?: string } };
};
type OrcaTask = { id: string; title?: string; task_title?: string };
type OrcaTerminalFull = OrcaTerminal & { agentIdentity?: string; model?: string };

const finishedWorkerStates = ["succeeded", "failed", "stopped", "cancelled", "released"];
const deadVerdicts = ["exited", "dead"];

/** `hub-server (implementer, .)` is a step task and `evaluator (<run>)` a stage task: both name the role. */
function roleOfTask(title: string | undefined): string {
  const step = title?.match(/\((implementer|validator|reviewer),/);
  return step?.[1] ?? title?.match(/^(\w+) \(/)?.[1] ?? "worker";
}

/**
 * The live agents of each open Ark run. Three Orca commands feed it: `terminal list`, `run-list`,
 * and per open run `worker-list` and `task-list`. Null when `run-list` or `terminal list` fails
 * (a failure of `worker-list` or `task-list` for one run drops that run, never invents agents).
 */
export async function readOrca(openRuns: string[]): Promise<OrcaValue | null> {
  const [runList, terminalList] = await Promise.all([
    orcaOrchestration<{ runs?: OrcaRun[] }>("run-list"),
    execJson<{ result?: { terminals?: OrcaTerminalFull[] } }>([
      "orca",
      "terminal",
      "list",
      "--json",
    ]),
  ]);
  const terminals = terminalList?.result?.terminals;
  if (!runList || !terminals) return null;
  const byHandle = new Map(terminals.map((terminal) => [terminal.handle, terminal]));
  const leadOf = new Map(
    (runList.runs ?? [])
      .filter((orcaRun) => orcaRun.objective?.startsWith("Ark run "))
      .map((orcaRun) => [orcaRun.objective!.slice("Ark run ".length), orcaRun]),
  );
  const agents = new Map<string, Agent[]>();
  let failed = false;
  await Promise.all(
    openRuns.map(async (run) => {
      const orcaRun = leadOf.get(run);
      if (!orcaRun) return;
      const [workers, tasks] = await Promise.all([
        orcaOrchestration<{ workers?: OrcaWorker[] }>(
          "worker-list",
          "--run",
          orcaRun.id,
          "--include-remote",
        ),
        orcaOrchestration<{ tasks?: OrcaTask[] }>("task-list", "--run", orcaRun.id),
      ]);
      if (!workers || !tasks) {
        failed = true;
        return;
      }
      const titles = new Map(
        (tasks.tasks ?? []).map((task) => [task.id, task.title ?? task.task_title]),
      );
      const list: Agent[] = [];
      const lead = orcaRun.coordinator_handle
        ? byHandle.get(orcaRun.coordinator_handle)
        : undefined;
      if (lead?.connected)
        list.push({
          role: "run lead",
          harness: lead.agentIdentity ?? null,
          model: lead.model ?? null,
          title: orcaRun.objective ?? orcaRun.id,
        });
      for (const worker of workers.workers ?? []) {
        const verdict = worker.projection?.liveness?.verdict ?? worker.liveness ?? "";
        if (finishedWorkerStates.includes(worker.state ?? "") || deadVerdicts.includes(verdict))
          continue;
        const terminal = byHandle.get(worker.agentTerminalHandle ?? worker.terminal ?? "");
        if (terminal && terminal.connected === false) continue;
        const title = titles.get(worker.taskId ?? "") ?? worker.taskId ?? "worker";
        list.push({
          role: roleOfTask(title),
          harness: terminal?.agentIdentity ?? null,
          model: worker.projection?.provider?.model ?? terminal?.model ?? null,
          title,
        });
      }
      agents.set(run, list);
    }),
  );
  return failed ? null : { agents };
}

// ---------------------------------------------------------------- Plannotator

export type PlannotatorSession = { index: number; target?: string; url?: string };

/** Live Plannotator review sessions, or null when `plannotator sessions` fails or times out. */
export const readPlannotator = (): Promise<PlannotatorSession[] | null> =>
  execJson<PlannotatorSession[]>(["plannotator", "sessions", "--json"]);

// ---------------------------------------------------------------- GitHub

export type MergeRequestFacts = {
  state: "open" | "merged" | "closed" | null;
  ci: "passing" | "failing" | "pending" | "unknown";
};

/** `gh pr checks` exits 1 for a failing check and 8 for a pending one, and still prints the checks. */
const ghChecksExitCodes = [0, 1, 8];

async function readMergeRequest(url: string): Promise<MergeRequestFacts | null> {
  const [checks, view] = await Promise.all([
    execJson<{ bucket?: string }[]>(
      ["gh", "pr", "checks", url, "--json", "bucket"],
      githubTimeoutMilliseconds,
      ghChecksExitCodes,
    ),
    execJson<{ state?: string }>(
      ["gh", "pr", "view", url, "--json", "state"],
      githubTimeoutMilliseconds,
    ),
  ]);
  if (!checks && !view) return null;
  const buckets = new Set((checks ?? []).map((check) => check.bucket));
  const state = view?.state?.toLowerCase();
  return {
    state: state === "open" || state === "merged" || state === "closed" ? state : null,
    ci: !checks
      ? "unknown"
      : buckets.has("fail")
        ? "failing"
        : buckets.has("pending")
          ? "pending"
          : buckets.size > 0
            ? "passing"
            : "unknown",
  };
}

/**
 * Reads each MR again. An MR whose read fails keeps its last good facts from `known`; `ok` is then
 * false, so the page shows how old the facts are.
 */
export async function readGithub(
  urls: string[],
  known: Map<string, MergeRequestFacts>,
): Promise<{ facts: Map<string, MergeRequestFacts>; ok: boolean }> {
  const facts = new Map<string, MergeRequestFacts>();
  let ok = true;
  await Promise.all(
    urls.map(async (url) => {
      const fresh = await readMergeRequest(url);
      const kept = fresh ?? known.get(url);
      if (!fresh) ok = false;
      if (kept) facts.set(url, kept);
    }),
  );
  return { facts, ok };
}
