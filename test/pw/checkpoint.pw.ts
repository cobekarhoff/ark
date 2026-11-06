import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkpoint } from "./helpers.ts";

test("ARK-T3 checkpoint writes a PNG before a failing assertion", async ({ page }) => {
  await page.setContent("<button>Save</button>");
  await checkpoint(page, "after-click");
  // The assertion fails on purpose, as at the base of a new feature. It is caught here instead of marked
  // `test.fail()`, so that the PNG checks below still fail the spec when they are wrong.
  const failed = await expect(page.locator("#feature"))
    .toBeVisible({ timeout: 500 })
    .then(
      () => false,
      () => true,
    );
  expect(failed).toBe(true);
  const evidenceDirectory = process.env.ARK_EVIDENCE_DIR;
  if (evidenceDirectory) {
    const file = join(evidenceDirectory, "ARK-T3", "screenshots", "after-click.png");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  }
});
