import { readTerminalTail } from "./orca.ts";
import { switchTerminal, type Agent, type Item } from "./types.ts";

/** A live agent whose last output shows a provider usage-limit or rate-limit error. */
export type UsageLimit = {
  agent: Agent;
  provider: string;
  /** When the output gives a wait time: the time the hub first read this error, plus that wait. */
  resetAt: string | null;
  /** The error line. The same line in the next read is the same error, so its reset time stays. */
  line: string;
};

const errorPattern =
  /usage[_ ]limit|rate[_ -]?limit(?:[_ ]?(?:error|exceeded|reached))|too many requests|quota (?:exceeded|exhausted)|exceeded your (?:current )?quota/i;
const resetTrigger =
  /(?:resets?[_ ]in|retry[_ -]after|try again in|wait(?:ing)?(?: time)?)(?:_?(seconds|secs?|ms|milliseconds|minutes|mins?))?/i;
const durationToken =
  /[\s"':=,]*(\d+)\s*(milliseconds|ms|seconds|secs?|s|minutes|mins?|m|hours?|h)?\b/iy;
const secondsPerUnit: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600 };

/** The wait in seconds that a line gives, such as `resets_in_seconds: 4805`, `retry after 90000 ms` or `try again in 1h 20m`. Null when it gives none. */
export function parseWaitSeconds(text: string): number | null {
  const trigger = resetTrigger.exec(text);
  if (!trigger) return null;
  const keyUnit = trigger[1] ?? "s";
  let seconds = 0;
  let found = false;
  durationToken.lastIndex = trigger.index + trigger[0].length;
  for (let token = durationToken.exec(text); token; token = durationToken.exec(text)) {
    if (found && !token[2]) break;
    const unit = token[2] ?? keyUnit;
    const unitKey = /^(ms|milli)/i.test(unit) ? "ms" : unit[0].toLowerCase();
    seconds += Number(token[1]) * secondsPerUnit[unitKey];
    found = true;
  }
  return found ? Math.round(seconds) : null;
}

const providerOf = (text: string, agent: Agent): string => {
  if (/claude|anthropic/i.test(text)) return "claude";
  if (/gemini|google/i.test(text)) return "gemini";
  if (/codex|openai|chatgpt|usage_limit_reached/i.test(text)) return "codex";
  return agent.model ?? "unknown";
};

/** The usage limit that the tail shows, or null. `previous` keeps the reset time of an error that the tail still shows. */
export function matchUsageLimit(
  tail: string[],
  agent: Agent,
  previous: UsageLimit | undefined,
  now = Date.now(),
): UsageLimit | null {
  let at = -1;
  for (let index = tail.length - 1; index >= 0 && at < 0; index--)
    if (errorPattern.test(tail[index])) at = index;
  if (at < 0) return null;
  const line = tail[at].trim();
  // The wait may sit on the error line or in the lines around it.
  const context = tail.slice(Math.max(0, at - 2), at + 3).join(" ");
  const wait = parseWaitSeconds(context);
  const resetAt =
    previous?.line === line
      ? previous.resetAt
      : wait === null
        ? null
        : new Date(now + wait * 1000).toISOString();
  return { agent, provider: providerOf(context, agent), resetAt, line };
}

/**
 * Reads the tail of each live agent terminal in parallel and returns the usage limits by terminal
 * handle. An agent that exited, or whose tail shows no error, has no entry. A failed read or an
 * unknown liveness keeps the previous entry: it is never turned into "no error".
 */
export async function readUsageLimits(
  agents: Agent[],
  previous: Map<string, UsageLimit>,
): Promise<Map<string, UsageLimit>> {
  const limits = new Map<string, UsageLimit>();
  await Promise.all(
    agents.map(async (agent) => {
      const handle = agent.terminal;
      if (!handle || ["dead", "exited", "done"].includes(agent.liveness)) return;
      const old = previous.get(handle);
      const tail = agent.liveness === "unknown" ? "unknown" : await readTerminalTail(handle);
      const found =
        tail === "unknown" ? (old ? { ...old, agent } : null) : matchUsageLimit(tail, agent, old);
      if (found) limits.set(handle, found);
    }),
  );
  return limits;
}

/** One usage_limit Needs-me item for each blocked agent. */
export function limitItems(
  limits: Map<string, UsageLimit>,
  ticketOf: (run: string) => string | null,
  since: (id: string) => string,
): Item[] {
  return [...limits].map(([handle, { agent, provider, resetAt }]) => {
    const id = `limit:${agent.run}:${handle}`;
    return {
      id,
      kind: "usage_limit",
      source: "orca",
      project: agent.project,
      ticket: ticketOf(agent.run),
      title: `${provider} ${agent.role} "${agent.title}" is blocked: usage limit`,
      since: since(id),
      action: switchTerminal(handle, "Open in Orca"),
      limit: { provider, reset_at: resetAt },
    };
  });
}
