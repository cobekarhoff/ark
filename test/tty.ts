import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Opts = { cwd: string; env: Record<string, string | undefined>; stdin?: Buffer; noProof?: boolean };
let askProofSequence = 0;

export type Result = { exitCode: number; stdout: Buffer; stderr: Buffer };

export const GATE_CHOICES: Record<string, string[]> = {
  G0: ["accept", "edit", "abort"],
  G1: ["approve", "change", "abort"],
  G2: ["approve", "send_back", "abort"],
  GE: ["one_more_round", "take_over", "abort"],
};

// Where the test run's main OMP session transcript lives: `ark run start` binds it through PI_SESSION_ID/PI_SESSION_FILE (spawnArk exports both).
export const MAIN_SESSION_ID = "ark-main-session";
export const mainSessionFile = (home: string) => join(home, "test-main-session.jsonl");

export type AskProof = {
  action: string;
  runId: string;
  answer: string;
  packetHash: string;
  choices: string[];
  timedOut?: boolean;
  customInput?: string;
  sessionId?: string;
  toolCallId?: string;
  question?: string;
};

// Appends what OMP writes when the human answers an `ask` call: an assistant message holding the toolCall, then the toolResult. Like real OMP, the result details
// have no customInput or note key unless the human typed one, and no timedOut key unless the ask timed out. The header follows a title record, as in a real transcript.
export function appendAskProof(sessionFile: string, proof: AskProof): void {
  const sessionId = proof.sessionId ?? MAIN_SESSION_ID;
  const toolCallId = proof.toolCallId ?? `ask-${++askProofSequence}`;
  const question = proof.question ?? `Ark ${proof.action} for run ${proof.runId}; packet ${proof.packetHash}. Choose exactly one: ${proof.choices.join(", ")}.`;
  const empty = !existsSync(sessionFile) || statSync(sessionFile).size === 0;
  const timestamp = new Date().toISOString();
  const lines = [
    ...(empty ? [{ type: "title", title: "ark test session" }, { type: "session", version: 3, id: sessionId, timestamp, cwd: tmpdir() }] : []),
    {
      type: "message",
      timestamp,
      message: {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: toolCallId,
          name: "ask",
          arguments: { questions: [{ id: `question-${toolCallId}`, question, options: proof.choices.map((label) => ({ label })), multi: false }] },
        }],
      },
    },
    {
      type: "message",
      timestamp,
      message: {
        role: "toolResult",
        toolName: "ask",
        toolCallId,
        content: [{ type: "text", text: proof.answer }],
        details: {
          question,
          options: proof.choices,
          multi: false,
          selectedOptions: [proof.answer],
          ...(proof.customInput === undefined ? {} : { customInput: proof.customInput }),
          ...(proof.timedOut ? { timedOut: true } : {}),
        },
        isError: false,
      },
    },
  ];
  writeFileSync(sessionFile, lines.map((line) => `${JSON.stringify(line)}\n`).join(""), { flag: "a" });
}

// Runs `cmd` (bun cli/ark.ts <args>) the way a person or an agent would. Every call carries the main session's PI_SESSION_ID/PI_SESSION_FILE (a caller's own win), so
// `ark run start` binds the run to it. `ark gate answer` and `ark run close` need a human at a terminal (ADR 0002), so they run under a real pty (test/pty.ts) with
// the typed line: `typed` defaults to the gate (or the outcome), which is what a human types. A gate answer also gets the human's matching `ask` answer appended to the
// main session first (`noProof` skips it; `ark run close` and implementer steps need a packet hash, so their callers append the proof). typed = null is no human at all:
// no proof, no terminal, as an agent's shell runs.
export function spawnArk(cmd: string[], opts: Opts, typed?: string | null): Result {
  const { noProof, ...spawnOpts } = opts;
  const args = cmd.slice(2);
  const gateAnswer = args[0] === "gate" && args[1] === "answer";
  const human = gateAnswer || (args[0] === "run" && args[1] === "close");
  const line = typed === undefined ? args[3] : typed;
  const home = opts.env.ARK_HOME as string;
  const env = {
    ...opts.env,
    PI_SESSION_ID: opts.env.PI_SESSION_ID ?? MAIN_SESSION_ID,
    PI_SESSION_FILE: opts.env.PI_SESSION_FILE ?? mainSessionFile(home),
  };
  if (human && line !== null && gateAnswer && !noProof && Object.hasOwn(GATE_CHOICES, args[3]) && GATE_CHOICES[args[3]].includes(args[4])) {
    appendAskProof(mainSessionFile(home), { action: `gate.answered:${args[3]}`, runId: args[2], answer: args[4], packetHash: args[6], choices: GATE_CHOICES[args[3]] });
  }
  if (!human || line === null) return Bun.spawnSync(cmd, { ...spawnOpts, env, detached: true, stdin: opts.stdin ?? "ignore" });
  const tmp = mkdtempSync(join(tmpdir(), "ark-pty-"));
  try {
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "pty.ts"), line, join(tmp, "out"), join(tmp, "err"), ...cmd], { cwd: opts.cwd, env });
    return { exitCode: r.exitCode, stdout: readFileSync(join(tmp, "out")), stderr: readFileSync(join(tmp, "err")) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
