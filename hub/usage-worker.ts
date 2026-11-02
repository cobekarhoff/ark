/// <reference lib="webworker" />
import { closeSync, openSync, readSync } from "node:fs";
import { parseClaudeSession } from "../cli/usage/claude.ts";
import { parseCodexSession, readCodexText } from "../cli/usage/codex.ts";
import { parseOmpSession } from "../cli/usage/omp.ts";
import type { SessionUsage } from "../cli/usage/index.ts";
import type { Harness, WorkerReply, WorkerRequest } from "./usage.ts";

const parsers = {
  omp: parseOmpSession,
  claude: parseClaudeSession,
  codex: parseCodexSession,
} satisfies Record<Harness, (file: string) => SessionUsage>;

/** First `cwd` in the first 64 KiB of a session file; every format writes it near the top. */
function readCwd(file: string): string | null {
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
  const match = head.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
  return match ? JSON.parse(`"${match[1]}"`) : null;
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  let reply: WorkerReply;
  try {
    if (request.kind === "head") {
      reply = { id: request.id, cwd: readCwd(request.file) };
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
