/**
 * harness.ts — the PRODUCTION harness adapters (claude-code, omp). @layer core (pure: no I/O, no node types).
 *
 * A harness is a PURE DESCRIPTION (S1: both CLIs are "spawn argv in cwd, JSONL on stdout, exit status, SIGTERM kills the
 * tree"), so launch/detach/SIGTERM/deadlines/transcript capture live once in proc + the attempt handler. Adding a
 * harness = one object here + one HARNESSES entry.
 *
 * Two facts the S1 recordings forced (test/fixtures/harness/):
 *  - Completion is the process exit plus a valid output file (the seal), never an event. `done` below is only an
 *    observation, and a cancelled/aborted run must not produce one: OMP still prints `agent_end` after SIGTERM, with
 *    the last assistant message `stopReason: "aborted"`; Claude Code just stops without a `result` event.
 *  - The two CLIs report cost differently: Claude Code a run total on the final `result` event, OMP a per-message
 *    figure on each assistant `message_end` (the `message_start`/`turn_end` copies of the same message carry partial or
 *    duplicate numbers and are ignored).
 *
 * `usage` signals are INCREMENTS (Claude Code: one, the run total, at the end; OMP: one per assistant message), and
 * `inputTokens` is the harness's own uncached `input_tokens`/`input` field (cache read/write tokens are priced into
 * `costUsd`, which is the authoritative figure).
 */
import type { AbsPath, HarnessId, ModelId } from "./ids.ts";
import type { Signal, Usage } from "./effects.ts";
import { canonicalJson } from "./hash.ts";

export interface Invocation {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** Hash input for RoleBinding.configHash: flags + settings the adapter pins (S1 finding 2). Excludes the prompt. */
  readonly configFingerprint: string;
}

export interface HarnessAdapter {
  readonly id: HarnessId;
  /** Always passes --model explicitly (S1 finding 3) and pins config so the manifest explains the run. */
  invocation(input: { readonly prompt: string; readonly model: ModelId; readonly workdir: AbsPath }): Invocation;
  /** One transcript line -> zero or more observation signals. Never throws; unknown lines -> []. */
  parseLine(line: string): readonly Signal[];
  /** Whole-transcript usage: Claude Code reads result.total_cost_usd, OMP sums per-message usage. null = unknown. */
  usage(transcript: readonly string[]): Usage | null;
}

// ---------------------------------------------------------------- helpers

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function parse(line: string): Json | null {
  try {
    const v: unknown = JSON.parse(line);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

const reported = (inputTokens: number | null, outputTokens: number | null, costUsd: number | null): Usage | null =>
  inputTokens === null && outputTokens === null && costUsd === null ? null : { inputTokens, outputTokens, costUsd, basis: "reported" };

/** `<bin> -p <prompt> <flags...>`; the fingerprint is everything that is not the prompt. */
function invoke(id: string, bin: string, prompt: string, flags: readonly string[]): Invocation {
  const env = {};
  return { argv: [bin, "-p", prompt, ...flags], env, configFingerprint: canonicalJson({ harness: id, bin, flags, env }) };
}

// ---------------------------------------------------------------- claude-code

/** `result` event -> the run total. */
const ccResultUsage = (o: Json): Usage | null => {
  const u = isObj(o.usage) ? o.usage : {};
  return reported(num(u.input_tokens), num(u.output_tokens), num(o.total_cost_usd));
};

const claudeCode: HarnessAdapter = {
  id: "claude-code" as HarnessId,
  invocation: ({ prompt, model }) =>
    invoke("claude-code", "claude", prompt, [
      "--output-format", "stream-json", "--verbose",
      "--permission-mode", "bypassPermissions", // S1 finding 5: headless writes need it (or an allowlist)
      "--model", model,
      // Config isolation (S1 finding 2). UNVERIFIED: the flags exist in `claude --help` (2.1.261) but no run has yet
      // confirmed that together they keep user plugins, user-level MCP servers and skills out of an attempt. Until
      // then configFingerprint only records the intent. `--strict-mcp-config` with no `--mcp-config` = no MCP at all;
      // `--setting-sources project,local` drops user settings (where plugins are enabled).
      "--strict-mcp-config", "--setting-sources", "project,local", "--disable-slash-commands",
    ]),
  parseLine(line) {
    const o = parse(line);
    if (!o) return [];
    if (o.type === "system" && o.subtype === "init") {
      return [{ kind: "lifecycle", phase: "started", msg: `session ${str(o.session_id) ?? "?"} model ${str(o.model) ?? "?"}` }];
    }
    if (o.type === "assistant" && isObj(o.message) && Array.isArray(o.message.content)) {
      const calls: Signal[] = [];
      for (const b of o.message.content) if (isObj(b) && b.type === "tool_use" && typeof b.name === "string") calls.push({ kind: "tool_call", name: b.name });
      return calls;
    }
    if (o.type === "result") {
      const out: Signal[] = [];
      const u = ccResultUsage(o);
      if (u) out.push({ kind: "usage", usage: u });
      const ok = o.subtype === "success" && o.is_error !== true;
      out.push({ kind: "lifecycle", phase: ok ? "done" : "failed", msg: ok ? str(o.result) : str(o.subtype) ?? "error" });
      return out;
    }
    return [];
  },
  usage(transcript) {
    for (let i = transcript.length - 1; i >= 0; i--) {
      const o = parse(transcript[i]!);
      if (o?.type === "result") return ccResultUsage(o);
    }
    return null; // no result event (cancelled/killed run): per-message events repeat partial counts, so we do not sum them
  },
};

// ---------------------------------------------------------------- omp

/** Assistant `message_end` message -> that message's usage. */
const ompMessageUsage = (m: Json): Usage | null => {
  const u = isObj(m.usage) ? m.usage : {};
  return reported(num(u.input), num(u.output), isObj(u.cost) ? num(u.cost.total) : null);
};

const ompAssistantEnd = (o: Json): Json | null =>
  o.type === "message_end" && isObj(o.message) && o.message.role === "assistant" ? o.message : null;

/** A total is only known if every counted message reported it (null = unknown, never a partial sum). */
const sum = (xs: readonly (number | null)[]): number | null =>
  xs.some((x) => x === null) ? null : xs.reduce<number>((a, b) => a + b!, 0);

const omp: HarnessAdapter = {
  id: "omp" as HarnessId,
  invocation: ({ prompt, model }) =>
    invoke("omp", "omp", prompt, [
      "--mode", "json", "--no-title",
      "--model", model,
      // Config isolation (S1 finding 2, option 1). Verified from `omp --help` only. NOT covered: MCP servers from the
      // user's config still load (S1 saw one fail with a 401); only `--profile <name>` isolates those, at the price of
      // a separate login, so it is the upgrade path if MCP residue shows up in a manifest.
      "--no-extensions", "--no-skills", "--no-rules",
    ]),
  parseLine(line) {
    const o = parse(line);
    if (!o) return [];
    if (o.type === "session") return [{ kind: "lifecycle", phase: "started", msg: `session ${str(o.id) ?? "?"}` }];
    if (o.type === "tool_execution_start" && typeof o.toolName === "string") return [{ kind: "tool_call", name: o.toolName }];
    const m = ompAssistantEnd(o);
    if (m) {
      const out: Signal[] = [];
      const model = str(m.model);
      if (model) out.push({ kind: "lifecycle", phase: "progress", msg: `model ${model}` });
      const u = ompMessageUsage(m);
      if (u) out.push({ kind: "usage", usage: u });
      return out;
    }
    if (o.type === "agent_end" && Array.isArray(o.messages)) {
      const last = o.messages.filter((x): x is Json => isObj(x) && x.role === "assistant").at(-1);
      if (!last) return [];
      const stop = str(last.stopReason);
      return [stop === "stop"
        ? { kind: "lifecycle", phase: "done", msg: null }
        : { kind: "lifecycle", phase: "failed", msg: str(last.errorMessage) ?? `stopReason ${stop ?? "?"}` }];
    }
    return [];
  },
  usage(transcript) {
    const us = transcript.flatMap((l) => {
      const o = parse(l);
      const m = o && ompAssistantEnd(o);
      const u = m && ompMessageUsage(m);
      return u ? [u] : [];
    });
    if (us.length === 0) return null;
    return reported(sum(us.map((u) => u.inputTokens)), sum(us.map((u) => u.outputTokens)), sum(us.map((u) => u.costUsd)));
  },
};

/**
 * The PRODUCTION harnesses. Role files can only select ids from the table the composition root passes to
 * `makeAttemptHandler`; tests pass their own table (with a `scripted` shell-script harness) so a test double can never
 * be selected by an environment's role file.
 */
export const HARNESSES: Readonly<Record<string, HarnessAdapter>> = { "claude-code": claudeCode, omp };
