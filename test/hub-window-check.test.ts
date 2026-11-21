// ARK-T777: the window check of ARK-T241 and ARK-T756 on the exact counts that CI runs produced, and the settle
// wait of ARK-T241 step 6 on counters that settle or never settle. Both modules are the fix of ARK-631: they load
// inside each test, so a missing module fails that test and not the file.
import { expect, test } from "bun:test";

const sourceNames = ["orca", "plannotator", "gh", "conversation", "chiefUnread"];

type Row = { windows: readonly [number, number, number]; churn: number };
type CheckWindows = (
  names: readonly string[],
  windows: readonly (readonly number[])[],
  churn: readonly number[],
) => void;

async function loadWindowCheck(): Promise<CheckWindows> {
  const helperPath = "./hub-window-check.ts";
  const { checkWindows } = await import(helperPath);
  return checkWindows;
}

async function loadSettle(): Promise<
  (count: () => number, options?: { quietMs?: number; boundMs?: number }) => Promise<number>
> {
  const helperPath = "./hub-settle.ts";
  const { settleCount } = await import(helperPath);
  return settleCount;
}

/** Every source at `W count,count,count churn count`: the healthy counts of a source whose log never showed. */
const healthy = (count: number): Row => ({ windows: [count, count, count], churn: count });

/** Five rows in the order of `sourceNames`, with `rows[index]` replaced at `index`. */
function sourcesWith(others: Row, replaced: Record<number, Row>): Row[] {
  return sourceNames.map((_, index) => replaced[index] ?? others);
}

function check(checkWindows: CheckWindows, rows: readonly Row[]): void {
  const windows = [0, 1, 2].map((windowIndex) => rows.map((row) => row.windows[windowIndex]!));
  checkWindows(
    sourceNames,
    windows,
    rows.map((row) => row.churn),
  );
}

/** The message of the failure, or a failed expectation when the check passes. */
function failureOf(checkWindows: CheckWindows, rows: readonly Row[]): string {
  let message: string | undefined;
  try {
    check(checkWindows, rows);
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message, "the check must throw").toBeDefined();
  return message!;
}

const orcaTuples: [string, Row][] = [
  ["W 4,4,4 churn 7 (PR CI run 44901215110, ARK-T241)", { windows: [4, 4, 4], churn: 7 }],
  ["W 1,3,4 churn 6 (ARK-T756)", { windows: [1, 3, 4], churn: 6 }],
  ["W 1,4,3 churn 6 (ARK-T756)", { windows: [1, 4, 3], churn: 6 }],
  ["W 1,4,2 churn 6 (main #296)", { windows: [1, 4, 2], churn: 6 }],
  ["W 1,1,2 churn 3", { windows: [1, 1, 2], churn: 3 }],
  ["W 1,1,3 churn 11 (main run 44900809909)", { windows: [1, 1, 3], churn: 11 }],
];

// AC1: the orca tuples that failed CI pass, with the four other sources at 4 and at 5 a window (their counts are in no log).
for (const otherCount of [4, 5]) {
  for (const [label, orca] of orcaTuples) {
    test(`ARK-T777 orca ${label} passes with the other sources healthy at ${otherCount}`, async () => {
      const checkWindows = await loadWindowCheck();
      check(checkWindows, sourcesWith(healthy(otherCount), { 0: orca }));
    });
  }
}

test("ARK-T777 a churn count of 0 against a baseline of 4 passes: the check has no lower bound", async () => {
  const checkWindows = await loadWindowCheck();
  check(checkWindows, sourcesWith(healthy(4), { 0: { windows: [4, 4, 4], churn: 0 } }));
});

// AC2: a second loop. Every source twice its baseline, under the per-source 4 times, so only the sum rule can fail.
for (const [label, baseline, churn] of [
  ["every source at W 4,4,4 churn 8", 4, 8],
  ["every source at W 20,20,20 churn 40", 20, 40],
  ["every source at W 4,4,4 churn 7 (1.75 times, between 1.5 and 2 times the baselines)", 4, 7],
] as const) {
  test(`ARK-T777 a second loop fails: ${label}`, async () => {
    const checkWindows = await loadWindowCheck();
    failureOf(checkWindows, sourcesWith({ windows: [baseline, baseline, baseline], churn }, {}));
  });
}

// AC2: one source at 4 times its baseline, the others at 10 so the sum rule passes and only the per-source bound can fail.
test("ARK-T777 orca at 3.67 times its baseline passes: W 3,3,3 churn 11 against limit 12", async () => {
  const checkWindows = await loadWindowCheck();
  check(checkWindows, sourcesWith(healthy(10), { 0: { windows: [3, 3, 3], churn: 11 } }));
});

for (const [baseline, churn] of [
  [3, 12],
  [2, 8],
  [4, 16],
] as const) {
  test(`ARK-T777 orca at 4 times its baseline fails: W ${baseline},${baseline},${baseline} churn ${churn}`, async () => {
    const checkWindows = await loadWindowCheck();
    failureOf(
      checkWindows,
      sourcesWith(healthy(10), { 0: { windows: [baseline, baseline, baseline], churn } }),
    );
  });
}

test("ARK-T777 a source that reads 0 in every window fails while the others are healthy at 20", async () => {
  const checkWindows = await loadWindowCheck();
  failureOf(checkWindows, sourcesWith(healthy(20), { 3: { windows: [0, 0, 0], churn: 0 } }));
});

test("ARK-T777 a window of 25 fails", async () => {
  const checkWindows = await loadWindowCheck();
  failureOf(checkWindows, sourcesWith(healthy(20), { 0: { windows: [25, 20, 20], churn: 20 } }));
});

test("ARK-T777 the baseline is the largest of the three windows, not the first or the mean", async () => {
  const checkWindows = await loadWindowCheck();
  // W 1,1,3 churn 11: a baseline of the first window (limit 4) or the mean (limit 6.67) fails it; the largest (limit 12) passes it.
  check(checkWindows, sourcesWith(healthy(4), { 0: { windows: [1, 1, 3], churn: 11 } }));
  // The same churn with the large window first is the same baseline.
  check(checkWindows, sourcesWith(healthy(4), { 0: { windows: [3, 1, 1], churn: 11 } }));
});

test("ARK-T777 a per-source failure names the source and its counts", async () => {
  const checkWindows = await loadWindowCheck();
  const message = failureOf(
    checkWindows,
    sourcesWith(healthy(10), { 0: { windows: [3, 3, 3], churn: 12 } }),
  );
  expect(message).toContain("orca");
  expect(message).toContain("W1 3, W2 3, W3 3");
  expect(message).toContain("churn 12");
});

test("ARK-T777 a dead-source failure names the source and its counts", async () => {
  const checkWindows = await loadWindowCheck();
  const message = failureOf(
    checkWindows,
    sourcesWith(healthy(20), { 3: { windows: [0, 0, 0], churn: 0 } }),
  );
  expect(message).toContain("conversation");
  expect(message).toContain("W1 0, W2 0, W3 0");
  expect(message).toContain("churn 0");
});

test("ARK-T777 a sum failure names the churn sum, its limit and every source", async () => {
  const checkWindows = await loadWindowCheck();
  const message = failureOf(checkWindows, sourcesWith({ windows: [4, 4, 4], churn: 7 }, {}));
  // 35 is the churn sum, 30 is 1.5 times the baseline sum of 20.
  expect(message).toContain("35");
  expect(message).toContain("30");
  for (const source of sourceNames) expect(message).toContain(source);
});

// The settle wait of ARK-T241 step 6: a count that stops changing returns its final value; a count that keeps changing fails with what it sampled.
test("ARK-T777 the settle wait returns the count once it stops changing", async () => {
  const settleCount = await loadSettle();
  let calls = 0;
  const settled = await settleCount(() => Math.min(++calls, 5), { quietMs: 100, boundMs: 5000 });
  expect(settled).toBe(5);
});

test("ARK-T777 the settle wait fails at its bound with the counts it sampled when the count never stops changing", async () => {
  const settleCount = await loadSettle();
  let reads = 1000;
  const failure = await settleCount(() => reads++, { quietMs: 100, boundMs: 400 }).then(
    () => undefined,
    (error: Error) => error,
  );
  expect(failure, "the wait must fail").toBeInstanceOf(Error);
  expect(failure!.message).toContain("1000");
});
