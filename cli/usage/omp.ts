import { readFileSync } from "node:fs";
import { ArkError } from "../errors.ts";
import {
  commandWord,
  resultText,
  type FailedCall,
  type SessionUsage,
  type UsageMessage,
} from "./index.ts";

const OVERFLOW_PATTERN =
  /context (length|window)|prompt is too long|input is too long|maximum context/i;

type OmpUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
};
type OmpMessage = {
  role?: string;
  model?: string;
  provider?: string;
  usage?: OmpUsage;
  stopReason?: string;
  errorMessage?: string;
  isError?: boolean;
  purpose?: string;
  toolCallId?: string;
  content?:
    | { type?: string; id?: string; name?: string; arguments?: { command?: unknown } }[]
    | string;
};
type OmpRecord = OmpMessage & {
  type?: string;
  timestamp?: string;
  cwd?: string;
  message?: OmpMessage;
};

function numberOrZero(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/**
 * Reads one OMP session file (`~/.omp/agent/sessions/<encoded cwd>/*.jsonl`, or a subagent
 * transcript below it). Usage comes from assistant messages and from `model_usage` records
 * (side calls such as title generation). Lines that do not parse are skipped: a live session
 * can end on a half-written line.
 */
export function parseOmpSession(file: string): SessionUsage {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new ArkError(`cannot read session file ${file}`);
  }

  let cwd = "";
  let contextOverflows = 0;
  let crashed = false;
  const messages: UsageMessage[] = [];
  const toolCallIds: Set<string>[] = []; // parallel to messages
  const failedToolCallIds = new Set<string>();
  const calls = new Map<string, { tool: string; word: string }>();
  const failedCalls: FailedCall[] = [];

  for (const line of text.split("\n")) {
    let record: OmpRecord;
    try {
      record = JSON.parse(line) as OmpRecord;
    } catch {
      continue;
    }
    if (record.type === "session" && !cwd) cwd = record.cwd ?? "";
    if (record.type === "compaction") contextOverflows += 1;

    const message = record.message ?? {};
    if (
      record.type === "message" &&
      message.role === "toolResult" &&
      message.isError === true &&
      message.toolCallId
    ) {
      failedToolCallIds.add(message.toolCallId);
      failedCalls.push({
        ...(calls.get(message.toolCallId) ?? { tool: "unknown", word: "" }),
        error: resultText(message.content),
      });
    }
    if (
      record.type === "message" &&
      message.role === "assistant" &&
      Array.isArray(message.content)
    ) {
      for (const block of message.content)
        if (block.type === "toolCall" && block.id)
          calls.set(block.id, {
            tool: block.name ?? "unknown",
            word: commandWord(block.arguments?.command),
          });
    }

    const isAssistant = record.type === "message" && message.role === "assistant";
    if (isAssistant) {
      crashed = message.stopReason === "error";
      if (crashed && OVERFLOW_PATTERN.test(message.errorMessage ?? "")) contextOverflows += 1;
    }

    const usageSource = isAssistant ? message : record.type === "model_usage" ? record : undefined;
    if (!usageSource?.usage) continue;
    const usage = usageSource.usage;
    const callIds = new Set<string>();
    if (isAssistant && Array.isArray(message.content)) {
      for (const block of message.content)
        if (block.type === "toolCall" && block.id) callIds.add(block.id);
    }
    toolCallIds.push(callIds);
    messages.push({
      time: record.timestamp ?? "",
      model: usageSource.model ?? "unknown",
      provider: usageSource.provider ?? "unknown",
      input: numberOrZero(usage.input),
      output: numberOrZero(usage.output),
      cacheRead: numberOrZero(usage.cacheRead),
      cacheWrite: numberOrZero(usage.cacheWrite),
      costUsd: typeof usage.cost?.total === "number" ? usage.cost.total : "unknown",
      toolError: false,
      ...(record.purpose === undefined ? {} : { helper: true, purpose: record.purpose }),
      sessionFile: file,
    });
  }

  messages.forEach((message, index) => {
    message.toolError = [...toolCallIds[index]].some((id) => failedToolCallIds.has(id));
  });
  return { file, cwd, messages, contextOverflows, failedCalls, crashed };
}
