/// <reference lib="webworker" />
import { parseClaudeSession } from "../cli/usage/claude.ts";
import { parseCodexSession } from "../cli/usage/codex.ts";
import { parseOmpSession } from "../cli/usage/omp.ts";
import { readHead, type SessionUsage } from "../cli/usage/index.ts";
import { readTranscriptPage } from "./transcript.ts";
import type { Harness, WorkerReply, WorkerRequest } from "./usage.ts";

const parsers = {
  omp: parseOmpSession,
  claude: parseClaudeSession,
  codex: parseCodexSession,
} satisfies Record<Harness, (file: string) => SessionUsage>;

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
          model: message.model === "unknown" ? null : message.model,
          ...(message.helper ? { helper: true } : {}),
        })),
      };
    }
  } catch (err) {
    reply = { id: request.id, error: String(err) };
  }
  postMessage(reply);
};
