import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

// Bind the run to the session id and transcript path exported by OMP's bash or typed-tool context.
// `.main-session` is write-once per run so a resumed subagent cannot replace the original main transcript.
const SESSION_ID = /^[\w.-]+$/;
const file = (session: string) => join(process.env.ARK_HOME ?? join(homedir(), ".ark"), "bindings", session);

export function bindSession(runDir: string): void {
  const session = process.env.PI_SESSION_ID;
  const transcript = process.env.PI_SESSION_FILE;
  if (!session || !SESSION_ID.test(session) || !transcript) return;
  mkdirSync(join(file(session), ".."), { recursive: true });
  writeFileSync(file(session), `${runDir}\n`);
  const main = join(runDir, ".main-session");
  try { writeFileSync(main, JSON.stringify({ id: session, file: transcript }), { flag: "wx" }); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
}

export function boundMainSession(runDir: string): { id: string; file: string } | undefined {
  const path = join(runDir, ".main-session");
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    // The orchestrator can write inside the run folder, so a transcript there could be forged: it must live outside.
    const inside = (file: string) => { const rel = relative(realpathSync(runDir), file); return rel === "" || (rel !== ".." && !rel.startsWith("../")); };
    const outside = typeof value.file === "string" && isAbsolute(value.file) && !inside(existsSync(value.file) ? realpathSync(value.file) : value.file);
    return typeof value.id === "string" && SESSION_ID.test(value.id) && outside
      ? value as { id: string; file: string }
      : undefined;
  } catch { return undefined; }
}

export function claimHumanAsk(session: string, callId: string): boolean {
  const used = join(process.env.ARK_HOME ?? join(homedir(), ".ark"), "bindings", "used");
  mkdirSync(used, { recursive: true });
  const key = createHash("sha256").update(`${session}\n${callId}`).digest("hex");
  try { writeFileSync(join(used, key), "", { flag: "wx" }); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
    throw error;
  }
}

// The run folder the session is bound to, or undefined when it never started a run.
export function boundRunDir(session: unknown): string | undefined {
  if (typeof session !== "string" || !SESSION_ID.test(session) || !existsSync(file(session))) return undefined;
  return readFileSync(file(session), "utf8").trim();
}
