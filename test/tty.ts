import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Opts = { cwd: string; env: Record<string, string | undefined>; stdin?: Buffer };
export type Result = { exitCode: number; stdout: Buffer; stderr: Buffer };

// Runs `cmd` (bun cli/ark.ts <args>) the way a person or an agent would. `ark gate answer` and `ark run close` need a human at a terminal (ADR 0002), so they run under
// a real pty (test/pty.ts) with the name typed at its prompt: `typed` defaults to the gate (or the outcome), which is what a human types. Every other call, and
// any call with typed = null, runs in a session with no controlling terminal, as an agent's shell does.
export function spawnArk(cmd: string[], opts: Opts, typed?: string | null): Result {
  const args = cmd.slice(2);
  const human = (args[0] === "gate" && args[1] === "answer") || (args[0] === "run" && args[1] === "close");
  const line = typed === undefined ? args[3] : typed;
  if (!human || line === null) return Bun.spawnSync(cmd, { ...opts, detached: true, stdin: opts.stdin ?? "ignore" });
  const tmp = mkdtempSync(join(tmpdir(), "ark-pty-"));
  try {
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "pty.ts"), line, join(tmp, "out"), join(tmp, "err"), ...cmd], { cwd: opts.cwd, env: opts.env });
    return { exitCode: r.exitCode, stdout: readFileSync(join(tmp, "out")), stderr: readFileSync(join(tmp, "err")) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
