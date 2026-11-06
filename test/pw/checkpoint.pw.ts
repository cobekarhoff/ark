import { expect, test } from "@playwright/test";
import { checkpoint } from "./helpers.ts";

test("ARK-T3 checkpoint writes a PNG only when ARK_EVIDENCE_DIR is set", async ({ page }) => {
  // The assertion fails on purpose, as at the base of a new feature: the checkpoint before it keeps its picture.
  test.fail();
  await page.setContent("<button>Save</button>");
  await checkpoint(page, "after-click");
  await expect(page.locator("#feature")).toBeVisible({ timeout: 500 });
});
