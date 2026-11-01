import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execJson, readerTimeoutMilliseconds } from "./exec.ts";
import type { Item } from "./types.ts";

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
  /** Threads with open questions per project, or null when the Inbox did not answer. */
  threads: Map<string, InboxThread[] | null>;
};

export const emptyPlannotator: PlannotatorSnapshot = { sessions: null, threads: new Map() };

/** The running Inbox writes its port here. A missing file means no Inbox runs: the reader never starts one. */
function inboxPort(): number | null {
  const dataDirectory = process.env.PLANNOTATOR_DATA_DIR || join(homedir(), ".plannotator");
  try {
    return JSON.parse(readFileSync(join(dataDirectory, "inbox", "inbox.json"), "utf8")).port;
  } catch {
    return null;
  }
}

/** Threads of one project folder that the Inbox lists with `read_thread`, over its local MCP endpoint. */
async function readThreads(port: number, projectPath: string): Promise<InboxThread[] | null> {
  try {
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
    const data = (await response.text()).match(/^data: (.*)$/m)?.[1];
    if (!data) return null;
    const result = JSON.parse(data).result;
    return result?.isError ? null : (result?.structuredContent?.threads ?? null);
  } catch {
    return null;
  }
}

export async function readPlannotator(
  projects: { name: string; workspace: string }[],
): Promise<PlannotatorSnapshot> {
  const port = inboxPort();
  const [sessions, threadLists] = await Promise.all([
    execJson<PlannotatorSession[]>(["plannotator", "sessions", "--json"]),
    Promise.all(
      projects.map(async (project) => [
        project.name,
        port === null ? null : await readThreads(port, project.workspace),
      ]),
    ),
  ]);
  return { sessions, threads: new Map(threadLists as [string, InboxThread[] | null][]) };
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
        since: thread.last_at ?? new Date().toISOString(),
        action: { name: "plannotator-inbox", label: "Open Inbox", params: {} },
      })),
  );
}
