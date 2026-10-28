import { chromium, expect as browserExpect } from "../site/node_modules/@playwright/test";
import { join } from "node:path";

// Run only after the owning test builds the site and installs its browser dependency.
const [output, screenshots] = process.argv.slice(2);
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const file = Bun.file(join(output, pathname.endsWith("/") ? `${pathname}index.html` : pathname));
    return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
  },
});
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "no-preference" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${server.url}flow/`);
  const lifecycle = page.getByRole("region", { name: "Run lifecycle explorer", exact: true });
  const current = lifecycle.locator("[data-current-state]");
  await browserExpect(current).toHaveText("intake");
  await lifecycle.getByRole("button", { name: "analysis.completed", exact: false }).click();
  await browserExpect(current).toHaveText("analyzed");
  browserExpect(await current.evaluate((element) => element.getAnimations().length)).toBeGreaterThan(0);
  const planEvent = lifecycle.getByRole("button", { name: "gate.packet:plan", exact: false });
  await planEvent.focus();
  await page.keyboard.press("Enter");
  await browserExpect(current).toHaveText("awaiting_plan");
  const changeEvent = lifecycle.getByRole("button", { name: "gate.answered:plan:change", exact: false });
  await changeEvent.focus();
  await page.keyboard.press("Space");
  await browserExpect(current).toHaveText("analyzed");
  await lifecycle.getByRole("button", { name: "Previous state", exact: true }).click();
  await browserExpect(current).toHaveText("awaiting_plan");
  await lifecycle.getByRole("button", { name: "gate.answered:plan:approve", exact: false }).click();
  await browserExpect(current).toHaveText("approved");
  await browserExpect(lifecycle.getByRole("status")).toContainText("gate.answered:plan:approve");

  const diagram = page.getByRole("region", { name: "Execution DAG", exact: true });
  const validateNode = diagram.getByRole("button", { name: "5 Validate", exact: true });
  await validateNode.focus();
  await page.keyboard.press("Enter");
  await browserExpect(validateNode).toHaveAttribute("aria-pressed", "true");
  const dependency = page.getByRole("region", { name: "Execution step details", exact: true });
  await browserExpect(dependency).toContainText("spawn the validator and prove the ACs red then green", { useInnerText: true });
  await browserExpect(dependency).toContainText("Depends on step 4: Implement.", { useInnerText: true });
  await diagram.getByRole("button", { name: "6 Review", exact: true }).click();
  await browserExpect(validateNode).toHaveAttribute("aria-pressed", "false");
  await browserExpect(dependency).toContainText("spawn reviewer-x on the change", { useInnerText: true });
  await browserExpect(dependency).toContainText("Depends on step 5: Validate.", { useInnerText: true });

  const walkthrough = page.getByRole("region", { name: "Illustrative ticket walkthrough", exact: true });
  const details = walkthrough.getByRole("region", { name: "Walkthrough step", exact: true });
  const next = walkthrough.getByRole("button", { name: "Next step", exact: true });
  const previous = walkthrough.getByRole("button", { name: "Previous step", exact: true });
  await browserExpect(details.getByRole("heading", { name: "Intake: a human brings a ticket", exact: true })).toBeVisible();
  await browserExpect(previous).toBeDisabled();
  await next.focus();
  await page.keyboard.press("Enter");
  await browserExpect(details.getByRole("heading", { name: "Criteria: clarify before moving", exact: true })).toBeVisible();
  await browserExpect(walkthrough.getByRole("status")).toHaveText("Step 2 of 14");
  await previous.focus();
  await page.keyboard.press("Space");
  await browserExpect(details.getByRole("heading", { name: "Intake: a human brings a ticket", exact: true })).toBeVisible();
  for (let index = 1; index < 14; index++) await next.click();
  await browserExpect(details.getByRole("heading", { name: "The human merges and closes the run", exact: true })).toBeVisible();
  await browserExpect(details).toContainText("Human → orchestrator");
  await browserExpect(next).toBeDisabled();
  await previous.click();
  await browserExpect(details.getByRole("heading", { name: "Open a merge request per repository", exact: true })).toBeVisible();
  await browserExpect(next).toBeEnabled();

  await lifecycle.screenshot({ path: join(screenshots, "lifecycle-approved.png") });
  await diagram.screenshot({ path: join(screenshots, "execution-review.png") });
  await walkthrough.screenshot({ path: join(screenshots, "walkthrough-merge-request.png") });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await lifecycle.getByRole("button", { name: "Reset lifecycle", exact: true }).click();
  await lifecycle.getByRole("button", { name: "analysis.completed", exact: false }).click();
  await browserExpect(current).toHaveText("analyzed");
  browserExpect(await current.evaluate((element) => element.getAnimations().length)).toBe(0);
  await walkthrough.getByRole("button", { name: "Restart walkthrough", exact: true }).click();
  await next.click();
  await browserExpect(details.getByRole("heading", { name: "Criteria: clarify before moving", exact: true })).toBeVisible();
  browserExpect(await details.evaluate((element) => element.getAnimations({ subtree: true }).length)).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  browserExpect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: join(screenshots, "reduced-motion-mobile.png"), fullPage: true });
  browserExpect(errors).toEqual([]);
} finally {
  await browser.close();
  await server.stop(true);
}
