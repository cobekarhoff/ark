import { closeSync, existsSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { ArkError } from "../errors.ts";
import { parseClaudeSession } from "./claude.ts";
import { parseCodexSession } from "./codex.ts";
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
  sessionFile: string;
};

export type SessionUsage = {
  file: string;
  cwd: string;
  messages: UsageMessage[];
  contextOverflows: number;
  /** True when the last assistant record is an error: the agent died instead of finishing. */
  crashed: boolean;
};

export type SessionWithKey = SessionUsage & {
  /** Identifies the top-level session; subagent transcripts share their parent's key. */
  sessionKey: string;
};

type Source = {
  root: string;
  parse: (file: string) => SessionUsage;
  /** Session key for a file; the default groups subagent transcripts under their parent. */
  keyFor?: (relativeFile: string) => string;
};

function sources(): Source[] {
  return [
    {
      root: process.env.ARK_OMP_SESSIONS ?? join(homedir(), ".omp", "agent", "sessions"),
      parse: parseOmpSession,
    },
    {
      root: process.env.ARK_CLAUDE_SESSIONS ?? join(homedir(), ".claude", "projects"),
      parse: parseClaudeSession,
    },
    {
      root: process.env.ARK_CODEX_SESSIONS ?? join(homedir(), ".codex", "sessions"),
      parse: parseCodexSession,
      // Rollouts sit in `YYYY/MM/DD/`, so the folder says nothing about the session.
      keyFor: (relativeFile) => `codex/${relativeFile.replace(/\.jsonl$/, "")}`,
    },
  ];
}

/** `<project dir>/<session id>.jsonl` and `<project dir>/<session id>/**\/*.jsonl` share one key. */
function sessionKeyFor(relativeFile: string): string {
  const segments = relativeFile.split(sep);
  return segments.length >= 3
    ? `${segments[0]}/${segments[1]}`
    : `${segments[0]}/${segments[1].replace(/\.jsonl$/, "")}`;
}

/** First `cwd` in the first 64 KiB of a session file; both formats write it near the top. */
function readCwd(file: string): string | null {
  const descriptor = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(65536);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    const match = buffer.toString("utf8", 0, length).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
    return match ? JSON.parse(`"${match[1]}"`) : null;
  } finally {
    closeSync(descriptor);
  }
}

export function isInside(directory: string, parent: string): boolean {
  return directory === parent || directory.startsWith(parent + sep);
}

/** Every session file, from either harness, whose cwd is the run folder or below it. */
export function readUsage(runDirectory: string): SessionWithKey[] {
  const parents = new Set([resolve(runDirectory), realpathSync(runDirectory)]);
  const sessions: SessionWithKey[] = [];
  for (const source of sources()) {
    if (!existsSync(source.root)) continue;
    const relativeFiles = [
      ...new Bun.Glob("**/*.jsonl").scanSync({ cwd: source.root, dot: true }),
    ].sort();
    for (const relativeFile of relativeFiles) {
      const file = join(source.root, relativeFile);
      let cwd: string | null;
      try {
        cwd = readCwd(file);
      } catch {
        throw new ArkError(`cannot read session file ${file}`);
      }
      if (cwd === null || ![...parents].some((parent) => isInside(cwd, parent))) continue;
      const sessionKey = (source.keyFor ?? sessionKeyFor)(relativeFile);
      sessions.push({ ...source.parse(file), sessionKey });
    }
  }
  return sessions;
}
