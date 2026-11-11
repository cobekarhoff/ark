import { type ArkEvent, deriveState, stepWindows, waitingGate } from "./events.ts";

const toMilliseconds = (time: string): number => Date.parse(time);

/** Each gate wait of the run, in order; `answered` is null while the gate is open. */
export type GateWait = {
  gate: string;
  asked: string;
  answered: string | null;
  answer: string | null;
  /** Who answered; events from before `by` existed read as human. */
  by: "human" | "auto" | null;
};

/**
 * When an escalation wait starts: the last step.finished or test.completed at or before event
 * `index` (whatever the step outcome), else that event itself. Pass the index of the first
 * escalation.requested or escalation gate.answered of the escalation, or of the test.completed
 * that opened it.
 */
export function escalationStart(events: ArkEvent[], index: number): string {
  for (let i = index; i >= 0; i--)
    if (events[i].type === "step.finished" || events[i].type === "test.completed")
      return events[i].time;
  return events[index].time;
}

/** A step that finished with not_started never ran: drop its last start and that finish. */
export const withoutNotStarted = (events: ArkEvent[]): ArkEvent[] =>
  withoutFinishes(events, (finish) => finish.data.not_started === true);

/**
 * An interrupted start gave its round back: drop it and its finish for round counts. The time split
 * does not use this: the work before an interrupt is working time.
 */
export const withoutInterrupted = (events: ArkEvent[]): ArkEvent[] =>
  withoutFinishes(events, (finish) => finish.data.outcome === "interrupted");

function withoutFinishes(events: ArkEvent[], drop: (finish: ArkEvent) => boolean): ArkEvent[] {
  const dropped = new Set<ArkEvent>();
  events.forEach((event, index) => {
    if (event.type !== "step.finished" || !drop(event)) return;
    dropped.add(event);
    const started = events
      .slice(0, index)
      .findLast(
        (candidate) => candidate.type === "step.started" && candidate.data.step === event.data.step,
      );
    if (started) dropped.add(started);
  });
  return events.filter((event) => !dropped.has(event));
}

/**
 * Gate wait: from the moment a gate needs an answer to the answer. The criteria gate needs one at
 * run start (it opens on every run since ARK-311; an older log opens it only without ACs or with blockers), the strategy gate at a
 * strategy record of 2 or more cards, the plan gate at the first valid plan check after its last answer, the escalation gate
 * at `escalationStart` (see there) once the run enters phase `escalation`, an escalation request or an escalation answer arrives.
 */
export function gateWaits(events: ArkEvent[]): GateWait[] {
  const waits: GateWait[] = [];
  const waiting = new Map<string, GateWait>();
  const ask = (gate: string, time: string) => {
    if (waiting.has(gate)) return;
    const wait = { gate, asked: time, answered: null, answer: null, by: null };
    waiting.set(gate, wait);
    waits.push(wait);
  };
  events.forEach((event, index) => {
    if (event.type === "escalation.requested") ask("escalation", escalationStart(events, index));
    if (event.type === "gate.answered") {
      const key = event.data.gate === "manual" ? `manual:${event.data.criterion}` : event.data.gate;
      if (key === "escalation") ask(key, escalationStart(events, index));
      const wait = waiting.get(key);
      if (wait) {
        wait.answered = event.time;
        wait.answer = event.data.answer ?? null;
        wait.by = event.data.by === "auto" ? "auto" : "human";
      }
      waiting.delete(key);
    }
    if (event.type === "test.completed")
      for (const [criterion, status] of Object.entries(event.data.criteria ?? {}))
        if (status === "manual pending") ask(`manual:${criterion}`, event.time);
    // ponytail: O(n²) replay; fold with a step function if logs reach thousands of events
    const state = deriveState(events.slice(0, index + 1));
    const gate = waitingGate(state);
    const failedAfterMergeRequest =
      state.phase === "merge_requests_open" &&
      event.type === "step.finished" &&
      event.data.outcome === "failed";
    if (gate === "escalation" || failedAfterMergeRequest)
      ask("escalation", escalationStart(events, index));
    else if (gate !== "none") ask(gate, event.time);
  });
  return waits;
}

export type TimeSplit = {
  waiting_on_you_seconds: number;
  working_seconds: number;
  waiting_to_merge_seconds: number;
  idle_seconds: number;
};

/**
 * Splits run.started..end (run.closed, else `now`) into waiting on you (gate waits), working (step
 * windows), waiting to merge (first merge_request.opened on) and idle. An interval is clamped to
 * the run, an open one runs to the end. Each moment goes to the first part in that order, so the
 * four parts add up to the wall time.
 */
export function splitRunTime(events: ArkEvent[], now: number): TimeSplit {
  const kept = withoutNotStarted(events);
  if (kept.length === 0)
    return {
      waiting_on_you_seconds: 0,
      working_seconds: 0,
      waiting_to_merge_seconds: 0,
      idle_seconds: 0,
    };
  const start = toMilliseconds(kept[0].time);
  const closed = kept.findLast((event) => event.type === "run.closed");
  const end = Math.max(start, closed ? toMilliseconds(closed.time) : now);
  type Interval = [from: number, to: number];
  const clamp = ([from, to]: Interval): Interval => [
    Math.min(end, Math.max(start, from)),
    Math.min(end, Math.max(start, to)),
  ];
  const mergeOpened = kept.find((event) => event.type === "merge_request.opened");
  const raw: Interval[][] = [
    gateWaits(kept).map((wait) => [
      toMilliseconds(wait.asked),
      wait.answered === null ? end : toMilliseconds(wait.answered),
    ]),
    stepWindows(kept).map((window) => [window.start, window.end ?? end]),
    mergeOpened ? [[toMilliseconds(mergeOpened.time), end]] : [],
  ];
  const parts = raw.map((intervals) => intervals.map(clamp));
  const points = [...new Set([start, end, ...parts.flat(2)])].sort((left, right) => left - right);
  const totals = [0, 0, 0, 0];
  for (let i = 1; i < points.length; i++) {
    const covering = parts.findIndex((intervals) =>
      intervals.some(([from, to]) => from <= points[i - 1] && points[i] <= to),
    );
    totals[covering === -1 ? 3 : covering] += points[i] - points[i - 1];
  }
  const [you, working, merge, idle] = totals.map((milliseconds) => milliseconds / 1000);
  return {
    waiting_on_you_seconds: you,
    working_seconds: working,
    waiting_to_merge_seconds: merge,
    idle_seconds: idle,
  };
}
