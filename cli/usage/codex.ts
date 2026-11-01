import { readFileSync } from "node:fs";
import { ArkError } from "../errors.ts";
import type { SessionUsage, UsageMessage } from "./index.ts";

type CodexTokens = {
  input_tokens?: number;
  cached_input_tokens?: number;
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
    info?: { last_token_usage?: CodexTokens; total_token_usage?: CodexTokens } | null;
  };
};

const numberOrZero = (value: unknown): number => (typeof value === "number" ? value : 0);

/**
 * Reads one Codex rollout file (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`). Usage comes from
 * `token_count` events. Codex logs tokens and no cost, so every message has cost "unknown": it is
 * never 0 and never estimated. Codex repeats a `token_count` event when nothing was spent, so an
 * event whose running total did not grow is skipped. Lines that do not parse are skipped.
 */
export function parseCodexSession(file: string): SessionUsage {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new ArkError(`cannot read session file ${file}`);
  }

  let cwd = "";
  let model = "unknown";
  let contextOverflows = 0;
  let previousTotal = -1;
  const messages: UsageMessage[] = [];

  for (const line of text.split("\n")) {
    let record: CodexRecord;
    try {
      record = JSON.parse(line) as CodexRecord;
    } catch {
      continue;
    }
    const payload = record.payload ?? {};
    if (record.type === "session_meta" && !cwd) cwd = payload.cwd ?? "";
    if (record.type === "turn_context" && payload.model) model = payload.model;
    if (record.type !== "event_msg") continue;
    if (payload.type === "context_compacted") contextOverflows += 1;
    const last = payload.info?.last_token_usage;
    if (payload.type !== "token_count" || !last) continue;
    const total = numberOrZero(payload.info?.total_token_usage?.total_tokens);
    if (total > 0 && total === previousTotal) continue;
    previousTotal = total;
    const cached = numberOrZero(last.cached_input_tokens);
    messages.push({
      time: record.timestamp ?? "",
      model,
      provider: "openai",
      // OpenAI counts cached tokens inside input_tokens; the other parsers keep them apart.
      input: Math.max(0, numberOrZero(last.input_tokens) - cached),
      output: numberOrZero(last.output_tokens),
      cacheRead: cached,
      cacheWrite: 0,
      costUsd: "unknown",
      toolError: false,
      sessionFile: file,
    });
  }
  return { file, cwd, messages, contextOverflows, crashed: false };
}
