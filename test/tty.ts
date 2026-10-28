import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Options = { cwd: string; env: Record<string, string | undefined>; stdin?: Buffer; noProof?: boolean };
let askProofSequence = 0;

export type Result = { exitCode: number; stdout: Buffer; stderr: Buffer };

export const GATE_CHOICES: Record<string, string[]> = {
  criteria: ["accept", "edit", "abort"],
  plan: ["approve", "change", "abort"],
  evidence: ["approve", "send_back", "abort"],
  escalation: ["one_more_round", "take_over", "abort"],
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
  const entries = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.type !== "session" && event.type !== "title");
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
export function appendEntry(sessionFile: string, entry: Record<string, unknown>, options: { parentId?: string | null; sessionId?: string } = {}): string {
  ensureTranscript(sessionFile, options.sessionId);
  const id = `e${++entrySequence}-${crypto.randomUUID().slice(0, 8)}`;
  const parentId = options.parentId === undefined ? activeLeaf(sessionFile) : options.parentId;
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
export function spawnArk(command: string[], options: Options, typed?: string | null): Result {
  const { noProof, ...spawnOptions } = options;
  const argumentsList = command.slice(2);
  const gateAnswer = argumentsList[0] === "gate" && argumentsList[1] === "answer";
  const human = gateAnswer || (argumentsList[0] === "run" && argumentsList[1] === "close");
  const line = typed === undefined ? argumentsList[3] : typed;
  const home = options.env.ARK_HOME as string;
  const environment = {
    ...options.env,
    PI_SESSION_ID: options.env.PI_SESSION_ID ?? MAIN_SESSION_ID,
    PI_SESSION_FILE: options.env.PI_SESSION_FILE ?? mainSessionFile(home),
  };
  if (human && line !== null && gateAnswer && !noProof && Object.hasOwn(GATE_CHOICES, argumentsList[3]) && GATE_CHOICES[argumentsList[3]].includes(argumentsList[4])) {
    appendAskProof(mainSessionFile(home), { action: `gate.answered:${argumentsList[3]}`, runId: argumentsList[2], answer: argumentsList[4], packetHash: argumentsList[6], choices: GATE_CHOICES[argumentsList[3]] });
  }
  if (!human || line === null) return Bun.spawnSync(command, { ...spawnOptions, env: environment, detached: true, stdin: options.stdin ?? "ignore" });
  const temporaryPath = mkdtempSync(join(tmpdir(), "ark-pty-"));
  try {
    const result = Bun.spawnSync(["bun", join(import.meta.dir, "pty.ts"), line, join(temporaryPath, "out"), join(temporaryPath, "err"), ...command], { cwd: options.cwd, env: environment });
    return { exitCode: result.exitCode, stdout: readFileSync(join(temporaryPath, "out")), stderr: readFileSync(join(temporaryPath, "err")) };
  } finally {
    rmSync(temporaryPath, { recursive: true, force: true });
  }
}
