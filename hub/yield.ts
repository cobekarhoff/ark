/** Lets a waiting request run: a pass that works for a while on the main thread yields between small units (ARK-533). */
export const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Yields to the loop once `workBudgetMilliseconds` of work ran since the last yield, so no stretch of a pass holds the loop long (ARK-533). */
const workBudgetMilliseconds = 20;
export const yielder = () => {
  let since = performance.now();
  return async () => {
    if (performance.now() - since < workBudgetMilliseconds) return;
    await yieldToLoop();
    since = performance.now();
  };
};
