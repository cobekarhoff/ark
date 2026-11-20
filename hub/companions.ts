import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { now } from "../cli/clock.ts";
import { companionDirectory, isRunning, type WorkerRecord } from "../cli/companions.ts";
import type { ProjectConfig } from "../cli/config.ts";
import { hubConfig } from "./config.ts";
import { execResult } from "../cli/exec.ts";
import {
  findChiefRun,
  orcaPages,
  orcaTimeoutMilliseconds,
  type OrcaRunRow,
  type WorkerRow,
} from "../cli/orca.ts";
import { listProjects, projectDirectory } from "../cli/paths.ts";
import { frontmatter, setTicketStatus } from "../cli/ticket.ts";
import { whyOf, withoutCodeMarks } from "./ticket-document.ts";
import type {
  CompanionItem,
  CompanionRow,
  CompanionsProject,
  CompanionsReply,
  CompanionState,
} from "./types.ts";
import type { UsageIndex } from "./usage.ts";

/** A reason or a question is cut here, counted in characters (code points), never in bytes. */
export const textLimitCharacters = 400;
const ideasPerCompanion = 20;
const wakeLogTailBytes = 8192;
const askTimeoutMilliseconds = 30_000;
const arkCommand = join(import.meta.dir, "..", "cli", "ark.ts");
const ticketFile = /^[A-Z]+-\d+\.md$/;

/** A write the hub refuses: `status` is the HTTP status, `message` goes to the page as it is. */
export class HubRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const characters = (value: string): number => Array.from(value).length;

// ------------------------------------------------------------------ files of one companion

function readWorkerRecord(directory: string): Partial<WorkerRecord> | null {
  try {
    return JSON.parse(readFileSync(join(directory, "worker.json"), "utf8"));
  } catch {
    return null;
  }
}

/** The session files that the `worker.json` of every companion names: what the usage index must parse whatever their cwd. */
export function companionSessionFiles(): string[] {
  const files: string[] = [];
  for (const project of listProjects()) {
    const folder = join(projectDirectory(project), "companions");
    if (!existsSync(folder)) continue;
    for (const entry of readdirSync(folder)) {
      const session = readWorkerRecord(join(folder, entry))?.session;
      if (typeof session === "string") files.push(session);
    }
  }
  return files;
}

/** The last line of `wake.log`, or null. Reads the tail only: the log grows with every wake. */
async function lastWake(directory: string): Promise<CompanionRow["last_wake"]> {
  const file = Bun.file(join(directory, "wake.log"));
  if (!(await file.exists())) return null;
  const tail = await file.slice(Math.max(0, file.size - wakeLogTailBytes)).text();
  const line = tail.trimEnd().split("\n").at(-1);
  try {
    const entry = JSON.parse(line ?? "");
    return typeof entry.time === "string" && typeof entry.trigger === "string"
      ? {
          time: entry.time,
          trigger: entry.trigger,
          run: typeof entry.run === "string" ? entry.run : null,
        }
      : null;
  } catch {
    return null;
  }
}

/** `<kind> <ref>` of each item named in `dismissed.md`: the `- item:` line of each entry the hub wrote. */
function readDismissed(directory: string): Set<string> {
  try {
    const text = readFileSync(join(directory, "dismissed.md"), "utf8");
    return new Set([...text.matchAll(/^- item: (.+)$/gm)].map((match) => match[1]));
  } catch {
    return new Set();
  }
}

const itemKey = (kind: string, ref: string): string => `${kind} ${ref}`;

/** The `## ` sections of `ideas.md`, newest (last) first. A heading `C-1: Title` has the id `C-1`; any other heading is its own id. */
function readIdeas(directory: string, name: string, dismissed: Set<string>): CompanionItem[] {
  let text: string;
  try {
    text = readFileSync(join(directory, "ideas.md"), "utf8");
  } catch {
    return [];
  }
  return text
    .split(/^## /m)
    .slice(1)
    .map((section): CompanionItem => {
      const [heading, ...lines] = section.split(/\r?\n/);
      const named = /^([A-Za-z][A-Za-z0-9]*-\d+):\s*(.+)$/.exec(heading.trim());
      const ref = named ? named[1] : heading.trim();
      const idea = lines.find((line) => /^- Idea:/i.test(line))?.replace(/^- Idea:\s*/i, "");
      const first = lines.find((line) => line.trim() !== "" && !line.startsWith("- "))?.trim();
      const body = idea ?? first ?? null;
      return {
        kind: "idea",
        ref,
        companion: name,
        title: named ? named[2] : ref,
        body:
          body !== null && characters(body) > 400
            ? `${Array.from(body).slice(0, 399).join("")}…`
            : body,
        done: dismissed.has(itemKey("idea", ref)) ? "dismissed" : null,
      };
    })
    .reverse();
}

type TicketEntry = { item: CompanionItem; file: string; status: "proposed" | "ready" };

/** The tickets of the project that name the companion in their `source` line, at `proposed` or `ready` (approved), newest id first. A ticket Master Chief started leaves the list. */
function readTickets(project: string, name: string, dismissed: Set<string>): TicketEntry[] {
  const folder = join(projectDirectory(project), "tickets");
  if (!existsSync(folder)) return [];
  const entries: TicketEntry[] = [];
  for (const entry of readdirSync(folder)) {
    if (!ticketFile.test(entry)) continue;
    try {
      const file = join(folder, entry);
      const source = readFileSync(file, "utf8");
      const fields = frontmatter(source).fields;
      const origin = typeof fields?.source === "string" ? fields.source.trim() : "";
      if (origin !== name && origin !== `companion ${name}`) continue;
      const status = fields?.status;
      if (
        typeof fields?.id !== "string" ||
        typeof fields.title !== "string" ||
        (status !== "proposed" && status !== "ready")
      )
        continue;
      entries.push({
        file,
        status,
        item: {
          kind: "ticket",
          ref: fields.id,
          companion: name,
          title: withoutCodeMarks(fields.title),
          body: whyOf(source),
          done:
            status === "ready"
              ? "approved"
              : dismissed.has(itemKey("ticket", fields.id))
                ? "dismissed"
                : null,
        },
      });
    } catch {
      // A ticket file that does not read is the Roadmap's to show, not this page's.
    }
  }
  return entries.sort(
    (left, right) =>
      Number(right.item.ref.split("-").at(-1)) - Number(left.item.ref.split("-").at(-1)),
  );
}

// ------------------------------------------------------------------ Orca

/** Dispatch id to state for each project, or null when `run-list` or `worker-list` failed. A project without a Master Chief Run has no worker: an empty map. */
async function readWorkerStates(
  projects: string[],
): Promise<Map<string, Map<string, CompanionState>> | null> {
  const runs = await orcaPages<OrcaRunRow>("run-list", "runs", ["--full"], orcaTimeoutMilliseconds);
  if (!runs.ok) return null;
  const states = new Map<string, Map<string, CompanionState>>();
  for (const project of projects) {
    const dispatches = new Map<string, CompanionState>();
    states.set(project, dispatches);
    const chief = findChiefRun(project, runs.value);
    if (!chief.ok) continue;
    const workers = await orcaPages<WorkerRow>(
      "worker-list",
      "workers",
      ["--run", chief.value, "--include-remote"],
      orcaTimeoutMilliseconds,
    );
    if (!workers.ok) return null;
    for (const worker of workers.value) {
      if (isRunning(worker)) dispatches.set(worker.dispatchId, "running");
    }
  }
  return states;
}

// ------------------------------------------------------------------ the page's data

/**
 * Every project whose `ark.yml` exists, with its companions, their latest ideas and proposed tickets.
 * A project whose `ark.yml` does not load gives its error text, never a crash: the hub parses nothing
 * with a throwing reader here. Cost is the sum of the companion's session file in `usage`.
 */
export async function readCompanions(usage: UsageIndex): Promise<CompanionsReply> {
  const loaded: { project: string; configuration: ProjectConfig }[] = [];
  const projects: CompanionsProject[] = [];
  for (const project of listProjects()) {
    if (!existsSync(join(projectDirectory(project), "ark.yml"))) continue;
    try {
      const configuration = hubConfig(project);
      if (configuration.companions) loaded.push({ project, configuration });
    } catch (error) {
      projects.push({ project, error: (error as Error).message });
    }
  }
  const states =
    loaded.length > 0 ? await readWorkerStates(loaded.map((entry) => entry.project)) : new Map();
  for (const { project, configuration } of loaded) {
    const companions: CompanionRow[] = [];
    const tickets: CompanionItem[] = [];
    const ideas: CompanionItem[] = [];
    for (const companion of configuration.companions ?? []) {
      const directory = companionDirectory(project, companion.name);
      const record = readWorkerRecord(directory);
      const dismissed = readDismissed(directory);
      const dispatches = states?.get(project);
      companions.push({
        name: companion.name,
        harness: companion.harness,
        model: companion.model,
        on: companion.on,
        state:
          dispatches === undefined || states === null
            ? "unavailable"
            : (typeof record?.dispatch === "string" && dispatches.get(record.dispatch)) || "none",
        last_wake: await lastWake(directory),
        cost: typeof record?.session === "string" ? usage.fileCost(record.session) : null,
      });
      tickets.push(...readTickets(project, companion.name, dismissed).map((entry) => entry.item));
      ideas.push(...readIdeas(directory, companion.name, dismissed).slice(0, ideasPerCompanion));
    }
    projects.push({ project, companions, tickets, ideas });
  }
  return { orca: states === null ? "unavailable" : "ok", projects };
}

// ------------------------------------------------------------------ the three writes

export type CompanionWrite = "approve" | "dismiss" | "ask";

const stringField = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  if (typeof value !== "string") throw new HubRefusal(400, `${key} must be a string`);
  return value;
};

/** The text of a reason or question: not empty, at most 400 characters. */
function limitedText(body: Record<string, unknown>, key: string): string {
  const value = stringField(body, key).trim();
  if (value === "") throw new HubRefusal(400, `${key} must not be empty`);
  if (characters(value) > textLimitCharacters)
    throw new HubRefusal(400, `${key} is over the limit of ${textLimitCharacters} characters`);
  return value;
}

/**
 * The project and companion a write names, checked against the projects on disk and the `ark.yml`
 * list. The names select a listed entry: a path is built only from a name that list holds.
 */
function companionOf(body: Record<string, unknown>): {
  project: string;
  name: string;
  directory: string;
} {
  const project = stringField(body, "project");
  const name = stringField(body, "name");
  if (!listProjects().includes(project)) throw new HubRefusal(404, `no project ${project}`);
  let companions: ProjectConfig["companions"];
  try {
    companions = hubConfig(project).companions;
  } catch (error) {
    throw new HubRefusal(409, (error as Error).message);
  }
  if (!companions?.some((companion) => companion.name === name))
    throw new HubRefusal(404, `companion ${name} is not in ark.yml`);
  return { project, name, directory: companionDirectory(project, name) };
}

/** The item a write names, as one of the companion's listed items; a refusal when it is none. */
function itemOf(
  body: Record<string, unknown>,
  project: string,
  name: string,
  directory: string,
): CompanionItem {
  const named = body.item;
  if (named === null || typeof named !== "object")
    throw new HubRefusal(400, "item must be {kind, ref}");
  const { kind, ref } = named as Record<string, unknown>;
  const dismissed = readDismissed(directory);
  const items =
    kind === "ticket"
      ? readTickets(project, name, dismissed).map((entry) => entry.item)
      : kind === "idea"
        ? readIdeas(directory, name, dismissed)
        : null;
  if (items === null) throw new HubRefusal(400, "item kind must be ticket or idea");
  const found = items.find((item) => item.ref === ref);
  if (!found) throw new HubRefusal(404, `${name} has no ${String(kind)} ${String(ref)}`);
  return found;
}

/**
 * Runs one of the three writes of the Companions page. Approve sets a proposed ticket of the
 * companion to `ready` and does nothing else: Master Chief queues it. Dismiss appends one entry to
 * `dismissed.md`. Ask runs `ark companion ask`, which needs Orca. Throws `HubRefusal` and changes
 * nothing when a check fails.
 */
export async function writeCompanion(
  action: CompanionWrite,
  body: Record<string, unknown>,
): Promise<{ ok: true }> {
  const { project, name, directory } = companionOf(body);
  if (action === "approve") {
    const id = stringField(body, "id");
    const ticket = readTickets(project, name, new Set()).find(
      (entry) => entry.status === "proposed" && entry.item.ref === id,
    );
    if (!ticket) throw new HubRefusal(404, `${name} has no proposed ticket ${id}`);
    if (!setTicketStatus(ticket.file, "ready"))
      throw new HubRefusal(500, `${id} has no status line to set`);
    return { ok: true };
  }
  if (action === "dismiss") {
    const reason = limitedText(body, "reason");
    const item = itemOf(body, project, name, directory);
    mkdirSync(directory, { recursive: true });
    // One append of one entry, and a reason on one line, so a reason cannot add an `- item:` line.
    appendFileSync(
      join(directory, "dismissed.md"),
      `## ${new Date(now()).toISOString()}\n\n- item: ${itemKey(item.kind, item.ref)}\n- reason: ${reason.replace(/\s+/g, " ")}\n\n`,
    );
    return { ok: true };
  }
  const question = limitedText(body, "question");
  const item = body.item === undefined ? null : itemOf(body, project, name, directory);
  const about = item ? `About ${item.kind} ${item.ref}` : "Question";
  const result = await execResult(
    [
      process.execPath,
      arkCommand,
      "companion",
      "ask",
      name,
      `${about}: ${question}`,
      "--project",
      project,
    ],
    askTimeoutMilliseconds,
  );
  if (result.code !== 0)
    throw new HubRefusal(
      502,
      result.timedOut
        ? "the question timed out"
        : result.stderr.trim().replace(/^ark: /, "") || "ark companion ask failed",
    );
  return { ok: true };
}
