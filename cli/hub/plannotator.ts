import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execJson, readerTimeoutMilliseconds } from "./exec.ts";
import type { Item } from "./types.ts";
import { now as hubNow } from "./clock.ts";

export type PlannotatorSession = { index: number; target?: string; url?: string };
type InboxThread = {
  thread_id: string;
  subject?: string;
  last_at?: string;
  questions?: { open?: number; picked?: number };
};

export type PlannotatorSnapshot = {
  /** Live review sessions, or null when `plannotator sessions` failed or timed out. */
  sessions: PlannotatorSession[] | null;
  /** Threads with open questions per project. Failed reads add no threads. */
  threads: Map<string, InboxThread[]>;
  status: "ok" | "not running" | "unknown";
  error: string | null;
};

export const emptyPlannotator: PlannotatorSnapshot = {
  sessions: null,
  threads: new Map(),
  status: "unknown",
  error: "Plannotator has not been read yet",
};

/** Only an absent port file means the Inbox is not running. */
function inboxPort(): number | null {
  const dataDirectory = process.env.PLANNOTATOR_DATA_DIR || join(homedir(), ".plannotator");
  let contents: string;
  try {
    contents = readFileSync(join(dataDirectory, "inbox", "inbox.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const port: unknown = JSON.parse(contents).port;
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
    throw new Error("Invalid Inbox port");
  }
  return port as number;
}

/** Threads of one project folder that the Inbox lists with `read_thread`, over its local MCP endpoint. */
async function readThreads(port: number, projectPath: string): Promise<InboxThread[]> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "read_thread",
        arguments: { project_path: projectPath, asked_by: "anyone", format: "full" },
      },
    }),
    signal: AbortSignal.timeout(readerTimeoutMilliseconds),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const data = (await response.text()).match(/^data: (.*)$/m)?.[1];
  if (!data) throw new Error("Invalid Inbox response");
  const result = JSON.parse(data);
  if (result.error) throw new Error(result.error.message ?? JSON.stringify(result.error));
  if (result.result?.isError) {
    throw new Error(result.result.content?.[0]?.text ?? "Inbox returned an error");
  }
  const threads = result.result?.structuredContent?.threads;
  if (!Array.isArray(threads)) throw new Error("Invalid Inbox threads");
  return threads;
}

export async function readPlannotator(
  projects: { name: string; workspace: string }[],
): Promise<PlannotatorSnapshot> {
  let port: number | null = null;
  let inboxError: string | null = null;
  try {
    port = inboxPort();
  } catch (error) {
    inboxError = `Inbox port read failed: ${String(error)}`;
  }
  const [sessions, threadLists] = await Promise.all([
    execJson<PlannotatorSession[]>(["plannotator", "sessions", "--json"]),
    Promise.all(
      projects.map(async (project): Promise<[string, InboxThread[]]> => {
        if (port === null) return [project.name, []];
        try {
          return [project.name, await readThreads(port, project.workspace)];
        } catch (error) {
          inboxError ??= `Inbox read failed for ${project.name}: ${String(error)}`;
          return [project.name, []];
        }
      }),
    ),
  ]);
  const error = inboxError ?? (sessions === null ? "Plannotator sessions read failed" : null);
  return {
    sessions,
    threads: new Map(threadLists),
    status: error ? "unknown" : port === null ? "not running" : "ok",
    error,
  };
}

/** Inbox threads that wait for an answer. A project whose Inbox read failed adds nothing. */
export function plannotatorItems(snapshot: PlannotatorSnapshot): Item[] {
  return [...snapshot.threads].flatMap(([project, threads]) =>
    (threads ?? [])
      .filter((thread) => (thread.questions?.open ?? 0) + (thread.questions?.picked ?? 0) > 0)
      .map((thread): Item => ({
        id: `question:${project}:${thread.thread_id}`,
        kind: "question",
        source: "plannotator",
        project,
        ticket: null,
        title: thread.subject ?? "Inbox question",
        since: thread.last_at ?? new Date(hubNow()).toISOString(),
        action: { name: "plannotator-inbox", label: "Open Inbox", params: {} },
      })),
  );
}
