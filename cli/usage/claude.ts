import { readFileSync } from "node:fs";
import { ArkError } from "../errors.ts";
import type { SessionUsage, UsageMessage } from "./index.ts";

/**
 * USD per million tokens: input, output, cache read, cache write (5-minute cache).
 * A 1-hour cache write costs twice the input price. Values match the costs OMP recorded for
 * the same models. A model that is not listed gets cost "unknown", never zero.
 */
const PRICES_PER_MILLION: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

const OVERFLOW_PATTERN = /prompt is too long|context (length|window)|maximum context/i;

type ClaudeContentBlock = { type?: string; id?: string; tool_use_id?: string; is_error?: boolean; text?: string };
type ClaudeUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
};
type ClaudeRecord = {
  type?: string;
  subtype?: string;
  timestamp?: string;
  cwd?: string;
  isCompactSummary?: boolean;
  isApiErrorMessage?: boolean;
  message?: { id?: string; model?: string; usage?: ClaudeUsage; content?: ClaudeContentBlock[] | string };
};

function costUsd(model: string, usage: ClaudeUsage): number | "unknown" {
  const price = PRICES_PER_MILLION[model.replace(/-\d{8}$/, "")];
  if (!price) return "unknown";
  const cacheWriteTotal = usage.cache_creation_input_tokens ?? 0;
  const oneHourWrite = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const fiveMinuteWrite = cacheWriteTotal - oneHourWrite;
  return (
    ((usage.input_tokens ?? 0) * price.input +
      (usage.output_tokens ?? 0) * price.output +
      (usage.cache_read_input_tokens ?? 0) * price.cacheRead +
      fiveMinuteWrite * price.cacheWrite +
      oneHourWrite * 2 * price.input) /
    1_000_000
  );
}

/**
 * Reads one Claude Code session file (`~/.claude/projects/<encoded cwd>/*.jsonl`, or a
 * subagent transcript below it). Claude Code writes one record per content block of a response,
 * each repeating the response usage, so records are deduplicated by `message.id`.
 */
export function parseClaudeSession(file: string): SessionUsage {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new ArkError(`cannot read session file ${file}`);
  }

  let cwd = "";
  let contextOverflows = 0;
  let crashed = false;
  const responses = new Map<string, UsageMessage>();
  const toolUseIds = new Map<string, string[]>(); // response id -> tool_use ids
  const failedToolUseIds = new Set<string>();

  for (const line of text.split("\n")) {
    let record: ClaudeRecord;
    try {
      record = JSON.parse(line) as ClaudeRecord;
    } catch {
      continue;
    }
    if (!cwd && record.cwd) cwd = record.cwd;
    if (record.isCompactSummary || (record.type === "system" && record.subtype === "compact_boundary")) {
      contextOverflows += 1;
    }
    const message = record.message;
    const blocks = Array.isArray(message?.content) ? message.content : [];

    if (record.type === "user") {
      for (const block of blocks) {
        if (block.type === "tool_result" && block.is_error === true && block.tool_use_id) {
          failedToolUseIds.add(block.tool_use_id);
        }
      }
    }
    if (record.type !== "assistant" || !message) continue;

    crashed = record.isApiErrorMessage === true;
    if (crashed && blocks.some((block) => OVERFLOW_PATTERN.test(block.text ?? ""))) contextOverflows += 1;
    if (message.model === "<synthetic>" || !message.usage || !message.id) continue;

    const model = message.model ?? "unknown";
    const usage = message.usage;
    const ids = toolUseIds.get(message.id) ?? [];
    for (const block of blocks) if (block.type === "tool_use" && block.id) ids.push(block.id);
    toolUseIds.set(message.id, ids);
    // Later records of the same response replace earlier ones: the last carries the final output count.
    responses.set(message.id, {
      time: record.timestamp ?? "",
      model,
      provider: "anthropic",
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
      costUsd: costUsd(model, usage),
      toolError: false,
      sessionFile: file,
    });
  }

  // Each record holds one content block, so a response's tool_use ids are spread over its records.
  const messages = [...responses].map(([id, message]) => ({
    ...message,
    toolError: (toolUseIds.get(id) ?? []).some((toolUseId) => failedToolUseIds.has(toolUseId)),
  }));
  return { file, cwd, messages, contextOverflows, crashed };
}
