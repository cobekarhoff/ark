import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// A session's binding to its run: `ark run start` (and resume) records the run folder under the OMP session id its bash tool exports (PI_SESSION_ID),
// and the extension reports the same id (ctx.sessionManager.getSessionId()) with every tool call. Global, not per project, so the hook finds it from any cwd.
const SESSION_ID = /^[\w.-]+$/;
const file = (session: string) => join(process.env.ARK_HOME ?? join(homedir(), ".ark"), "bindings", session);

export function bindSession(runDir: string): void {
  const session = process.env.PI_SESSION_ID;
  if (!session || !SESSION_ID.test(session)) return;
  mkdirSync(join(file(session), ".."), { recursive: true });
  writeFileSync(file(session), `${runDir}\n`);
}

// The run folder the session is bound to, or undefined when it never started a run.
export function boundRunDir(session: unknown): string | undefined {
  if (typeof session !== "string" || !SESSION_ID.test(session) || !existsSync(file(session))) return undefined;
  return readFileSync(file(session), "utf8").trim();
}
