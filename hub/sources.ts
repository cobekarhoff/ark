import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { now } from "../cli/clock.ts";
import { canonicalCriterion } from "../cli/criterion-id.ts";
import { execJson } from "../cli/exec.ts";
import {
  deriveState,
  stepWindows,
  type ArkEvent,
  type RunState,
  type StepWindow,
} from "../cli/events.ts";
import { loadConfig } from "../cli/config.ts";
import {
  orcaOrchestration,
  orcaPages,
  orcaRead,
  orcaTimeoutMilliseconds,
  readChiefQueue,
  type OrcaRun,
  type OrcaTerminal,
  type QueueTask,
} from "../cli/orca.ts";
import { listProjects, projectDirectory, runsDirectory } from "../cli/paths.ts";
import { loadPlan, type PlanStep } from "../cli/plan.ts";
import { frontmatter } from "../cli/ticket.ts";
import type { Directory, DirectoryWorker, InboxMessage } from "./conversation.ts";
import { readEventsLeniently } from "./run-detail.ts";
import { readRoadmap, type RoadmapTicket } from "./roadmap.ts";
import { parseTicketDocument, whyOf, withoutCodeMarks } from "./ticket-document.ts";
import type {
  Agent,
  AgentActivity,
  CheckView,
  FindingsView,
  ProofCase,
  ProjectRoadmap,
  ProviderWindow,
  TicketDocument,
  TicketView,
  Wait,
} from "./types.ts";

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
export type ArkValue = {
  runs: ArkRun[];
  tickets: TicketView[];
  /** Memory only, never serialized: each listed ticket's file and parsed document (null when unreadable). */
  ticketFiles: Map<TicketView, TicketFile>;
  roadmap: Record<string, ProjectRoadmap>;
};
export type TicketFile = { file: string; document: TicketDocument | null };

const ticketSources = ["local", "github", "jira"];

export const signatureOf = (file: string): string | null => {
  try {
    const stat = statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
};

type ParsedTicket = { ticket: TicketView; document: TicketDocument | null };

/** A ticket file's text as the hub shows it: a file without a readable id and title is `unreadable`, with no document. */
export function parseTicket(
  project: string,
  name: string,
  signature: string,
  source: string,
): ParsedTicket {
  try {
    const fields = frontmatter(source).fields;
    if (fields && typeof fields.id === "string" && typeof fields.title === "string") {
      return {
        ticket: {
          project,
          id: fields.id,
          title: withoutCodeMarks(fields.title),
          status: typeof fields.status === "string" ? fields.status : "unknown",
          kind: typeof fields.kind === "string" ? fields.kind : null,
          milestone: typeof fields.milestone === "string" ? fields.milestone : null,
          depends_on: Array.isArray(fields.depends_on) ? fields.depends_on.map(String) : [],
          why: whyOf(source),
          signature,
        },
        document: parseTicketDocument(source),
      };
    }
  } catch {
    // A ticket file that does not parse shows as unreadable and hides no other ticket.
  }
  return {
    ticket: {
      project,
      id: name.replace(/\.md$/, ""),
      title: null,
      status: "unreadable",
      kind: null,
      milestone: null,
      depends_on: [],
      why: null,
      signature,
    },
    document: null,
  };
}

/** The document of a listed ticket, read from its file now. Null when the file is gone; `{ document: null }` when it does not parse. */
export function readTicketDocument(entry: TicketFile): { document: TicketDocument | null } | null {
  try {
    return {
      document: parseTicket("", basename(entry.file), "", readFileSync(entry.file, "utf8"))
        .document,
    };
  } catch {
    return null;
  }
}

/**
 * Reads Ark's files again only where a file changed (size and mtime). A run whose log is being
 * written at this moment can end on a half line: that run keeps its last good value.
 */
export function createArkReader() {
  const runCache = new Map<string, { signature: string; run: ArkRun }>();
  const ticketCache = new Map<
    string,
    { signature: string; ticket: TicketView; document: TicketDocument | null }
  >();
  const fileCache = new Map<string, { signature: string; text: string | null }>();

  /** A text file read again only when its size or mtime changed; null when it is missing or unreadable. */
  function readText(file: string): string | null {
    const signature = signatureOf(file);
    if (signature === null) return null;
    const known = fileCache.get(file);
    if (known?.signature === signature) return known.text;
    let text: string | null = null;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      // Unreadable: the caller treats it as a file with no text.
    }
    fileCache.set(file, { signature, text });
    return text;
  }

  /** `ticket_source` of `ark.yml`; `local` (the default) for a project with no ark.yml or a value that is not one of the three. */
  function ticketSourceOf(project: string): string {
    try {
      const fields = Bun.YAML.parse(readText(join(projectDirectory(project), "ark.yml")) ?? "") as {
        ticket_source?: unknown;
      } | null;
      const value = fields?.ticket_source;
      return typeof value === "string" && ticketSources.includes(value) ? value : "local";
    } catch {
      return "local";
    }
  }

  function roadmapOf(project: string, tickets: TicketView[]): ProjectRoadmap {
    const markdown = readText(join(projectDirectory(project), "ROADMAP.md"));
    if (markdown === null) return { none: ticketSourceOf(project) };
    // A ticket whose front matter did not read has no real status: it waits in Review.
    const known: RoadmapTicket[] = tickets.map((ticket) => ({
      id: ticket.id,
      title: ticket.title,
      status: ["unreadable", "unknown"].includes(ticket.status) ? "proposed" : ticket.status,
      milestone: ticket.milestone,
      depends_on: ticket.depends_on,
    }));
    const result = readRoadmap(markdown, known);
    return result.ok
      ? result.roadmap
      : { error: result.errors.map((error) => `line ${error.line}: ${error.message}`).join(" ") };
  }

  function readRun(directory: string): ArkRun | null {
    const log = join(directory, "events.ndjson");
    const logSignature = signatureOf(log);
    if (logSignature === null) return null;
    const signature = `${logSignature}|${signatureOf(join(directory, "plan.yml"))}`;
    const known = runCache.get(directory);
    if (known?.signature === signature) return known.run;
    try {
      const events = readEventsLeniently(directory);
      if (events.length === 0) return null;
      let plan: PlanStep[] | null = null;
      try {
        plan = loadPlan(directory).steps;
      } catch {}
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

  function readTicket(project: string, file: string, name: string) {
    const signature = signatureOf(file);
    if (signature === null) return null;
    const known = ticketCache.get(file);
    if (known?.signature === signature) return known;
    let parsed: ParsedTicket;
    try {
      parsed = parseTicket(project, name, signature, readFileSync(file, "utf8"));
    } catch {
      parsed = parseTicket(project, name, signature, "");
    }
    ticketCache.set(file, { signature, ...parsed });
    return parsed;
  }

  return {
    /** Every run (open and closed, newest first) and every ticket of every project. */
    read(): ArkValue {
      const runs: ArkRun[] = [];
      const tickets: TicketView[] = [];
      const ticketFiles = new Map<TicketView, TicketFile>();
      const roadmap: Record<string, ProjectRoadmap> = {};
      for (const project of listProjects()) {
        const runsRoot = runsDirectory(project);
        if (existsSync(runsRoot)) {
          for (const name of readdirSync(runsRoot)) {
            const run = readRun(join(runsRoot, name));
            if (run) runs.push(run);
          }
        }
        const ticketsRoot = join(projectDirectory(project), "tickets");
        const projectTickets: TicketView[] = [];
        if (existsSync(ticketsRoot)) {
          for (const name of readdirSync(ticketsRoot).sort()) {
            if (!ticketFile.test(name)) continue;
            const file = join(ticketsRoot, name);
            const read = readTicket(project, file, name);
            if (!read) continue;
            projectTickets.push(read.ticket);
            ticketFiles.set(read.ticket, { file, document: read.document });
          }
        }
        tickets.push(...projectTickets);
        roadmap[project] = roadmapOf(project, projectTickets);
      }
      runs.sort((left, right) =>
        right.state.run.localeCompare(left.state.run, undefined, { numeric: true }),
      );
      return { runs, tickets, ticketFiles, roadmap };
    },
    /** Folders to watch: each run folder (events.ndjson, plan.yml), the runs roots, the tickets folders and each project folder (ROADMAP.md, ark.yml). */
    watchPaths(): string[] {
      const paths: string[] = [];
      for (const project of listProjects()) {
        const runsRoot = runsDirectory(project);
        const ticketsRoot = join(projectDirectory(project), "tickets");
        for (const root of [projectDirectory(project), runsRoot, ticketsRoot])
          if (existsSync(root)) paths.push(root);
        if (existsSync(runsRoot))
          for (const name of readdirSync(runsRoot)) paths.push(join(runsRoot, name));
      }
      return paths;
    },
  };
}

// ---------------------------------------------------------------- Master Chief's queue

/** What one project's queue read gave, without the open-run count (the snapshot adds it from the runs it holds). `concurrency` is null when `ark.yml` does not load: the queue itself does not need it. */
export type QueueRead =
  | { concurrency: number | null; tasks: QueueTask[] }
  | { unavailable: string };

/**
 * The queue of each project, through the reader `ark chief state` uses. Each project is its own
 * read, so one project's slow Orca call shows only in its own entry.
 */
export async function readQueues(): Promise<Map<string, QueueRead>> {
  const projects = listProjects();
  const reads = await Promise.all(
    projects.map(async (project): Promise<QueueRead> => {
      let concurrency: number | null = null;
      try {
        concurrency = loadConfig(project).concurrency;
      } catch {
        // An ark.yml that does not load leaves the limit unknown; it never hides the queue.
      }
      const queue = await readChiefQueue(project, orcaTimeoutMilliseconds);
      return queue.ok ? { concurrency, tasks: queue.value } : { unavailable: queue.reason };
    }),
  );
  return new Map(projects.map((project, index) => [project, reads[index]]));
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
export const stepTask = /^([\w.-]+)[^(]*\((?:implementer|validator|reviewer),/;

/** Until `orca worktree ps` has listed the agent, what it does is not known. */
export const unknownActivity: AgentActivity = { kind: "unknown", text: "unknown", last_line: null };

/** `hub-server (implementer, .)` is a step task and `evaluator (<run>)` or `test-case-writer (<run>)` a stage task: both name the role. */
export function roleOfTask(title: string | undefined): string {
  const step = title?.match(/\((implementer|validator|reviewer),/);
  return step?.[1] ?? title?.match(/^([\w-]+) \(/)?.[1] ?? "worker";
}

const isLive = (worker: OrcaWorker): boolean => {
  const verdict = worker.projection?.liveness?.verdict ?? worker.liveness ?? "";
  return !finishedWorkerStates.includes(worker.state ?? "") && !deadVerdicts.includes(verdict);
};

/**
 * The agents of each open Ark run (`live` is false for one that Orca released or disconnected), and what each run waits for. Orca commands that feed it:
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
    orcaPages<OrcaRun>("run-list", "runs", ["--full"]),
    execJson<{ result?: { terminals?: OrcaTerminalFull[] } }>([
      "orca",
      "terminal",
      "list",
      "--json",
    ]),
    orcaOrchestration<{ messages?: OrcaMessage[] }>("inbox", "--limit", "200", "--full"),
  ]);
  const terminals = terminalList?.result?.terminals;
  if (!runList.ok || !terminals || !inbox) return null;
  const byHandle = new Map(terminals.map((terminal) => [terminal.handle, terminal]));
  const orcaRuns = runList.value;
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
      const list = await orcaPages<OrcaWorker>("worker-list", "workers", [
        "--run",
        chief.id,
        "--include-remote",
      ]);
      chiefWorkers.set(project, list.ok ? list.value : []);
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
        orcaPages<OrcaWorker>("worker-list", "workers", ["--run", orcaRun.id, "--include-remote"]),
        orcaOrchestration<{ tasks?: OrcaTask[] }>("task-list", "--run", orcaRun.id),
      ]);
      if (!workers.ok || !tasks) {
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
          terminal: chief!.coordinator_handle ?? null,
          presence: "live",
          activity: unknownActivity,
        });
      const leadHandle = orcaRun.coordinator_handle;
      const leadTerminal = leadHandle ? byHandle.get(leadHandle) : undefined;
      const leadConnected = leadTerminal?.connected === true;
      // Orca lists a run lead started as a worker (`structworker_*`) only in Master Chief's
      // worker-list: it runs, but `terminal switch` cannot address it.
      const leadRunning =
        !leadConnected &&
        (chiefWorkers.get(project) ?? []).some(
          (worker) => worker.terminal === leadHandle && isLive(worker),
        );
      if (leadConnected || leadRunning)
        list.push({
          role: "run lead",
          harness: leadTerminal?.agentIdentity ?? null,
          model: leadTerminal?.model ?? null,
          title: orcaRun.objective ?? orcaRun.id,
          step: null,
          planned: null,
          terminal: leadHandle ?? null,
          presence: leadConnected ? "live" : "running",
          activity: unknownActivity,
        });
      // A released or disconnected worker stays in the list as `ended`: the page says
      // "ended, not in Orca" instead of hiding it.
      for (const worker of workers.value) {
        const handle = worker.agentTerminalHandle ?? worker.terminal ?? null;
        const terminal = byHandle.get(handle ?? "");
        const title = titles.get(worker.taskId ?? "") ?? worker.taskId ?? "worker";
        const presence =
          handle !== null && isLive(worker) && terminal?.connected === true
            ? "live"
            : isLive(worker)
              ? "running"
              : "ended";
        list.push({
          role: roleOfTask(title),
          harness: terminal?.agentIdentity ?? null,
          model: worker.projection?.provider?.model ?? terminal?.model ?? null,
          title,
          step: title.match(stepTask)?.[1] ?? null,
          planned: null,
          terminal: handle,
          presence,
          activity: unknownActivity,
        });
      }
      agents.set(run, list);

      const stepOf = (handle: string | undefined): string | null => {
        const worker = workers.value.find(
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
        const worker = workers.value.find(
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

// ---------------------------------------------------------------- Conversation

/** Orca keeps about nine days of messages (3,592 on 2026-11-12, one third more each week); `inbox` has no default big enough, so the read names its limit. */
export const inboxLimit = 10_000;

export type InboxRead = { messages: InboxMessage[]; truncated: boolean };

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * Every message in Orca's inbox, with bodies: `orca orchestration inbox --json --full --limit <inboxLimit>`.
 * `truncated` when the count equals the limit. A missing field stays null; null when the read fails.
 */
export async function readInbox(): Promise<InboxRead | null> {
  const inbox = await orcaRead<{ messages?: Record<string, unknown>[] }>(
    ["inbox", "--full", "--limit", String(inboxLimit)],
    orcaTimeoutMilliseconds,
  );
  if (!inbox.ok) return null;
  const rows = inbox.value.messages ?? [];
  const messages = rows.flatMap((row): InboxMessage[] => {
    const id = text(row.id);
    if (id === null) return [];
    const payload = row.payload;
    return [
      {
        id,
        type: text(row.type),
        from_handle: text(row.from_handle),
        to_handle: text(row.to_handle),
        subject: text(row.subject),
        body: text(row.body),
        thread_id: text(row.thread_id),
        run_id: text(row.run_id),
        payload:
          typeof payload === "object" && payload !== null
            ? (payload as Record<string, unknown>)
            : null,
        created_at: text(row.created_at),
        delivered_at: text(row.delivered_at),
      },
    ];
  });
  return { messages, truncated: rows.length === inboxLimit };
}

/** The handles one Orca worker answers to: the same three fields the pending-wait filter matches, plain and with `dispatch:`. */
const handlesOf = (worker: OrcaWorker): string[] =>
  [worker.dispatchId, worker.terminal, worker.agentTerminalHandle].filter(
    (handle): handle is string => typeof handle === "string",
  );

/** What one Ark run's Orca Run holds: its workers (and their task titles). Closed runs never change, so the caller keeps them. */
export type RunWorkers = DirectoryWorker[];

async function readRunWorkers(arkRun: string, orcaRun: string): Promise<RunWorkers | null> {
  const [workers, tasks] = await Promise.all([
    orcaPages<OrcaWorker>("worker-list", "workers", ["--run", orcaRun, "--include-remote"]),
    orcaOrchestration<{ tasks?: OrcaTask[] }>("task-list", "--run", orcaRun),
  ]);
  if (!workers.ok || !tasks) return null;
  const titles = new Map(
    (tasks.tasks ?? []).map((task) => [task.id, task.title ?? task.task_title]),
  );
  return workers.value.map((worker) => {
    const title = titles.get(worker.taskId ?? "") ?? worker.taskId ?? "worker";
    return {
      arkRun,
      handles: handlesOf(worker),
      step: title.match(stepTask)?.[1] ?? null,
      role: roleOfTask(title),
      title,
    };
  });
}

/**
 * What maps handles to agents: Master Chief's Orca Runs and run leads from `run-list`, and the workers of
 * each Ark run that has a message. A closed run's workers are read once (`closedWorkers`); an open run's each time.
 * A read that fails leaves its handles unmapped, never drops a message. Null when `run-list` fails.
 */
export async function readDirectory(
  arkRuns: { run: string; closed: boolean }[],
  messages: InboxMessage[],
  closedWorkers: Map<string, RunWorkers>,
): Promise<Directory | null> {
  const runList = await orcaPages<OrcaRun>("run-list", "runs", ["--full"], orcaTimeoutMilliseconds);
  if (!runList.ok) return null;
  const chiefRuns = runList.value.filter((orcaRun) =>
    /^Master Chief: .+ tickets$/.test(orcaRun.objective ?? ""),
  );
  const chiefWorkers = (
    await Promise.all(
      chiefRuns.map((chief) =>
        orcaPages<OrcaWorker>("worker-list", "workers", ["--run", chief.id, "--include-remote"]),
      ),
    )
  ).flatMap((list) => (list.ok ? list.value : []));
  const leads = runList.value.flatMap((orcaRun) => {
    const arkRun = orcaRun.objective?.startsWith("Ark run ")
      ? orcaRun.objective.slice("Ark run ".length)
      : null;
    if (arkRun === null) return [];
    // A run lead is a supervised worker of Master Chief's Orca Run: its dispatch and terminal are there.
    const handles = [
      orcaRun.coordinator_handle,
      ...chiefWorkers
        .filter((worker) => handlesOf(worker).includes(orcaRun.coordinator_handle ?? "\0"))
        .flatMap(handlesOf),
    ].filter((handle): handle is string => typeof handle === "string");
    return [{ arkRun, orcaRun: orcaRun.id, handles }];
  });
  const seen = new Set(
    messages.flatMap((message) => [message.run_id, message.to_handle, message.from_handle]),
  );
  const wanted = leads.filter(
    (lead) =>
      arkRuns.some((known) => known.run === lead.arkRun) &&
      (seen.has(lead.orcaRun) || seen.has(`run:${lead.orcaRun}`)),
  );
  const workers: DirectoryWorker[] = [];
  // Eight Orca reads at a time: the first read of a long inbox must not start hundreds of processes together.
  for (let start = 0; start < wanted.length; start += 8)
    await Promise.all(
      wanted.slice(start, start + 8).map(async (lead) => {
        const closed = arkRuns.find((known) => known.run === lead.arkRun)?.closed === true;
        const kept = closed ? closedWorkers.get(lead.arkRun) : undefined;
        const read = kept ?? (await readRunWorkers(lead.arkRun, lead.orcaRun));
        if (read === null) return;
        if (closed) closedWorkers.set(lead.arkRun, read);
        workers.push(...read);
      }),
    );
  return {
    chiefs: chiefRuns.map((chief) => ({
      orcaRun: chief.id,
      handles: [chief.coordinator_handle].filter(
        (handle): handle is string => typeof handle === "string",
      ),
    })),
    leads,
    workers,
  };
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
  checks: CheckView[];
  additions: number | null;
  deletions: number | null;
  changed_files: number | null;
  created_at: string | null;
};

/** A CheckRun has `name`, `status` and `conclusion`; a StatusContext has `context` and `state`. */
type RollupItem = {
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
};

const upper = (value: unknown): string => (typeof value === "string" ? value.toUpperCase() : "");
const finiteOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function checkOf(item: RollupItem): CheckView {
  const isStatusContext = item.context !== undefined && item.name === undefined;
  const result: CheckView["result"] = isStatusContext
    ? upper(item.state) === "SUCCESS"
      ? "pass"
      : ["PENDING", "EXPECTED"].includes(upper(item.state))
        ? "pending"
        : "fail"
    : upper(item.status) !== "COMPLETED"
      ? "pending"
      : ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(upper(item.conclusion))
        ? "pass"
        : "fail";
  const link = item.detailsUrl ?? item.targetUrl;
  return {
    name: String(item.name ?? item.context ?? "check"),
    url: typeof link === "string" && /^https?:\/\//.test(link) ? link : null,
    result,
  };
}

type PullRequestView = {
  state?: string;
  statusCheckRollup?: RollupItem[];
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  createdAt?: string;
};

/** The one `gh pr view` call: state, the checks (`statusCheckRollup`), diff size and creation time. */
async function readMergeRequest(url: string): Promise<MergeRequestFacts | null> {
  const view = await execJson<PullRequestView>(
    [
      "gh",
      "pr",
      "view",
      url,
      "--json",
      "state,statusCheckRollup,additions,deletions,changedFiles,createdAt",
    ],
    githubTimeoutMilliseconds,
  );
  if (!view) return null;
  const state = view.state?.toLowerCase();
  const checks = Array.isArray(view.statusCheckRollup) ? view.statusCheckRollup.map(checkOf) : [];
  const results = new Set(checks.map((check) => check.result));
  return {
    state: state === "open" || state === "merged" || state === "closed" ? state : null,
    ci: results.has("fail")
      ? "failing"
      : results.has("pending")
        ? "pending"
        : checks.length > 0
          ? "passing"
          : "unknown",
    checks,
    additions: finiteOrNull(view.additions),
    deletions: finiteOrNull(view.deletions),
    changed_files: finiteOrNull(view.changedFiles),
    created_at:
      typeof view.createdAt === "string" && !Number.isNaN(Date.parse(view.createdAt))
        ? view.createdAt
        : null,
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

// ---------------------------------------------------------------- Provider limits (`omp usage`)

const providerLimitsTimeoutMilliseconds = 10_000;

type OmpUsage = {
  reports?: {
    provider?: string;
    fetchedAt?: number;
    limits?: {
      window?: { id?: string; resetsAt?: number };
      amount?: { usedFraction?: number };
      scope?: { provider?: string };
    }[];
  }[];
};

const isoOrNull = (milliseconds: unknown): string | null =>
  typeof milliseconds === "number" && Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : null;

/**
 * Used fraction, reset time and fetch time for each provider and window (`5h`, `7d`) of
 * `omp usage --json`. Several limits of one window (a model or an account each): the fullest
 * counts. Null when the command fails, so the slot keeps its last good value with its age.
 */
export async function readProviderLimits(): Promise<ProviderWindow[] | null> {
  const usage = await execJson<OmpUsage>(
    ["omp", "usage", "--json"],
    providerLimitsTimeoutMilliseconds,
  );
  if (!usage || !Array.isArray(usage.reports)) return null;
  const windows = new Map<string, ProviderWindow>();
  for (const report of usage.reports) {
    for (const limit of Array.isArray(report.limits) ? report.limits : []) {
      const window = limit.window?.id;
      const provider = report.provider ?? limit.scope?.provider;
      if ((window !== "5h" && window !== "7d") || typeof provider !== "string") continue;
      const usedFraction = finiteOrNull(limit.amount?.usedFraction);
      const key = `${provider}/${window}`;
      const known = windows.get(key);
      if (known && (known.used_fraction ?? -1) >= (usedFraction ?? -1)) continue;
      windows.set(key, {
        provider,
        window,
        used_fraction: usedFraction,
        resets_at: isoOrNull(limit.window?.resetsAt),
        fetched_at: isoOrNull(report.fetchedAt),
      });
    }
  }
  return [...windows.values()];
}

// ---------------------------------------------------------------- Agent activity (`orca worktree ps`)

const agentWaitTimeoutMilliseconds = 10_000;
/** An agent in `working` with no update for this long is idle (unless it is in `wait`). */
const idleAfterMilliseconds = 5 * 60_000;

/** Orca does not document these fields: each one is read defensively, and a missing one is `unknown`. */
type OrcaPsAgent = {
  state?: unknown;
  toolName?: unknown;
  taskTitle?: unknown;
  agentType?: unknown;
  updatedAt?: unknown;
  lastOutputAt?: unknown;
  agentWait?: unknown;
  lastAssistantMessage?: unknown;
};
type OrcaPs = { result?: { worktrees?: { path?: unknown; agents?: unknown }[] } };

export type PsAgent = { title: string; harness: string | null; activity: AgentActivity };

/**
 * `agentWait` is an object `{ source, since }` while Orca sees an approval or input prompt (seen
 * live, ARK-293-AC4), and null when there is none (Orca's own CLI prints "none" for it): any truthy
 * value counts. A state of `waiting` or `blocked` counts too. State `done` is checked first: a done
 * agent is never waiting, idle or stuck.
 */
export function activityOf(agent: OrcaPsAgent, now: number): AgentActivity {
  const lastLine =
    typeof agent.lastAssistantMessage === "string"
      ? (agent.lastAssistantMessage
          .split("\n")
          .map((line) => line.trim())
          .findLast((line) => line !== "")
          ?.slice(0, 200) ?? null)
      : null;
  const state = typeof agent.state === "string" ? agent.state : null;
  if (state === "done") return { kind: "done", text: "done", last_line: lastLine };
  if (agent.agentWait || state === "waiting" || state === "blocked")
    return { kind: "waiting", text: "waiting on a prompt", last_line: lastLine };
  if (state === null) return { kind: "unknown", text: "unknown", last_line: lastLine };
  if (state === "working" && agent.toolName !== "wait") {
    const stamps = [agent.updatedAt, agent.lastOutputAt].filter(
      (stamp): stamp is number => typeof stamp === "number" && Number.isFinite(stamp),
    );
    if (stamps.length > 0) {
      const quiet = now - Math.max(...stamps);
      if (quiet >= idleAfterMilliseconds)
        return {
          kind: "idle",
          text: `idle ${Math.floor(quiet / 60_000)} min`,
          last_line: lastLine,
        };
    }
  }
  return { kind: "working", text: "working", last_line: lastLine };
}

const runWorkspace = /\/runs\/([^/]+)\/workspace(?:\/|$)/;

/**
 * The agents of each run, from the worktrees whose path is under `runs/<run>/workspace`. An agent
 * with no task title cannot be joined to a step and is left out. Null when the command fails.
 */
export async function readAgentWait(at = now()): Promise<Map<string, PsAgent[]> | null> {
  const ps = await execJson<OrcaPs>(
    ["orca", "worktree", "ps", "--agent-wait", "--json"],
    agentWaitTimeoutMilliseconds,
  );
  const worktrees = ps?.result?.worktrees;
  if (!Array.isArray(worktrees)) return null;
  const byRun = new Map<string, PsAgent[]>();
  for (const worktree of worktrees) {
    const run = typeof worktree.path === "string" ? worktree.path.match(runWorkspace)?.[1] : null;
    if (!run || !Array.isArray(worktree.agents)) continue;
    const list = byRun.get(run) ?? [];
    for (const agent of worktree.agents as OrcaPsAgent[]) {
      if (typeof agent.taskTitle !== "string") continue;
      list.push({
        title: agent.taskTitle,
        harness: typeof agent.agentType === "string" ? agent.agentType : null,
        activity: activityOf(agent, at),
      });
    }
    byRun.set(run, list);
  }
  return byRun;
}

/** What an Orca task title says: the step id, the role (`run lead` included) and their join key (the step id, else the role). */
export function parseAgentTitle(title: string): { key: string; role: string; step: string | null } {
  const step = title.match(stepTask)?.[1] ?? null;
  const role = /^Master Chief\b/.test(title)
    ? "Master Chief"
    : /\brun lead\b/.test(title)
      ? "run lead"
      : roleOfTask(title);
  return { key: step ?? role, role, step };
}

// ---------------------------------------------------------------- AC evidence and findings

export type EvidenceValue = Map<
  string,
  { proof: Map<string, ProofCase[]>; findings: FindingsView | null }
>;

const unescapeXml = (text: string): string =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

const testcasePattern = /<testcase((?:\s+[\w:.-]+="[^"]*")*)\s*(?:\/>|>([\s\S]*?)<\/testcase>)/g;
const attributePattern = /([\w:.-]+)="([^"]*)"/g;
const criterionPrefix = /^([A-Z][A-Z0-9]*-\d+-AC\d+)\b/;

/** The testcases of a JUnit report whose name starts with an AC id, by AC id: other cases are dropped. */
export function readJunitProof(xml: string): Map<string, ProofCase[]> {
  const proof = new Map<string, ProofCase[]>();
  for (const match of xml.matchAll(testcasePattern)) {
    const attributes = new Map(
      [...match[1].matchAll(attributePattern)].map(([, key, value]) => [key, unescapeXml(value)]),
    );
    const name = attributes.get("name") ?? "";
    const written = name.match(criterionPrefix)?.[1];
    if (!written) continue;
    // Run state names an AC `<ticket>/AC<k>`; the title still carries the old form.
    const id = canonicalCriterion(written);
    const line = Number(attributes.get("line"));
    const body = match[2] ?? "";
    const list = proof.get(id) ?? [];
    list.push({
      name,
      file: attributes.get("file") ?? null,
      line: Number.isInteger(line) && attributes.has("line") ? line : null,
      result: /<(?:failure|error)\b/.test(body)
        ? "fail"
        : /<skipped\b/.test(body)
          ? "skipped"
          : "pass",
    });
    proof.set(id, list);
  }
  return proof;
}

/** Counts the `### P1`, `### P2` and `### P3` headings of a findings file. */
export function countFindings(markdown: string): { p1: number; p2: number; p3: number } {
  const count = (rank: number) => markdown.match(new RegExp(`^### P${rank}\\b`, "gm"))?.length ?? 0;
  return { p1: count(1), p2: count(2), p3: count(3) };
}

export type EvidenceRun = { run: string; directory: string; reviewerSteps: string[] };

/**
 * Proof and findings of the runs it is given (the runs in `merge_requests_open`). A report with
 * about 17,000 cases is parsed once: the parsed cases are cached by size and mtime, and an
 * unchanged file is never read again. A run whose files cannot be read keeps its last good value.
 */
export function createEvidenceReader() {
  const reports = new Map<string, { signature: string; proof: Map<string, ProofCase[]> }>();
  const findings = new Map<
    string,
    { signature: string; counts: { p1: number; p2: number; p3: number } }
  >();
  const last: EvidenceValue = new Map();

  async function proofOf(directory: string): Promise<Map<string, ProofCase[]>> {
    const merged = new Map<string, ProofCase[]>();
    let names: string[] = [];
    try {
      names = (await readdir(join(directory, "results"))).filter((name) =>
        name.endsWith(".report"),
      );
    } catch {
      // No results folder yet: the run has no proof.
    }
    for (const name of names.sort()) {
      const file = join(directory, "results", name);
      const signature = signatureOf(file);
      if (signature === null) continue;
      let known = reports.get(file);
      if (known?.signature !== signature) {
        known = { signature, proof: readJunitProof(await Bun.file(file).text()) };
        reports.set(file, known);
      }
      for (const [id, cases] of known.proof) merged.set(id, [...(merged.get(id) ?? []), ...cases]);
    }
    return merged;
  }

  async function findingsOf({
    run,
    directory,
    reviewerSteps,
  }: EvidenceRun): Promise<FindingsView | null> {
    const newest = reviewerSteps
      .map((step) => `findings/${step}.md`)
      .flatMap((path) => {
        try {
          return [{ path, modified: statSync(join(directory, path)).mtimeMs }];
        } catch {
          return [];
        }
      })
      .sort((left, right) => right.modified - left.modified)[0];
    if (!newest) return null;
    const file = join(directory, newest.path);
    const signature = signatureOf(file) ?? "";
    let known = findings.get(file);
    if (known?.signature !== signature) {
      known = { signature, counts: countFindings(await Bun.file(file).text()) };
      findings.set(file, known);
    }
    return {
      path: newest.path,
      link: `/api/run/${encodeURIComponent(run)}/file?path=${encodeURIComponent(newest.path)}`,
      ...known.counts,
    };
  }

  return {
    async read(runs: EvidenceRun[]): Promise<EvidenceValue> {
      const value: EvidenceValue = new Map();
      await Promise.all(
        runs.map(async (evidenceRun) => {
          try {
            const entry = {
              proof: await proofOf(evidenceRun.directory),
              findings: await findingsOf(evidenceRun),
            };
            value.set(evidenceRun.run, entry);
            last.set(evidenceRun.run, entry);
          } catch {
            const kept = last.get(evidenceRun.run);
            if (kept) value.set(evidenceRun.run, kept);
          }
        }),
      );
      return value;
    },
  };
}
