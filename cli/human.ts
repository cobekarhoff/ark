import { closeSync, existsSync, openSync, readFileSync, readSync, writeSync } from "node:fs";
import { userInfo } from "node:os";
import { boundMainSession } from "./binding";
// `/dev/tty` is only the outside-OMP path; an active OMP session must supply its bound ask transcript.
export function withTerminal<T>(what: string, fn: (confirm: (prompt: string, expected: string) => void) => T): T {
  let fd: number;
  try { fd = openSync("/dev/tty", "r+"); } catch {
    throw new Error(`${what} needs a human at a terminal to type the requested answer; this process has no controlling terminal, so nothing was recorded (ADR 0002)`);
  }
  try {
    return fn((prompt, expected) => {
      writeSync(fd, prompt);
      const byte = Buffer.alloc(1);
      let typed = "";
      while (readSync(fd, byte, 0, 1, null) === 1 && byte[0] !== 10) typed += String.fromCharCode(byte[0]);
      if (typed.trim() !== expected) throw new Error(`typed '${typed.trim()}', expected '${expected}'; nothing was recorded`);
    });
  } finally { closeSync(fd); }
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

function askProof(dir: string, runId: string, action: string, answer: string, packetHash: string, choices: string[]) {
  const bound = boundMainSession(dir);
  if (!bound || !existsSync(bound.file)) return undefined;
  const parsed = readFileSync(bound.file, "utf8").split("\n").filter(Boolean).map((line) => {
    try { return object(JSON.parse(line)); } catch { return undefined; }
  });
  if (parsed.some((entry) => !entry)) return undefined;
  const records = parsed as JsonObject[];
  const headers = records.filter((entry) => entry.type === "session");
  if (headers.length !== 1 || headers[0].id !== bound.id) return undefined;
  const question = questionFor(action, runId, packetHash, choices);
  for (let i = records.length - 1; i >= 0; i--) {
    const resultEntry = records[i];
    const result = object(resultEntry.message);
    const details = object(result?.details);
    if (resultEntry.type !== "message" || result?.role !== "toolResult" || result.toolName !== "ask" ||
        !Array.isArray(result.content) || !result.content.some((part) => object(part)?.type === "text" && typeof object(part)?.text === "string") ||
        result.isError !== false || result.cancelled === true || details?.cancelled === true ||
        details?.question !== question || details.multi !== false || details.timedOut === true ||
        details.customInput !== undefined || details.note !== undefined ||
        JSON.stringify(details.options) !== JSON.stringify(choices) ||
        JSON.stringify(details.selectedOptions) !== JSON.stringify([answer])) continue;
    const callId = result.toolCallId;
    if (typeof callId !== "string") continue;
    const callIndex = records.findLastIndex((entry, index) => {
      const message = object(entry.message);
      const content = message?.content;
      return index < i && entry.type === "message" && message?.role === "assistant" && Array.isArray(content) &&
        content.some((part) => {
          const toolCall = object(part);
          const args = object(toolCall?.arguments);
          const questions = Array.isArray(args?.questions) ? args.questions : undefined;
          const question = object(questions?.[0]);
          const options = question?.options;
          return toolCall?.type === "toolCall" && toolCall.id === callId && toolCall.name === "ask" &&
            Array.isArray(questions) && questions.length === 1 && typeof question?.id === "string" &&
            question.question === questionFor(action, runId, packetHash, choices) &&
            (question.multi === false || question.multi === undefined) && question.recommended === undefined &&
            Array.isArray(options) && JSON.stringify(options.map((option) => object(option)?.label)) === JSON.stringify(choices);
        });
    });
    if (callIndex < 0 || records.slice(callIndex + 1, i).some((entry) => {
      const message = object(entry.message);
      const content = message?.content;
      return entry.type === "message" && (
        (message?.role === "toolResult" && message.toolCallId === callId) ||
        (message?.role === "assistant" && Array.isArray(content) && content.some((part) => {
          const toolCall = object(part);
          return toolCall?.type === "toolCall" && toolCall.id === callId;
        }))
      );
    })) continue;
    return { session_id: bound.id, ask_call_id: callId, question };
  }
  return undefined;
}

export function confirmHuman(dir: string, runId: string, action: string, answer: string, packetHash: string, choices: string[]): HumanIdentity {
  const bound = boundMainSession(dir);
  const activeSession = process.env.PI_SESSION_ID;
  if (activeSession && activeSession !== bound?.id) {
    throw new Error("human confirmation must be submitted from the bound main OMP session or outside OMP");
  }
  if (!choices.length || !choices.includes(answer)) throw new Error(`invalid human confirmation choices for ${action}`);
  const proof = askProof(dir, runId, action, answer, packetHash, choices);
  if (!proof) throw new Error(`no matching successful ask result for ${action} in the bound main OMP session; nothing was recorded. Ask the human exactly this question, single choice, options ${choices.join(", ")}, no recommended option, then retry:\n${questionFor(action, runId, packetHash, choices)}`);
  const who = approver();
  if (activeSession) return { ...who, channel: "omp", ...proof };
  return withTerminal("a human confirmation", (confirm) => {
    confirm(`${runId}: ${action}; packet ${packetHash}; answer '${answer}'\nType ${answer} to confirm: `, answer);
    return { ...who, channel: "tty", ...proof };
  });
}

export function verifyHumanProof(dir: string, runId: string, action: string, answer: string, packetHash: string, choices: string[], identity: HumanIdentity): boolean {
  if (identity.channel === "omp" && process.env.PI_SESSION_ID !== identity.session_id) return false;
  const proof = askProof(dir, runId, action, answer, packetHash, choices);
  return !!proof && proof.session_id === identity.session_id && proof.ask_call_id === identity.ask_call_id && proof.question === identity.question;
}

const git = (key: string) => Bun.spawnSync(["git", "config", key]).stdout.toString().trim();

// Who answered: the OS user and the git identity of the process the human typed in.
export function approver() {
  const [os_user, git_name, git_email] = [userInfo().username, git("user.name"), git("user.email")];
  if (!git_name || !git_email) throw new Error("git config user.name and user.email must be set to record the approver");
  return { by: `${git_name} <${git_email}> (${os_user})`, os_user, git_name, git_email };
}
