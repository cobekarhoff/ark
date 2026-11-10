import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import type { Harness } from "../cli/usage/index.ts";
import type { TranscriptEntry, TranscriptPage } from "./types.ts";

/** Entries in one page of a transcript. */
export const pageSize = 200;
const chunkBytes = 1 << 20;
const messageLimit = 8000;
const argumentsLimit = 300;
const resultLimit = 300;
/** A tool call near the end of a page finds its result in the lines after the page. */
const lookaheadLines = 200;
const lookaheadBytes = 8 << 20;

type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;
type Result = { id: string; status: "ok" | "error"; text: string };
/** What one record of a session file adds: an entry (a tool call also names its id), or the result of a call. */
type Item = { entry: TranscriptEntry; callId?: string } | { result: Result };

const cut = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}… (+${text.length - limit} characters cut)` : text;

/** The first non-blank line, cut. Everything after it stays in the worker. */
const firstLine = (text: string) =>
  cut(
    text
      .split("\n")
      .find((line) => line.trim() !== "")
      ?.trim() ?? "",
    resultLimit,
  );

const isRecord = (value: unknown): value is Record<string, any> =>
  typeof value === "object" && value !== null;

/** Text of a content field: a string, or the `text` of every text-like block. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
    .filter((text) => text !== "")
    .join("\n");
}

const message = (role: string, time: string | null, text: string): Item[] =>
  text.trim() === ""
    ? []
    : [{ entry: { kind: "message", role, time, text: cut(text, messageLimit) } }];
const thinking = (time: string | null, text: string): Item[] =>
  text.trim() === "" ? [] : [{ entry: { kind: "thinking", time, text: cut(text, messageLimit) } }];
const call = (time: string | null, id: unknown, name: unknown, args: unknown): Item => ({
  callId: typeof id === "string" ? id : undefined,
  entry: {
    kind: "tool",
    time,
    name: typeof name === "string" ? name : "tool",
    args: cut(typeof args === "string" ? args : (JSON.stringify(args ?? {}) ?? ""), argumentsLimit),
    status: "unknown",
    result: "",
  },
});

/** omp: `message` records hold assistant blocks (`text`, `thinking`, `toolCall`); a `toolResult` message answers a call by `toolCallId`. */
function ompItems(record: Record<string, any>): Item[] {
  const time = typeof record.timestamp === "string" ? record.timestamp : null;
  if (record.type === "custom_message") return message("context", time, textOf(record.content));
  if (record.type !== "message" || !isRecord(record.message)) return [];
  const { role, content } = record.message;
  if (role === "toolResult")
    return [
      {
        result: {
          id: String(record.message.toolCallId ?? ""),
          status: record.message.isError === true ? "error" : "ok",
          text: textOf(content),
        },
      },
    ];
  if (role !== "assistant" || !Array.isArray(content))
    return message(String(role), time, textOf(content));
  return content.flatMap((block): Item[] => {
    if (!isRecord(block)) return [];
    if (block.type === "text") return message("assistant", time, String(block.text ?? ""));
    if (block.type === "thinking") return thinking(time, String(block.thinking ?? ""));
    if (block.type === "toolCall") return [call(time, block.id, block.name, block.arguments)];
    return [];
  });
}

/** Claude: `assistant` records hold `text`, `thinking` and `tool_use` blocks; the `tool_result` comes in a later `user` record, matched by `tool_use_id`. */
function claudeItems(record: Record<string, any>): Item[] {
  const time = typeof record.timestamp === "string" ? record.timestamp : null;
  if ((record.type !== "assistant" && record.type !== "user") || !isRecord(record.message))
    return [];
  const { content } = record.message;
  if (!Array.isArray(content)) return message(record.type, time, textOf(content));
  return content.flatMap((block): Item[] => {
    if (!isRecord(block)) return [];
    if (block.type === "text") return message(record.type, time, String(block.text ?? ""));
    if (block.type === "thinking") return thinking(time, String(block.thinking ?? ""));
    if (block.type === "tool_use") return [call(time, block.id, block.name, block.input)];
    if (block.type === "tool_result")
      return [
        {
          result: {
            id: String(block.tool_use_id ?? ""),
            status: block.is_error === true ? "error" : "ok",
            text: textOf(block.content),
          },
        },
      ];
    return [];
  });
}

/** The exit status a Codex tool output reports, or "ok" when it reports none. */
export function codexResult(id: unknown, output: unknown): Item {
  let text = textOf(output);
  let failed = isRecord(output) && !Array.isArray(output) && output.success === false;
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output);
      if (isRecord(parsed)) {
        if (typeof parsed.output === "string") text = parsed.output;
        if (typeof parsed.metadata?.exit_code === "number")
          failed = parsed.metadata.exit_code !== 0;
      }
    } catch {
      // plain text output
    }
  }
  const exit = text.match(/(?:process exited with code|exit code:?)\s*(-?\d+)/i);
  if (exit && failed === false && Number(exit[1]) !== 0) failed = true;
  return {
    result: { id: typeof id === "string" ? id : "", status: failed ? "error" : "ok", text },
  };
}

/** Codex: `response_item` records of type `message`, `reasoning`, `function_call` and `function_call_output` (and the `custom_tool_*` pair). */
function codexItems(record: Record<string, any>): Item[] {
  const time = typeof record.timestamp === "string" ? record.timestamp : null;
  if (record.type !== "response_item" || !isRecord(record.payload)) return [];
  const payload = record.payload;
  switch (payload.type) {
    case "message":
      return message(String(payload.role ?? "message"), time, textOf(payload.content));
    case "reasoning":
      return thinking(time, textOf(payload.summary));
    case "function_call":
      return [call(time, payload.call_id, payload.name, payload.arguments)];
    case "custom_tool_call":
      return [call(time, payload.call_id, payload.name, payload.input)];
    case "function_call_output":
    case "custom_tool_call_output":
      return [codexResult(payload.call_id, payload.output)];
    default:
      return [];
  }
}

const readers: Record<Harness, (record: Record<string, any>) => Item[]> = {
  omp: ompItems,
  claude: claudeItems,
  codex: codexItems,
};

type Source = { size: number; read: (offset: number, length: number) => Buffer };

function openSource(file: string): { source: Source; close: () => void } {
  if (file.endsWith(".zst")) {
    const bytes = Buffer.from(Bun.zstdDecompressSync(readFileSync(file)));
    return {
      source: {
        size: bytes.length,
        read: (offset, length) => bytes.subarray(offset, offset + length),
      },
      close: () => {},
    };
  }
  const descriptor = openSync(file, "r");
  return {
    source: {
      size: fstatSync(descriptor).size,
      read(offset, length) {
        const buffer = Buffer.alloc(length);
        return buffer.subarray(0, readSync(descriptor, buffer, 0, length, offset));
      },
    },
    close: () => closeSync(descriptor),
  };
}

/** Lines from a byte offset, each with the offset after its newline. A last line without a newline is yielded too. */
function* linesFrom(source: Source, from: number): Generator<{ text: string; end: number }> {
  let buffer: Buffer = Buffer.alloc(0);
  let position = from;
  let readAt = from;
  for (;;) {
    const newline = buffer.indexOf(10);
    if (newline >= 0) {
      yield { text: buffer.toString("utf8", 0, newline), end: position + newline + 1 };
      buffer = buffer.subarray(newline + 1);
      position += newline + 1;
      continue;
    }
    if (readAt >= source.size) {
      if (buffer.length > 0) yield { text: buffer.toString("utf8"), end: position + buffer.length };
      return;
    }
    const chunk = source.read(readAt, chunkBytes);
    // A file that shrank under the read ends the read: never loop on an empty chunk.
    readAt = chunk.length === 0 ? source.size : readAt + chunk.length;
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
  }
}

function parse(text: string): Record<string, any> | null {
  try {
    const record = JSON.parse(text);
    return isRecord(record) ? record : null;
  } catch {
    return null;
  }
}

/**
 * One page of a session file, from byte offset `cursor`: whole lines, at most `limit` entries. A
 * tool call gets its `ok` or `error` and the first line of its result from the lines that follow
 * (read past the page end when needed); the result text is cut here, so no full tool result leaves
 * this function. `next` is the offset to pass for the following page, or null at the end of the file.
 */
export function readTranscriptPage(
  file: string,
  harness: Harness,
  cursor: number,
  limit = pageSize,
): TranscriptPage {
  const { source, close } = openSource(file);
  try {
    const itemsOf = readers[harness];
    const entries: TranscriptEntry[] = [];
    const pending = new Map<string, ToolEntry>();
    const resolve = ({ id, status, text }: Result) => {
      const tool = pending.get(id);
      if (!tool) return;
      tool.status = status;
      tool.result = firstLine(text);
      pending.delete(id);
    };
    let next = Math.min(Math.max(0, cursor), source.size);
    const lines = linesFrom(source, next);
    let more = true;
    for (;;) {
      const step = lines.next();
      if (step.done) {
        more = false;
        break;
      }
      const record = parse(step.value.text);
      const items = record ? itemsOf(record) : [];
      const added = items.filter((item) => "entry" in item).length;
      if (entries.length > 0 && entries.length + added > limit) break;
      for (const item of items) {
        if ("result" in item) resolve(item.result);
        else {
          entries.push(item.entry);
          if (item.callId && item.entry.kind === "tool") pending.set(item.callId, item.entry);
        }
      }
      next = step.value.end;
      if (entries.length >= limit) break;
    }
    // Results of the last calls sit after the page: look ahead a bounded distance.
    let looked = 0;
    for (let line = lines.next(); more && !line.done && pending.size > 0; line = lines.next()) {
      looked += 1;
      if (looked > lookaheadLines || line.value.end - next > lookaheadBytes) break;
      const record = parse(line.value.text);
      for (const item of record ? itemsOf(record) : []) if ("result" in item) resolve(item.result);
    }
    return { entries, next: next < source.size ? next : null, size: source.size };
  } finally {
    close();
  }
}
