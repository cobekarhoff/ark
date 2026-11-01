import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listProjects, runsDirectory } from "../paths.ts";
import { projectOfPath } from "./agents.ts";
import { readTicketFiles } from "./backlog.ts";
import { execJson } from "./exec.ts";

export type Hit = {
  kind: "ticket" | "run" | "plan" | "retro" | "session";
  project: string;
  title: string;
  snippet: string | null;
  /** Where the page opens the hit. */
  target: Record<string, string>;
};

/**
 * `disabled`: Orca session history is switched off, so no session was searched.
 * `unavailable`: Orca said search is unavailable for another reason.
 * `unknown`: Orca did not answer or answered in a shape the hub does not read.
 * `enabled`: sessions were searched; no session hit then means no match.
 */
export type SessionSearch = {
  state: "enabled" | "disabled" | "unavailable" | "unknown";
  reason?: string;
};

const snippetAround = (text: string, at: number, length: number): string => {
  const from = Math.max(0, at - 60);
  return text
    .slice(from, at + length + 60)
    .replace(/\s+/g, " ")
    .trim();
};

const sessionSearchTimeoutMilliseconds = 5000;
const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

type OrcaSearch = {
  result?: {
    kind?: string;
    reason?: string;
    hits?: Record<string, unknown>[];
    results?: Record<string, unknown>[];
  };
};

async function searchSessions(query: string): Promise<{ state: SessionSearch; hits: Hit[] }> {
  const answer = await execJson<OrcaSearch>(
    ["orca", "search", `--query=${query}`, "--json", "--limit", "20"],
    sessionSearchTimeoutMilliseconds,
  );
  const result = answer?.result;
  if (!result) return { state: { state: "unknown", reason: "Orca did not answer" }, hits: [] };
  if (result.kind === "unavailable")
    return {
      state: {
        state: result.reason === "disabled" ? "disabled" : "unavailable",
        reason: result.reason ?? "no reason given",
      },
      hits: [],
    };
  const raw = result.hits ?? result.results;
  // An answer without a hit list is not "no matches": the hub cannot tell what it means.
  if (!Array.isArray(raw))
    return { state: { state: "unknown", reason: "Orca answered in an unknown shape" }, hits: [] };
  return {
    state: { state: "enabled" },
    hits: raw.map((hit) => {
      const session = (hit.session ?? {}) as Record<string, unknown>;
      const path = text(hit.path) ?? text(hit.cwd) ?? text(session.path) ?? text(session.cwd);
      const id = text(hit.sessionId) ?? text(session.id) ?? text(hit.id) ?? "";
      return {
        kind: "session",
        project: projectOfPath(path),
        title: text(hit.title) ?? text(session.title) ?? text(hit.agent) ?? `session ${id}`,
        snippet: text(hit.snippet),
        target: {
          view: "session",
          session: id,
          ...(text(hit.resumeCommand) ? { resume: text(hit.resumeCommand)! } : {}),
        },
      };
    }),
  };
}

function searchLocal(query: string): Hit[] {
  const needle = query.toLowerCase();
  const find = (haystack: string) => haystack.toLowerCase().indexOf(needle);
  const hits: Hit[] = [];

  for (const ticket of readTicketFiles()) {
    const inTitle = ticket.title !== null && find(ticket.title) >= 0;
    const at = find(ticket.body);
    if (!inTitle && at < 0) continue;
    hits.push({
      kind: "ticket",
      project: ticket.project,
      title: `${ticket.id}: ${ticket.title ?? "unreadable ticket"}`,
      snippet: inTitle ? null : snippetAround(ticket.body, at, query.length),
      target: { view: "backlog", project: ticket.project, ticket: ticket.id },
    });
  }

  for (const project of listProjects()) {
    const root = runsDirectory(project);
    if (!existsSync(root)) continue;
    for (const run of readdirSync(root).sort()) {
      if (find(run) >= 0)
        hits.push({
          kind: "run",
          project,
          title: run,
          snippet: null,
          target: { view: "run", run },
        });
      for (const [file, kind] of [
        ["plan.md", "plan"],
        ["retro.md", "retro"],
      ] as const) {
        const path = join(root, run, file);
        if (!existsSync(path)) continue;
        let content: string;
        try {
          content = readFileSync(path, "utf8");
        } catch {
          continue;
        }
        const at = find(content);
        if (at >= 0)
          hits.push({
            kind,
            project,
            title: `${run} ${file}`,
            snippet: snippetAround(content, at, query.length),
            target: { view: "run", run, file },
          });
      }
    }
  }
  return hits;
}

export type SearchAnswer = { query: string; orca: SessionSearch; hits: Hit[] };

/**
 * The Search API: ticket titles and bodies, run IDs, `plan.md` and `retro.md` from the files, and
 * agent sessions through `orca search`. Local hits stay when Orca history is disabled or Orca fails.
 */
export async function search(query: string): Promise<SearchAnswer> {
  const sessions = await searchSessions(query);
  return { query, orca: sessions.state, hits: [...searchLocal(query), ...sessions.hits] };
}
