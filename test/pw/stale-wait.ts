import { expect, type Locator, type Page } from "@playwright/test";

type PushWindow = Window & { __lastPushAt?: number };

const WAIT_TIMEOUT = 60_000;
const JUMP = 180_000;

/**
 * Records the page-clock time of each /events message in `window.__lastPushAt`. Call it before the
 * page opens: a live push is fresh by design (hub/page/store.tsx), so a wait that moves the page
 * clock must know whether a push landed after the move.
 */
export async function observePushes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        this.addEventListener("message", () => {
          (window as unknown as PushWindow).__lastPushAt = performance.now();
        });
      }
    };
  });
}

/**
 * Moves the page clock 180000 ms, then waits until the row reads `minutes` min or more. A push after
 * the last jump takes the age back to 0, so a row that reads less than `minutes` after such a push gets
 * another jump. A row under `minutes` with no push after the jump is a miscount: the wait fails at 60 s.
 * `afterJump` runs after the first jump and before the first read: a test uses it to land a push there.
 */
export async function waitForAge(
  page: Page,
  row: Locator,
  minutes: number,
  afterJump?: () => Promise<void>,
): Promise<void> {
  // The mark is read before the jump: a push at or after it may have reset the age after the jump.
  let mark = await page.evaluate(() => performance.now());
  await page.clock.fastForward(JUMP);
  await afterJump?.();
  await expect
    .poll(
      async () => {
        const age = Number(/^(\d+) min$/.exec((await row.textContent()) ?? "")?.[1] ?? NaN);
        if (age >= minutes) return true;
        if (!Number.isNaN(age)) {
          const lastPush = await page.evaluate(
            () => (window as unknown as PushWindow).__lastPushAt,
          );
          if (lastPush !== undefined && lastPush >= mark) {
            mark = await page.evaluate(() => performance.now());
            await page.clock.fastForward(JUMP);
          }
        }
        return false;
      },
      { timeout: WAIT_TIMEOUT, message: `the row never read ${minutes} min or more` },
    )
    .toBe(true);
}

/** Waits until the stale chip is gone: every source has answered once. */
export async function waitForChipGone(page: Page): Promise<void> {
  await expect(page.getByTestId("stale-chip")).toHaveCount(0, { timeout: WAIT_TIMEOUT });
}
