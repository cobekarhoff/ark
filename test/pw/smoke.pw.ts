import { expect, test } from "@playwright/test";

test("smoke: Chromium renders a page", async ({ page }) => {
  await page.setContent("<h1>ok</h1>");
  await expect(page.locator("h1")).toHaveText("ok");
});
