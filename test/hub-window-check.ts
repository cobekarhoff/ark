// The window check of ARK-T241 and ARK-T756 (ARK-615, ARK-631). The baseline of a source is the largest of three
// consecutive read windows, so one window that a loaded host starved does not set the limit. Two rules judge the
// churn window: each source stays below 4 times its baseline, and the churn sum stays below 1.5 times the sum of
// the baselines. A healthy Linux runner reads 1 to 4 times a window, so one extra read must not fail it, while a
// second loop (every source about 2 times its baseline) fails the sum rule. Nothing here has a floor: a churn count
// of 0 against a baseline above 0 passes, and a source that reads 0 in every window fails (0 is not below 0).
import { expect } from "bun:test";

const windowLimit = 25;
const sourceFactor = 4;
const sumFactor = 1.5;

/** `windows` is [W1, W2, W3], each with one count per source name; `churn` has one count per source name. */
export function checkWindows(
  names: readonly string[],
  windows: readonly (readonly number[])[],
  churn: readonly number[],
): void {
  const baselines = names.map((_, index) => Math.max(...windows.map((window) => window[index]!)));
  const counts = (index: number) => windows.map((window) => window[index]!);
  names.forEach((source, index) => {
    const [first, second, third] = counts(index);
    const limit = sourceFactor * baselines[index]!;
    const message = `source ${source}: W1 ${first}, W2 ${second}, W3 ${third}, churn ${churn[index]}, limit ${limit}`;
    for (const reads of counts(index)) expect(reads, message).toBeLessThan(windowLimit);
    expect(churn[index]!, message).toBeLessThan(limit);
  });
  const churnSum = churn.reduce((total, reads) => total + reads, 0);
  const baselineSum = baselines.reduce((total, reads) => total + reads, 0);
  const sumLimit = sumFactor * baselineSum;
  const perSource = names
    .map((source, index) => {
      const [first, second, third] = counts(index);
      return `${source} W1 ${first}, W2 ${second}, W3 ${third}, churn ${churn[index]}`;
    })
    .join("; ");
  expect(
    churnSum,
    `churn sum ${churnSum} against limit ${sumLimit} (${sumFactor} times the baseline sum ${baselineSum}); ${perSource}`,
  ).toBeLessThan(sumLimit);
}
