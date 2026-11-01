import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { deriveState, type ArkEvent } from "../events.ts";
import { parsers, type TestResult } from "../parsers/index.ts";
import {
  assignSteps,
  collectMessages,
  gateWaits,
  stepWindows,
  summarize,
  type CostGroup,
  type Message,
} from "../retro.ts";
import { mockupPaths, parseCards } from "../strategy.ts";
import { parseEvaluation } from "../evaluation.ts";
import type { RunInfo } from "./ark.ts";
import { readHistory, type HistoryRecord } from "./history.ts";
import { readTerminalTail } from "./orca.ts";
import type { Agent } from "./types.ts";

const notAvailable = { state: "not available" } as const;
type Cost = { usd: number | "unknown"; tokens: number };
const costOf = (group: CostGroup): Cost => ({
  usd: group.includes_unknown ? "unknown" : group.usd,
  tokens: group.tokens,
});

const readFile = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

type CaseView = {
  name: string | null;
  status: TestResult["status"] | "unavailable";
  criteria: string[];
  suite: string;
  report: string;
};

/**
 * Each AC of the latest `test.completed` with its test cases, read from the suite reports in
 * `results/` the way `ark test` read them. A missing or unreadable report, or a suite that
 * `ark.yml` no longer lists, is `unavailable`, never a pass.
 */
function acProof(directory: string, project: string, events: ArkEvent[]) {
  const test = events.findLast((event) => event.type === "test.completed");
  if (!test) return { state: "not available" as const };
  let config: ReturnType<typeof loadConfig> | null = null;
  try {
    config = loadConfig(project);
  } catch {
    // every suite below is unavailable
  }
  const cases: CaseView[] = [];
  for (const suite of test.data.suites as { name: string; level: string }[]) {
    if (suite.level === "unit") continue; // unit suites never prove an AC
    const report = `results/${suite.name}.report`;
    const parser = config?.suites.find((candidate) => candidate.name === suite.name)?.parser;
    const reportText = readFile(join(directory, report));
    if (!parser || !parsers[parser] || reportText === null) {
      cases.push({ name: null, status: "unavailable", criteria: [], suite: suite.name, report });
      continue;
    }
    const stdout = readFile(join(directory, "results", `${suite.name}.log`)) ?? "";
    try {
      for (const result of parsers[parser]({ report: reportText, stdout }))
        cases.push({ ...result, suite: suite.name, report });
    } catch {
      cases.push({ name: null, status: "unavailable", criteria: [], suite: suite.name, report });
    }
  }
  const criteria = Object.entries(test.data.criteria as Record<string, string>).map(
    ([id, status]) => ({
      id,
      status,
      cases: cases.filter((found) => found.status === "unavailable" || found.criteria.includes(id)),
    }),
  );
  return { state: "ok" as const, at: test.time, passed: test.data.passed as boolean, criteria };
}

const gateWait = (events: ArkEvent[], end: number) =>
  gateWaits(events).map((wait) => ({
    gate: wait.gate,
    asked: wait.asked,
    answered: wait.answered,
    answer: wait.answer,
    wait_seconds:
      ((wait.answered ? Date.parse(wait.answered) : end) - Date.parse(wait.asked)) / 1000,
  }));

/** Phase at each event; one row each time it changes. */
function timeline(events: ArkEvent[]) {
  const rows: { phase: string; at: string }[] = [];
  for (let i = 1; i <= events.length; i++) {
    const phase = deriveState(events.slice(0, i)).phase;
    if (rows.at(-1)?.phase !== phase) rows.push({ phase, at: events[i - 1].time });
  }
  return rows;
}

function rounds(events: ArkEvent[]) {
  const byRound = new Map<number, { round: number; at: string; steps: string[] }>();
  for (const event of events) {
    if (event.type !== "step.started") continue;
    const entry = byRound.get(event.data.round) ?? {
      round: event.data.round,
      at: event.time,
      steps: [] as string[],
    };
    entry.steps.push(event.data.step);
    byRound.set(event.data.round, entry);
  }
  return [...byRound.values()];
}

type Split = Record<
  "working" | "waiting_human" | "waiting_ci_or_paused" | "stalled" | "unavailable",
  number
>;

/**
 * Splits [start, end] into parts that add up to the whole. A moment counts as waiting on the
 * human while a gate is open (events say so, with or without history). Before the first
 * history record nothing else is known, so that time is unavailable. After it, a stuck, dead or
 * exited agent is stalled; a paused agent or a pending CI check is waiting on CI or paused;
 * anything else is working.
 * ponytail: a state holds until its next record, so a hub that was down counts as unchanged.
 */
function timeSplit(
  waits: { asked: string; answered: string | null }[],
  history: HistoryRecord[],
  start: number,
  end: number,
): Split {
  const split: Split = {
    working: 0,
    waiting_human: 0,
    waiting_ci_or_paused: 0,
    stalled: 0,
    unavailable: 0,
  };
  const records = history.map((record) => ({ ...record, at: Date.parse(record.time) }));
  const collected =
    records.length === 0 ? Infinity : Math.min(...records.map((record) => record.at));
  const gates = waits.map((wait) => [
    Date.parse(wait.asked),
    wait.answered ? Date.parse(wait.answered) : end,
  ]);
  const cuts = [
    ...new Set([start, end, collected, ...gates.flat(), ...records.map((record) => record.at)]),
  ]
    .filter((time) => time >= start && time <= end)
    .sort((left, right) => left - right);
  for (let i = 1; i < cuts.length; i++) {
    const [from, to] = [cuts[i - 1], cuts[i]];
    const states = new Map<string, string>();
    for (const record of records)
      if (record.at <= from) states.set(`${record.kind} ${record.subject}`, record.state);
    const has = (...wanted: string[]) =>
      [...states.values()].some((state) => wanted.includes(state));
    const part = gates.some(([asked, answered]) => asked <= from && to <= answered)
      ? "waiting_human"
      : from < collected
        ? "unavailable"
        : has("stuck", "dead", "exited")
          ? "stalled"
          : has("paused", "pending")
            ? "waiting_ci_or_paused"
            : "working";
    split[part] += (to - from) / 1000;
  }
  return split;
}

function planView(directory: string) {
  const text = readFile(join(directory, "plan.md"));
  return text === null ? notAvailable : { state: "ok" as const, html: Bun.markdown.html(text) };
}

function evaluationView(directory: string) {
  const text = readFile(join(directory, "evaluation.md"));
  if (text === null) return notAvailable;
  try {
    return { state: "ok" as const, ...parseEvaluation(text) };
  } catch {
    return notAvailable;
  }
}

function strategiesView(directory: string, chosen: string | null) {
  const text = readFile(join(directory, "strategies.md"));
  if (text === null) return notAvailable;
  return {
    state: "ok" as const,
    cards: parseCards(text).map((card) => ({
      id: card.id,
      title: card.text.split("\n")[0].replace(/^###\s+\S+\s*/, ""),
      approach: card.fields.approach ?? "",
      interfaces: card.fields.interfaces ?? "",
      tradeoffs: card.fields.tradeoffs ?? "",
      recommended: /^yes/i.test(card.fields.recommended?.trim() ?? ""),
      chosen: card.id === chosen,
      mockups: mockupPaths(`${card.fields.mockup ?? ""} ${card.fields.mockups ?? ""}`).map(
        (path) => ({
          path,
          exists: existsSync(join(directory, path)),
        }),
      ),
    })),
  };
}

/**
 * Everything run detail shows for one run. `agents` is Orca's answer for the run, or undefined when
 * Orca failed. Each live agent's output is read with a hard timeout in parallel; a failed read says "unknown".
 */
export async function buildDetail(
  { directory, state, events }: RunInfo,
  agents: Agent[] | undefined,
  now = Date.now(),
) {
  const start = Date.parse(events[0].time);
  const end = state.phase === "closed" ? Date.parse(events.at(-1)!.time) : now;
  const windows = stepWindows(events);

  let messages: Message[] = [];
  let usageKnown = true;
  try {
    messages = collectMessages(directory).messages;
  } catch {
    usageKnown = false;
  }
  const stepOf = assignSteps(messages, windows, directory, end);
  const inStep = (id: string) => messages.filter((message) => stepOf.get(message)?.id === id);
  const stepCost = (id: string): Cost | "unknown" =>
    usageKnown ? costOf(summarize(inStep(id))) : "unknown";
  const wallOf = (id: string) =>
    windows
      .filter((window) => window.id === id)
      .reduce((sum, window) => sum + ((window.end ?? end) - window.start) / 1000, 0);

  const waits = gateWait(events, end);
  const history = readHistory(directory);
  const orchestration = messages.filter((message) => !stepOf.has(message));

  const agentViews = await Promise.all(
    (agents ?? []).map(async (agent) => {
      const step = state.steps.find((candidate) => agent.title.includes(candidate.id));
      const lead = agent.role === "run lead";
      return {
        role: agent.role,
        title: agent.title,
        liveness: agent.liveness,
        terminal: agent.terminal,
        cost: !usageKnown
          ? "unknown"
          : lead
            ? costOf(summarize(orchestration))
            : step
              ? stepCost(step.id)
              : "unknown",
        wall_seconds: lead ? (end - start) / 1000 : step ? wallOf(step.id) : ("unknown" as const),
        output:
          agent.liveness === "live" && agent.terminal
            ? await readTerminalTail(agent.terminal)
            : "unknown",
      };
    }),
  );

  return {
    run: state.run,
    project: state.project,
    ticket: state.ticket,
    phase: state.phase,
    wall_seconds: (end - start) / 1000,
    timeline: timeline(events),
    gates: waits,
    rounds: rounds(events),
    steps: state.steps.map((step) => ({
      ...step,
      cost: stepCost(step.id),
      wall_seconds: windows.some((window) => window.id === step.id) ? wallOf(step.id) : "unknown",
    })),
    ac_proof: acProof(directory, state.project, events),
    cost: usageKnown ? costOf(summarize(messages)) : { usd: "unknown" as const, tokens: 0 },
    agents: agentViews,
    agents_known: agents !== undefined,
    time_split: timeSplit(waits, history, start, end),
    plan: planView(directory),
    evaluation: evaluationView(directory),
    strategies: strategiesView(directory, state.strategy?.chosen ?? null),
  };
}

export type RunDetail = Awaited<ReturnType<typeof buildDetail>>;
