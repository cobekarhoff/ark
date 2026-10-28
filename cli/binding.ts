import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

// Bind the run to the session id and transcript path exported by OMP's bash or typed-tool context.
// Every `ark run start` and resume from a main session rebinds `.main-session` (a restarted or relaunched OMP is a new session id).
// OMP writes a `session_init` entry only into a subagent's transcript (task/executor.ts) or a `/tan` clone's, or after reviving one; a fork neutralizes the ones it inherits.
// A transcript with one is not the orchestrator's, so it never takes the binding, and `askProof` refuses a bound transcript that has one. `parentSession` in the header tells nothing: forks have it too.
// OMP creates a transcript lazily, with the first assistant message, so one that does not exist yet cannot be classified: it may bind only while nothing is bound.
const SESSION_ID = /^[\w.-]+$/;
const file = (session: string) => join(process.env.ARK_HOME ?? join(homedir(), ".ark"), "bindings", session);

export const hasSessionInit = (lines: string[]) => lines.some((line) => {
  if (!line.includes('"session_init"')) return false;
  try { return JSON.parse(line)?.type === "session_init"; } catch { return false; }
});

export function bindSession(runDirectory: string): void {
  const session = process.env.PI_SESSION_ID;
  const transcript = process.env.PI_SESSION_FILE;
  if (!session || !SESSION_ID.test(session) || !transcript) return;
  mkdirSync(join(file(session), ".."), { recursive: true });
  writeFileSync(file(session), `${runDirectory}\n`);
  const mainSessionFile = join(runDirectory, ".main-session");
  const binding = JSON.stringify({ id: session, file: transcript });
  if (existsSync(transcript)) {
    if (!hasSessionInit(readFileSync(transcript, "utf8").split("\n"))) writeFileSync(mainSessionFile, binding);
    return;
  }
  try { writeFileSync(mainSessionFile, binding, { flag: "wx" }); } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
}

export function boundMainSession(runDirectory: string): { id: string; file: string } | undefined {
  const path = join(runDirectory, ".main-session");
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    // The orchestrator can write inside the run folder, so a transcript there could be forged: it must live outside.
    const inside = (file: string) => { const relativePath = relative(realpathSync(runDirectory), file); return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith("../")); };
    const outside = typeof value.file === "string" && isAbsolute(value.file) && !inside(existsSync(value.file) ? realpathSync(value.file) : value.file);
    return typeof value.id === "string" && SESSION_ID.test(value.id) && outside
      ? value as { id: string; file: string }
      : undefined;
  } catch { return undefined; }
}

// One ask result answers once. The key is the question (run, action, packet) with the call id, not the session: a fork or relaunched session replays the same entries
// under a new session id, and the answer must still be spent.
export function claimHumanAsk(question: string, callId: string): boolean {
  const usedAnswersDirectory = join(process.env.ARK_HOME ?? join(homedir(), ".ark"), "bindings", "used");
  mkdirSync(usedAnswersDirectory, { recursive: true });
  const key = createHash("sha256").update(`${question}\n${callId}`).digest("hex");
  try { writeFileSync(join(usedAnswersDirectory, key), "", { flag: "wx" }); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
    throw error;
  }
}

// The run folder the session is bound to, or undefined when it never started a run.
export function boundRunDirectory(session: unknown): string | undefined {
  if (typeof session !== "string" || !SESSION_ID.test(session) || !existsSync(file(session))) return undefined;
  return readFileSync(file(session), "utf8").trim();
}
