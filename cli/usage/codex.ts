import { readFileSync } from "node:fs";
import { ArkError } from "../errors.ts";
import type { SessionUsage, UsageMessage } from "./index.ts";

type CodexTokens = {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};
type CodexRecord = {
  type?: string;
  timestamp?: string;
  payload?: {
    type?: string;
    cwd?: string;
    model?: string;
    model_provider?: string;
    info?: {
      total_token_usage?: CodexTokens;
      last_token_usage?: CodexTokens;
    } | null;
  };
};

/** Reads a Codex rollout file as text: Codex Desktop stores them zstd-compressed (`.jsonl.zst`). */
export function readCodexText(file: string): string {
  try {
    const bytes = readFileSync(file);
    return file.endsWith(".zst")
      ? Buffer.from(Bun.zstdDecompressSync(bytes)).toString("utf8")
      : bytes.toString("utf8");
  } catch {
    throw new ArkError(`cannot read session file ${file}`);
  }
}

/**
 * Reads one Codex rollout file (`~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl[.zst]`).
 * Each `token_count` event carries the usage of one model call in `last_token_usage`; Codex's
 * `input_tokens` includes the cached part, so cached tokens are split out. Events that repeat
 * the same running total (replayed history in a forked session) count once. Rollouts hold
 * token counts but no cost and no price list is known for their models, so cost is "unknown".
 */
export function parseCodexSession(file: string): SessionUsage {
  let cwd = "";
  let model = "unknown";
  let provider = "openai";
  let contextOverflows = 0;
  const messages: UsageMessage[] = [];
  const seenTotals = new Set<number>();

  for (const line of readCodexText(file).split("\n")) {
    let record: CodexRecord;
    try {
      record = JSON.parse(line) as CodexRecord;
    } catch {
      continue;
    }
    const payload = record.payload;
    if (!payload) continue;
    if (record.type === "session_meta") {
      cwd ||= payload.cwd ?? "";
      provider = payload.model_provider ?? provider;
    } else if (record.type === "turn_context") {
      cwd ||= payload.cwd ?? "";
      model = payload.model ?? model;
    } else if (record.type === "compacted") {
      contextOverflows += 1;
    } else if (record.type === "event_msg" && payload.type === "token_count") {
      const last = payload.info?.last_token_usage;
      const total = payload.info?.total_token_usage?.total_tokens;
      if (!last || total === undefined || seenTotals.has(total)) continue;
      seenTotals.add(total);
      const cached = last.cached_input_tokens ?? 0;
      const input = (last.input_tokens ?? 0) - cached;
      const output = last.output_tokens ?? 0;
      if (input + output + cached === 0) continue;
      messages.push({
        time: record.timestamp ?? "",
        model,
        provider,
        input,
        output,
        cacheRead: cached,
        cacheWrite: last.cache_write_input_tokens ?? 0,
        costUsd: "unknown",
        toolError: false,
        sessionFile: file,
      });
    }
  }
  return { file, cwd, messages, contextOverflows, crashed: false };
}
