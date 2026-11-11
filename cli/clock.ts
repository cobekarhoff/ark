/** The hub's clock, in epoch milliseconds. ARK_NOW (an ISO instant) freezes it, for reproducible demos, bug reports and tests. */
export function now(): number {
  const frozen = process.env.ARK_NOW;
  if (frozen === undefined || frozen === "") return Date.now();
  const milliseconds = Date.parse(frozen);
  if (Number.isNaN(milliseconds))
    throw new Error(`ARK_NOW must be an ISO instant, got "${frozen}"`);
  return milliseconds;
}

/** Waits `milliseconds`. A frozen clock (ARK_NOW) never advances, so under it the wait returns at once: a test never sleeps. */
export async function sleep(milliseconds: number): Promise<void> {
  if (process.env.ARK_NOW) return;
  await Bun.sleep(milliseconds);
}

/**
 * Calls `find` until it returns a value or `limitMilliseconds` pass, every `pollMilliseconds`.
 * Time counts as the larger of the clock and the polls made, so a frozen clock still ends the wait.
 */
export async function waitFor<T>(
  find: () => T | undefined,
  limitMilliseconds: number,
  pollMilliseconds: number,
): Promise<T | undefined> {
  const started = now();
  for (let waited = 0; ; waited += pollMilliseconds) {
    const found = find();
    if (found !== undefined) return found;
    if (Math.max(now() - started, waited) >= limitMilliseconds) return undefined;
    await sleep(pollMilliseconds);
  }
}
