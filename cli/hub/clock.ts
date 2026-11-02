/** The hub's clock, in epoch milliseconds. ARK_NOW (an ISO instant) freezes it, for reproducible demos, bug reports and tests. */
export function now(): number {
  const frozen = process.env.ARK_NOW;
  if (frozen === undefined || frozen === "") return Date.now();
  const milliseconds = Date.parse(frozen);
  if (Number.isNaN(milliseconds))
    throw new Error(`ARK_NOW must be an ISO instant, got "${frozen}"`);
  return milliseconds;
}
