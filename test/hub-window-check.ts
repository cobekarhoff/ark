// The window check of ARK-T241 and ARK-T756 (ARK-615). The baseline of a source is the largest of three
// consecutive read windows, so one window that a loaded host starved does not set the limit. The churn
// window must stay below 1.5 times the baseline. Nothing here has a floor.
import { expect } from "bun:test";

const windowLimit = 25;
const churnFactor = 1.5;

/** `windows` is [W1, W2, W3], each with one count per source name; `churn` has one count per source name. */
export function checkWindows(
  names: readonly string[],
  windows: readonly (readonly number[])[],
  churn: readonly number[],
): void {
  names.forEach((source, index) => {
    const counts = windows.map((window) => window[index]!);
    const baseline = Math.max(...counts);
    const limit = churnFactor * baseline;
    const message = `source ${source}: W1 ${counts[0]}, W2 ${counts[1]}, W3 ${counts[2]}, churn ${churn[index]}, limit ${limit}`;
    for (const reads of counts) expect(reads, message).toBeLessThan(windowLimit);
    expect(churn[index]!, message).toBeLessThan(limit);
  });
}
