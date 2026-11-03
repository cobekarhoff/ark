/// <reference lib="webworker" />
import { closeSync, openSync, readSync } from "node:fs";
import { parseClaudeSession } from "../cli/usage/claude.ts";
import { parseCodexSession, readCodexText } from "../cli/usage/codex.ts";
import { parseOmpSession } from "../cli/usage/omp.ts";
import type { SessionUsage } from "../cli/usage/index.ts";
import { readTranscriptPage } from "./transcript.ts";
import type { Harness, WorkerReply, WorkerRequest } from "./usage.ts";

const parsers = {
  omp: parseOmpSession,
  claude: parseClaudeSession,
  codex: parseCodexSession,
} satisfies Record<Harness, (file: string) => SessionUsage>;

/**
 * First `cwd` and first timestamp in the first 64 KiB of a session file; every format writes both
 * near the top. The timestamp is when the session began.
 */
function readHead(file: string): { cwd: string | null; start: number | null } {
  let head: string;
  if (file.endsWith(".zst")) {
    head = readCodexText(file).slice(0, 65536);
  } else {
    const descriptor = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(65536);
      head = buffer.toString("utf8", 0, readSync(descriptor, buffer, 0, buffer.length, 0));
    } finally {
      closeSync(descriptor);
    }
  }
  const cwd = head.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
  const time = head.match(/"timestamp":"([^"]+)"/);
  const start = time ? Date.parse(time[1]) : Number.NaN;
  return { cwd: cwd ? JSON.parse(`"${cwd[1]}"`) : null, start: Number.isNaN(start) ? null : start };
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  let reply: WorkerReply;
  try {
    if (request.kind === "head") {
      reply = { id: request.id, ...readHead(request.file) };
    } else if (request.kind === "transcript") {
      reply = {
        id: request.id,
        page: readTranscriptPage(request.file, request.harness, request.cursor ?? 0),
      };
    } else {
      const session = parsers[request.harness](request.file);
      reply = {
        id: request.id,
        cwd: session.cwd,
        messages: session.messages.map((message) => ({
          time: Date.parse(message.time),
          cost: message.costUsd === "unknown" ? null : message.costUsd,
        })),
      };
    }
  } catch (err) {
    reply = { id: request.id, error: String(err) };
  }
  postMessage(reply);
};
