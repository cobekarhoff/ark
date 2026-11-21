// The settle wait of ARK-T241 step 6 (ARK-631). It replaces a fixed sleep before the settled call count: a read in
// flight at the disconnect may log its last calls later than any fixed time, and a count that keeps changing must fail.
const pollMs = 50;

/**
 * Polls `count` until it has stayed the same for `quietMs`, and returns it. The quiet span is longer than the
 * hold of step 6, so a count that is flat only because a read is held does not settle early. Rejects with the
 * counts it sampled when the count has not settled `boundMs` after the start.
 */
export async function settleCount(
  count: () => number,
  options: { quietMs?: number; boundMs?: number } = {},
): Promise<number> {
  const quietMs = options.quietMs ?? 1000;
  const boundMs = options.boundMs ?? 5000;
  const start = Date.now();
  const sampled: number[] = [];
  let value = count();
  let since = start;
  sampled.push(value);
  while (Date.now() - since < quietMs) {
    if (Date.now() - start >= boundMs) {
      throw new Error(
        `the call count did not settle within ${boundMs} ms (quiet span ${quietMs} ms); counts sampled: ${sampled.join(", ")}`,
      );
    }
    await Bun.sleep(pollMs);
    const next = count();
    if (next !== value) {
      value = next;
      since = Date.now();
      sampled.push(value);
    }
  }
  return value;
}
