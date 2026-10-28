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
  parentId?: string | null; // the entry the call hangs from; default is the transcript's active leaf
};

// The id a new entry hangs from, as OMP replays it: the newest entry selects itself unless it carries the leaf it interrupted.
export function activeLeaf(sessionFile: string): string | null {
  if (!existsSync(sessionFile)) return null;
  const entries = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((e) => e.type !== "session" && e.type !== "title");
  const last = entries.at(-1);
  return last ? (last.activeLeafId !== undefined ? last.activeLeafId : last.id) : null;
}

let entrySequence = 0;
// A transcript starts with its title slot and header, as OMP writes them. `ark run start` binds a session only when its transcript is readable (cli/binding.ts).
export function ensureTranscript(sessionFile: string, sessionId: string = MAIN_SESSION_ID): void {
  if (existsSync(sessionFile) && statSync(sessionFile).size > 0) return;
  const header = [{ type: "title", title: "ark test session" }, { type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: tmpdir() }];
  writeFileSync(sessionFile, header.map((line) => `${JSON.stringify(line)}\n`).join(""));
}

// Appends one tree entry the way OMP writes it (id, parentId, and the header first): `parentId` defaults to the active leaf. Returns the entry's id.
export function appendEntry(sessionFile: string, entry: Record<string, unknown>, opts: { parentId?: string | null; sessionId?: string } = {}): string {
  ensureTranscript(sessionFile, opts.sessionId);
  const id = `e${++entrySequence}-${crypto.randomUUID().slice(0, 8)}`;
  const parentId = opts.parentId === undefined ? activeLeaf(sessionFile) : opts.parentId;
  writeFileSync(sessionFile, `${JSON.stringify({ id, parentId, timestamp: new Date().toISOString(), ...entry })}\n`, { flag: "a" });
  return id;
}

// Appends what OMP writes when the human answers an `ask` call: an assistant message holding the toolCall, then the toolResult, chained on the active branch. Like real OMP,
// the result details have no customInput or note key unless the human typed one, and no timedOut key unless the ask timed out. Returns the call and result entry ids.
export function appendAskProof(sessionFile: string, proof: AskProof): { call: string; result: string } {
  const sessionId = proof.sessionId ?? MAIN_SESSION_ID;
  const toolCallId = proof.toolCallId ?? `ask-${++askProofSequence}`;
  const question = proof.question ?? `Ark ${proof.action} for run ${proof.runId}; packet ${proof.packetHash}. Choose exactly one: ${proof.choices.join(", ")}.`;
  const call = appendEntry(sessionFile, askCall(toolCallId, question, proof.choices), { parentId: proof.parentId, sessionId });
  const result = appendEntry(sessionFile, askResult(toolCallId, question, proof), { parentId: call, sessionId });
  return { call, result };
}

// The assistant entry body holding an `ask` tool call; its result, if any, is a separate entry.
export const askCall = (toolCallId: string, question: string, choices: string[]) => ({
  type: "message",
  message: {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: toolCallId,
      name: "ask",
      arguments: { questions: [{ id: `question-${toolCallId}`, question, options: choices.map((label) => ({ label })), multi: false }] },
    }],
  },
});

// The toolResult entry body OMP writes for an ask answer; a re-answer writes another one under the same call.
export const askResult = (toolCallId: string, question: string, proof: Pick<AskProof, "answer" | "choices" | "customInput" | "timedOut">) => ({
  type: "message",
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
});

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
