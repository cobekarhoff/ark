import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execJson } from "../cli/exec.ts";
import { deriveState, readEvents, type ArkEvent, type RunState } from "../cli/events.ts";
import { orcaOrchestration, type OrcaRun, type OrcaTerminal } from "../cli/orca.ts";
import { listProjects, projectDirectory, runsDirectory } from "../cli/paths.ts";
import { loadPlan, type PlanStep } from "../cli/plan.ts";
import { stepWindows, type StepWindow } from "../cli/retro.ts";
import type { Agent, TicketView, Wait } from "./types.ts";

/** Each reader is given a hard timeout, so a hung tool delays its own source and nothing else. */
const githubTimeoutMilliseconds = 10_000;

/** Only `ARK-277.md` is a ticket: `README.md` and notes in the folder are not. */
const ticketFile = /^[A-Z]+-\d+\.md$/;

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
            if (!ticketFile.test(name)) continue;
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

export type OrcaValue = { agents: Map<string, Agent[]>; waits: Map<string, Wait[]> };

type OrcaWorker = {
  dispatchId?: string;
  taskId?: string;
  state?: string;
  liveness?: string;
  terminal?: string;
  terminalState?: string;
  agentTerminalHandle?: string;
  projection?: { provider?: { model?: string }; liveness?: { verdict?: string } };
};
type OrcaTask = { id: string; title?: string; task_title?: string };
type OrcaTerminalFull = OrcaTerminal & { agentIdentity?: string; model?: string };
type OrcaMessage = {
  type?: string;
  from_handle?: string;
  to_handle?: string;
  subject?: string;
  body?: string;
  read?: number | boolean;
  created_at?: string;
};

const finishedWorkerStates = ["succeeded", "failed", "stopped", "cancelled", "released"];
const deadVerdicts = ["exited", "dead"];
/** A step task is titled `<step id> [note] (<role>, <repo>)`: the first word is the step id. */
const stepTask = /^([\w.-]+)[^(]*\((?:implementer|validator|reviewer),/;

/** `hub-server (implementer, .)` is a step task and `evaluator (<run>)` a stage task: both name the role. */
function roleOfTask(title: string | undefined): string {
  const step = title?.match(/\((implementer|validator|reviewer),/);
  return step?.[1] ?? title?.match(/^(\w+) \(/)?.[1] ?? "worker";
}

const isLive = (worker: OrcaWorker): boolean => {
  const verdict = worker.projection?.liveness?.verdict ?? worker.liveness ?? "";
  return !finishedWorkerStates.includes(worker.state ?? "") && !deadVerdicts.includes(verdict);
};

/**
 * The live agents of each open Ark run, and what each run waits for. Orca commands that feed it:
 * `terminal list`, `run-list --full` and `inbox --full`, and per open run `worker-list` and
 * `task-list`. Null when `run-list`, `terminal list` or `inbox` fails (a failure of `worker-list`
 * or `task-list` for one run drops that run, never invents agents): the page then keeps the last
 * answer and shows its age, never an empty list of waits.
 *
 * A pending question is a message of type `question` or `escalation` that the run lead has not
 * read (`ask` from a worker, or a blocked report): the step of its sender waits.
 */
export async function readOrca(
  openRuns: { run: string; project: string }[],
): Promise<OrcaValue | null> {
  const [runList, terminalList, inbox] = await Promise.all([
    orcaOrchestration<{ runs?: OrcaRun[] }>("run-list", "--full"),
    execJson<{ result?: { terminals?: OrcaTerminalFull[] } }>([
      "orca",
      "terminal",
      "list",
      "--json",
    ]),
    orcaOrchestration<{ messages?: OrcaMessage[] }>("inbox", "--limit", "200", "--full"),
  ]);
  const terminals = terminalList?.result?.terminals;
  if (!runList || !terminals || !inbox) return null;
  const byHandle = new Map(terminals.map((terminal) => [terminal.handle, terminal]));
  const orcaRuns = runList.runs ?? [];
  const leadOf = new Map(
    orcaRuns
      .filter((orcaRun) => orcaRun.objective?.startsWith("Ark run "))
      .map((orcaRun) => [orcaRun.objective!.slice("Ark run ".length), orcaRun]),
  );
  const chiefOf = (project: string) =>
    orcaRuns.find((orcaRun) => orcaRun.objective === `Master Chief: ${project} tickets`);
  // A run lead is a supervised worker of Master Chief's Orca run, not a terminal Orca lists.
  const chiefWorkers = new Map<string, OrcaWorker[]>();
  await Promise.all(
    [...new Set(openRuns.map((open) => open.project))].map(async (project) => {
      const chief = chiefOf(project);
      if (!chief) return;
      const list = await orcaOrchestration<{ workers?: OrcaWorker[] }>(
        "worker-list",
        "--run",
        chief.id,
        "--include-remote",
      );
      chiefWorkers.set(project, list?.workers ?? []);
    }),
  );
  const agents = new Map<string, Agent[]>();
  const waits = new Map<string, Wait[]>();
  let failed = false;
  await Promise.all(
    openRuns.map(async ({ run, project }) => {
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
      const chief = chiefOf(project);
      const chiefTerminal = chief?.coordinator_handle
        ? byHandle.get(chief.coordinator_handle)
        : undefined;
      if (chiefTerminal?.connected)
        list.push({
          role: "Master Chief",
          harness: chiefTerminal.agentIdentity ?? null,
          model: chiefTerminal.model ?? null,
          title: chief!.objective ?? chief!.id,
          step: null,
          planned: null,
        });
      const leadHandle = orcaRun.coordinator_handle;
      const leadTerminal = leadHandle ? byHandle.get(leadHandle) : undefined;
      const leadLive =
        leadTerminal?.connected === true ||
        (chiefWorkers.get(project) ?? []).some(
          (worker) => worker.terminal === leadHandle && isLive(worker),
        );
      if (leadLive)
        list.push({
          role: "run lead",
          harness: leadTerminal?.agentIdentity ?? null,
          model: leadTerminal?.model ?? null,
          title: orcaRun.objective ?? orcaRun.id,
          step: null,
          planned: null,
        });
      for (const worker of workers.workers ?? []) {
        if (!isLive(worker)) continue;
        const terminal = byHandle.get(worker.agentTerminalHandle ?? worker.terminal ?? "");
        if (terminal && terminal.connected === false) continue;
        const title = titles.get(worker.taskId ?? "") ?? worker.taskId ?? "worker";
        list.push({
          role: roleOfTask(title),
          harness: terminal?.agentIdentity ?? null,
          model: worker.projection?.provider?.model ?? terminal?.model ?? null,
          title,
          step: title.match(stepTask)?.[1] ?? null,
          planned: null,
        });
      }
      agents.set(run, list);

      const stepOf = (handle: string | undefined): string | null => {
        const worker = (workers.workers ?? []).find(
          (candidate) =>
            handle !== undefined &&
            (candidate.dispatchId === handle ||
              candidate.terminal === handle ||
              candidate.agentTerminalHandle === handle),
        );
        const title = worker ? (titles.get(worker.taskId ?? "") ?? worker.taskId) : undefined;
        return title?.match(stepTask)?.[1] ?? null;
      };
      const pending = (inbox.messages ?? []).filter((message) => {
        const sender = message.from_handle?.replace(/^dispatch:/, "");
        const worker = (workers.workers ?? []).find(
          (candidate) =>
            sender !== undefined &&
            (candidate.dispatchId === sender ||
              candidate.terminal === sender ||
              candidate.agentTerminalHandle === sender),
        );
        return (
          (message.type === "question" || message.type === "escalation") &&
          message.to_handle === `run:${orcaRun.id}` &&
          !message.read &&
          message.created_at &&
          // A worker that finished no longer waits for an answer.
          !(worker && !isLive(worker))
        );
      });
      waits.set(
        run,
        pending.map((message) => ({
          step: stepOf(message.from_handle?.replace(/^dispatch:/, "")),
          reason: `${message.type === "question" ? "asked the run lead" : "blocked"}: ${(
            message.subject ||
            message.body ||
            ""
          )
            .trim()
            .split("\n")[0]
            .slice(0, 140)}`,
          since: message.created_at!,
        })),
      );
    }),
  );
  return failed ? null : { agents, waits };
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
      const last = known.get(url);
      // `pr view` did not answer: keep the last good state (none: the page says unknown) and go stale.
      if (!fresh?.state) ok = false;
      const kept = fresh?.state ? fresh : fresh ? { ...fresh, state: last?.state ?? null } : last;
      if (kept) facts.set(url, kept);
    }),
  );
  return { facts, ok };
}
