import { join } from "node:path";
import type { StageTimes, StepWindow } from "../events.ts";
import { isInside } from "../paths.ts";

/** The evaluator reports to the run lead after the lead recorded the evaluation: allow that closing message. */
export const evaluatorGraceMilliseconds = 60_000;

/** An evaluator session starts at or before the evaluation boundary; only its closing message may follow. */
export const isEvaluatorSession = (times: number[], evaluationEnd: number | undefined): boolean =>
  evaluationEnd !== undefined &&
  times.length > 0 &&
  Math.min(...times) <= evaluationEnd &&
  Math.max(...times) <= evaluationEnd + evaluatorGraceMilliseconds;

export const isDesignerTime = (
  time: number,
  designStart: number | undefined,
  designEnd: number | undefined,
): boolean =>
  designStart !== undefined && designEnd !== undefined && time >= designStart && time <= designEnd;

/**
 * Which stage a session file is, by the times of its messages: the evaluator when every message is
 * at or before the last evaluation, else the Designer when every message is between the first
 * evaluation and the last strategy record or answer. A file with no message is no stage.
 */
export function stageOf(times: number[], stages: StageTimes): "evaluator" | "designer" | null {
  if (times.length === 0) return null;
  if (isEvaluatorSession(times, stages.evaluationEnd)) return "evaluator";
  if (times.every((time) => isDesignerTime(time, stages.designStart, stages.designEnd)))
    return "designer";
  return null;
}

export type OwnableFile = {
  cwd: string;
  /** First timestamp of the file, or null when its head holds none. */
  start: number | null;
  /** Last write. */
  mtime: number;
  /** Times of the parsed messages; empty when the file is not parsed. */
  times: number[];
};

export type Owner =
  | { kind: "lead" }
  | { kind: "step"; step: string; window: StepWindow }
  | { kind: "unassigned" };

/**
 * The owner of each session file (same order as `files`), every file whole to one owner, never
 * message by message. Rules in this order:
 * 1. a step, when the file starts inside that step's window and its cwd is in that step's worktree
 *    (of two overlapping windows, the later one);
 * 2. the run lead: the one file that starts before the first step and was last written at or
 *    after it (the earliest-starting if several do). While no step has started there is no first
 *    step: the lead is then the earliest-starting file last written at or after the run's first event.
 *    An evaluator or Designer session file is never the lead;
 * 3. otherwise unassigned.
 * A file with no timestamp in its head cannot start inside a window: it is unassigned.
 * `parents` are the run folder and its symlink-resolved path.
 */
export function ownersOf(
  files: OwnableFile[],
  parents: string[],
  windows: StepWindow[],
  runStarted: number,
  stages: StageTimes = {},
): Owner[] {
  const firstStep = Math.min(...windows.map((window) => window.start));
  const owners = files.map((file): Owner => {
    const start = file.start;
    const window =
      start === null
        ? undefined
        : windows.findLast(
            (candidate) =>
              start >= candidate.start &&
              start <= (candidate.end ?? Infinity) &&
              parents.some((parent) =>
                isInside(file.cwd, join(parent, "workspace", candidate.repo)),
              ),
          );
    return window ? { kind: "step", step: window.id, window } : { kind: "unassigned" };
  });
  const leadFrom = windows.length > 0 ? firstStep : runStarted;
  let leadIndex = -1;
  files.forEach((file, index) => {
    if (
      owners[index].kind !== "unassigned" ||
      file.start === null ||
      (windows.length > 0 && file.start >= firstStep) ||
      file.mtime < leadFrom ||
      stageOf(file.times, stages) !== null
    )
      return;
    if (leadIndex === -1 || file.start < files[leadIndex].start!) leadIndex = index;
  });
  if (leadIndex !== -1) owners[leadIndex] = { kind: "lead" };
  return owners;
}
