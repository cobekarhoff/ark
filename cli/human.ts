import { closeSync, existsSync, openSync, readFileSync, readSync, writeSync } from "node:fs";
import { userInfo } from "node:os";
import { boundMainSession, hasSessionInit } from "./binding";
// `/dev/tty` is only the outside-OMP path; an active OMP session must supply its bound ask transcript.
export function withTerminal<T>(what: string, operation: (confirm: (prompt: string, expected: string) => void) => T): T {
  let fileDescriptor: number;
  try { fileDescriptor = openSync("/dev/tty", "r+"); } catch {
    throw new Error(`${what} needs a human at a terminal to type the requested answer; this process has no controlling terminal, so no answer was recorded (Architecture Decision Record (ADR) 0002)`);
  }
  try {
    return operation((prompt, expected) => {
      writeSync(fileDescriptor, prompt);
      const byte = Buffer.alloc(1);
      let typed = "";
      while (readSync(fileDescriptor, byte, 0, 1, null) === 1 && byte[0] !== 10) typed += String.fromCharCode(byte[0]);
      if (typed.trim() !== expected) throw new Error(`typed '${typed.trim()}', expected '${expected}'; no answer was recorded`);
    });
  } finally { closeSync(fileDescriptor); }
}

export type HumanIdentity = {
  by: string;
  os_user: string;
  git_name: string;
  git_email: string;
  channel: "omp" | "tty";
  session_id?: string;
  ask_call_id?: string;
  question?: string;
};

const questionFor = (action: string, runId: string, packetHash: string, choices: string[]) =>
  `Ark ${action} for run ${runId}; packet ${packetHash}. Choose exactly one: ${choices.join(", ")}.`;

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;

// The active branch of an OMP transcript: the transcript is a tree, and /tree navigation, a re-answered ask and a branch summary leave abandoned or superseded
// entries in the file. The leaf is replayed as OMP does (session-entries.ts `sessionEntryLeafId`, `resolveSessionLeafId`, `lastSelfSelectedLeafId`): the newest entry
// selects itself unless it carries the `activeLeafId` it interrupted; a captured leaf that no longer exists falls back to the newest self-selecting entry.
// Then the path is walked from the leaf to the root through `parentId`, stopping at a repeated id.
function activePath(entries: JsonObject[]): JsonObject[] | undefined {
  const byId = new Map<string, JsonObject>();
  for (const entry of entries) {
    if (typeof entry.id !== "string") return undefined;
    byId.set(entry.id, entry);
  }
  const leafOf = (entry: JsonObject) => entry.activeLeafId !== undefined ? entry.activeLeafId : entry.id;
  const last = entries.at(-1);
  if (!last) return undefined;
  let leaf = leafOf(last);
  if (leaf !== null && leaf !== last.id && !(typeof leaf === "string" && byId.has(leaf))) leaf = entries.findLast((entry) => leafOf(entry) === entry.id)?.id ?? null;
  const path: JsonObject[] = [];
  const seen = new Set<string>();
  for (let entry = typeof leaf === "string" ? byId.get(leaf) : undefined; entry && !seen.has(entry.id as string); entry = typeof entry.parentId === "string" ? byId.get(entry.parentId) : undefined) {
    seen.add(entry.id as string);
    path.push(entry);
  }
  return path.reverse();
}

// The newest ask call on the active branch for this exact question must have exactly one successful result selecting the submitted answer. The call is the anchor, not
// its result: a cancelled ask (ToolAbortError, an error result with no details) or a chat redirect (details without `question`) carries no question text, but it is still
// the human's latest word, so it refuses and an older answer on the path never counts.
function askProof(directory: string, runId: string, action: string, answer: string, packetHash: string, choices: string[]) {
  const bound = boundMainSession(directory);
  if (!bound || !existsSync(bound.file)) return undefined;
  const parsed = readFileSync(bound.file, "utf8").split("\n").filter(Boolean).map((line) => {
    try { return object(JSON.parse(line)); } catch { return undefined; }
  });
  if (parsed.some((entry) => !entry)) return undefined;
  const records = parsed as JsonObject[];
  if (hasSessionInit(readFileSync(bound.file, "utf8").split("\n"))) return undefined; // a subagent's transcript, bound while it was not on disk yet, proves nothing
  const headers = records.filter((entry) => entry.type === "session");
  if (headers.length !== 1 || headers[0].id !== bound.id) return undefined;
  const path = activePath(records.filter((entry) => entry.type !== "session" && entry.type !== "title")); // the header and the title slot are not tree entries
  if (!path) return undefined;
  const question = questionFor(action, runId, packetHash, choices);
  const messages = path.map((entry) => entry.type === "message" ? object(entry.message) : undefined);
  const askCalls = messages.flatMap((message, index) =>
    message?.role === "assistant" && Array.isArray(message.content)
      ? message.content.flatMap((part) => { const call = object(part); return call?.type === "toolCall" && call.name === "ask" ? [{ index, call }] : []; })
      : []);
  const asked = askCalls.findLast(({ call }) => {
    const questions = object(call.arguments)?.questions;
    return Array.isArray(questions) && questions.some((questionEntry) => object(questionEntry)?.question === question);
  });
  if (!asked) return undefined;
  const { call } = asked;
  const callId = call.id;
  const questions = object(call.arguments)?.questions as unknown[];
  const first = object(questions[0]);
  const options = first?.options;
  if (typeof callId !== "string" || questions.length !== 1 || typeof first?.id !== "string" || first.question !== question ||
      !(first.multi === false || first.multi === undefined) || first.recommended !== undefined ||
      !Array.isArray(options) || JSON.stringify(options.map((option) => object(option)?.label)) !== JSON.stringify(choices)) return undefined;
  // One call and one result under this id on the whole active branch, the result after the call.
  if (askCalls.filter((askCall) => askCall.call.id === callId).length !== 1) return undefined;
  const results = messages.flatMap((message, index) => message?.role === "toolResult" && message.toolCallId === callId ? [{ index, result: message }] : []);
  if (results.length !== 1 || results[0].index <= asked.index) return undefined;
  const result = results[0].result;
  const details = object(result.details);
  if (result.toolName !== "ask" || !Array.isArray(result.content) || !result.content.some((part) => object(part)?.type === "text" && typeof object(part)?.text === "string") ||
      result.isError !== false || result.cancelled === true || details?.cancelled === true ||
      details?.question !== question || details.multi !== false || details.timedOut === true ||
      details.customInput !== undefined || details.note !== undefined ||
      JSON.stringify(details.options) !== JSON.stringify(choices) ||
      JSON.stringify(details.selectedOptions) !== JSON.stringify([answer])) return undefined;
  return { session_id: bound.id, ask_call_id: callId, question };
}

export function confirmHuman(directory: string, runId: string, action: string, answer: string, packetHash: string, choices: string[]): HumanIdentity {
  const bound = boundMainSession(directory);
  const activeSession = process.env.PI_SESSION_ID;
  if (activeSession && activeSession !== bound?.id) {
    throw new Error("human confirmation must be submitted from the bound main Oh My Pi (OMP) session or outside Oh My Pi (OMP)");
  }
  if (!choices.length || !choices.includes(answer)) throw new Error(`invalid human confirmation choices for ${action}`);
  const proof = askProof(directory, runId, action, answer, packetHash, choices);
  if (!proof) throw new Error(`no matching successful ask result for ${action} in the bound main Oh My Pi (OMP) session; no answer was recorded. Ask the human exactly this question, single choice, options ${choices.join(", ")}, no recommended option, then retry:\n${questionFor(action, runId, packetHash, choices)}`);
  const who = approver();
  if (activeSession) return { ...who, channel: "omp", ...proof };
  return withTerminal("a human confirmation", (confirm) => {
    confirm(`${runId}: ${action}; packet ${packetHash}; answer '${answer}'\nType ${answer} to confirm: `, answer);
    return { ...who, channel: "tty", ...proof };
  });
}

export function verifyHumanProof(directory: string, runId: string, action: string, answer: string, packetHash: string, choices: string[], identity: HumanIdentity): boolean {
  if (identity.channel === "omp" && process.env.PI_SESSION_ID !== identity.session_id) return false;
  const proof = askProof(directory, runId, action, answer, packetHash, choices);
  return !!proof && proof.session_id === identity.session_id && proof.ask_call_id === identity.ask_call_id && proof.question === identity.question;
}

const git = (key: string) => Bun.spawnSync(["git", "config", key]).stdout.toString().trim();

// Who answered: the OS user and the git identity of the process the human typed in.
export function approver() {
  const [os_user, git_name, git_email] = [userInfo().username, git("user.name"), git("user.email")];
  if (!git_name || !git_email) throw new Error("git config user.name and user.email must be set to record the approver");
  return { by: `${git_name} <${git_email}> (${os_user})`, os_user, git_name, git_email };
}
