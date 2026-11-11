import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { ArkError } from "../errors.ts";
import { isInside } from "../paths.ts";
import { parseClaudeSession } from "./claude.ts";
import { parseCodexSession, readCodexText } from "./codex.ts";
import { parseOmpSession } from "./omp.ts";

export type UsageMessage = {
  time: string;
  model: string;
  provider: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number | "unknown";
  toolError: boolean;
  /** An omp helper call (`purpose` field: job-caption, job-widget): costs count, its model is not the agent's. */
  helper?: boolean;
  /** The `purpose` of an omp helper call (job-caption, find ...); set exactly when `helper` is. */
  purpose?: string;
  sessionFile: string;
};

/** One failed tool call: the tool, the first word of its command ("" when it has none) and its error text. */
export type FailedCall = { tool: string; word: string; error: string };

/** The first word of a tool command: a string, or a codex argv (`["bash","-lc","<script>"]` gives the script's first word). Anything else gives "". */
export function commandWord(command: unknown): string {
  const first = (text: unknown) =>
    typeof text === "string" ? (text.trim().split(/\s+/)[0] ?? "") : "";
  if (!Array.isArray(command)) return first(command);
  return command[1] === "-lc" && typeof command[2] === "string"
    ? first(command[2])
    : first(command[0]);
}

/** Text of a tool result content field: a string, or the `text` of its blocks. */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .filter((text) => text !== "")
    .join("\n");
}

export type SessionUsage = {
  file: string;
  cwd: string;
  messages: UsageMessage[];
  contextOverflows: number;
  failedCalls: FailedCall[];
  /** True when the last assistant record is an error: the agent died instead of finishing. */
  crashed: boolean;
};

export type SessionWithKey = SessionUsage & {
  /** Identifies the top-level session; subagent transcripts share their parent's key. */
  sessionKey: string;
  /** The harness whose reader parsed the file. Orca names the same harnesses in `agentIdentity`. */
  harness: Harness;
  /** First timestamp in the head of the file (ms), or null when it holds none. */
  start: number | null;
  /** Last write of the file (ms). */
  mtime: number;
};

export type Harness = "omp" | "claude" | "codex";

export const parsers: Record<Harness, (file: string) => SessionUsage> = {
  omp: parseOmpSession,
  claude: parseClaudeSession,
  codex: parseCodexSession,
};

export function sessionRoots(): { harness: Harness; root: string; pattern: string }[] {
  return [
    {
      harness: "omp",
      root: process.env.ARK_OMP_SESSIONS ?? join(homedir(), ".omp", "agent", "sessions"),
      pattern: "**/*.jsonl",
    },
    {
      harness: "claude",
      root: process.env.ARK_CLAUDE_SESSIONS ?? join(homedir(), ".claude", "projects"),
      pattern: "**/*.jsonl",
    },
    {
      harness: "codex",
      root: process.env.ARK_CODEX_SESSIONS ?? join(homedir(), ".codex", "sessions"),
      pattern: "**/*.jsonl{,.zst}",
    },
  ];
}

function sources() {
  return sessionRoots().map((source) => ({
    ...source,
    parse: parsers[source.harness],
    /** Codex rollouts sit in date folders, so the top-level session is the file itself. */
    keyFor:
      source.harness === "codex"
        ? (relativeFile: string) =>
            `codex/${basename(relativeFile).replace(/\.jsonl(\.zst)?$/, "")}`
        : sessionKeyFor,
  }));
}

/** `<project dir>/<session id>.jsonl` and `<project dir>/<session id>/**\/*.jsonl` share one key. */
function sessionKeyFor(relativeFile: string): string {
  const segments = relativeFile.split(sep);
  return segments.length >= 3
    ? `${segments[0]}/${segments[1]}`
    : `${segments[0]}/${segments[1].replace(/\.jsonl$/, "")}`;
}

function findHead(head: string): { cwd: string | null; start: number | null } {
  const cwd = head.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
  const time = head.match(/"timestamp":"([^"]+)"/);
  const start = time ? Date.parse(time[1]) : Number.NaN;
  return { cwd: cwd ? JSON.parse(`"${cwd[1]}"`) : null, start: Number.isNaN(start) ? null : start };
}

/** First `cwd` and first timestamp in the first 64 KiB of a session file; every format writes both near the top. */
export function readHead(file: string): { cwd: string | null; start: number | null } {
  if (file.endsWith(".zst")) return findHead(readCodexText(file).slice(0, 65536));
  const descriptor = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(65536);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    return findHead(buffer.toString("utf8", 0, length));
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Every session file, from either harness, whose cwd is one of the folders or below it, grouped by
 * folder. Scans the session roots once for all folders. A folder that does not exist has no sessions.
 */
export function readUsageIn(directories: string[]): Map<string, SessionWithKey[]> {
  const parents = new Map(
    directories.map((directory) => [
      directory,
      new Set([resolve(directory), ...(existsSync(directory) ? [realpathSync(directory)] : [])]),
    ]),
  );
  const result = new Map<string, SessionWithKey[]>(directories.map((directory) => [directory, []]));
  for (const source of sources()) {
    if (!existsSync(source.root)) continue;
    const relativeFiles = [
      ...new Bun.Glob(source.pattern).scanSync({ cwd: source.root, dot: true }),
    ].sort();
    for (const relativeFile of relativeFiles) {
      const file = join(source.root, relativeFile);
      let head: ReturnType<typeof readHead>;
      try {
        head = readHead(file);
      } catch {
        throw new ArkError(`cannot read session file ${file}`);
      }
      const cwd = head.cwd;
      if (cwd === null) continue;
      const matching = directories.filter((directory) =>
        [...parents.get(directory)!].some((parent) => isInside(cwd, parent)),
      );
      if (matching.length === 0) continue;
      const session = {
        ...source.parse(file),
        sessionKey: source.keyFor(relativeFile),
        harness: source.harness,
        start: head.start,
        mtime: statSync(file).mtimeMs,
      };
      for (const directory of matching) result.get(directory)!.push(session);
    }
  }
  return result;
}

/** Every session file, from either harness, whose cwd is the run folder or below it. */
export function readUsage(runDirectory: string): SessionWithKey[] {
  realpathSync(runDirectory);
  return readUsageIn([runDirectory]).get(runDirectory)!;
}

/**
 * Watches for the session file of a worker that has not started yet. The files that exist now are
 * ignored; each call returns the first new top-level file whose cwd is the worktree or below it.
 * Null when `harness` has no session folder (so there is nothing to wait for).
 */
export function watchSession(harness: string, worktree: string): (() => string | undefined) | null {
  const source = sessionRoots().find((candidate) => candidate.harness === harness);
  if (!source) return null;
  const parents = [resolve(worktree), ...(existsSync(worktree) ? [realpathSync(worktree)] : [])];
  const list = () =>
    existsSync(source.root)
      ? [...new Bun.Glob(source.pattern).scanSync({ cwd: source.root, dot: true })].sort()
      : [];
  const seen = new Set(list());
  return () => {
    for (const relativeFile of list()) {
      if (seen.has(relativeFile)) continue;
      // A subagent transcript sits one folder deeper than its parent session.
      if (harness !== "codex" && relativeFile.split(sep).length !== 2) continue;
      const file = join(source.root, relativeFile);
      let cwd: string | null;
      try {
        cwd = readHead(file).cwd;
      } catch {
        continue; // the worker is still writing it: look again on the next call
      }
      if (cwd === null) continue;
      seen.add(relativeFile);
      if (parents.some((parent) => isInside(cwd, parent))) return file;
    }
    return undefined;
  };
}
