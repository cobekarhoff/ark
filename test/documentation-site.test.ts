import { describe, expect, test } from "bun:test";
import { cpSync as copyDirectory, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const repository = join(import.meta.dir, "..");
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  ["HOME", "PATH", "TMPDIR", "LANG"].includes(name) || name.startsWith("LC_")));

function command(argumentsList: string[], directory = repository) {
  const result = Bun.spawnSync(argumentsList, { cwd: directory, env: environment });
  expect({ exitCode: result.exitCode, error: result.stderr.toString() }).toEqual({ exitCode: 0, error: expect.any(String) });
  return result.stdout.toString();
}

function build(directory = repository) {
  command(["bun", "run", "docs:build"], directory);
  return join(directory, "site", "dist");
}

function publishedHelp(directory: string) {
  const page = readFileSync(join(directory, "reference", "commands", "index.html"), "utf8");
  const reference = page.match(/<pre\b[^>]*data-cli-reference[^>]*>\s*<code>([\s\S]*?)<\/code>\s*<\/pre>/);
  expect(reference).not.toBeNull();
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };
  return reference![1].replace(/&(amp|lt|gt|quot|apos|#39|#\d+|#x[\da-f]+);/gi, (entity, name: string) =>
    entities[name] ?? String.fromCodePoint(name.startsWith("#x") ? parseInt(name.slice(2), 16) : Number(name.slice(1))));
}

describe("Documentation site", () => {
  // Contract: the documented build emits authored pages and is a CI step.
  // Removing the build command, content entry, or CI invocation must fail here.
  // No prior test exercises this new public build boundary; no product hook is needed.
  test("ARK-116-AC2 builds repository-authored pages with the single continuous integration command", () => {
    const output = build();
    const page = readFileSync(join(output, "index.html"), "utf8");
    expect(page).toContain("From ticket to human merge");
    expect(page).toContain("Humans approve the gates and merge.");
    expect(page).toContain('href="/setup/"');
    const workflow: unknown = Bun.YAML.parse(readFileSync(join(repository, ".github", "workflows", "ci.yml"), "utf8"));
    if (!workflow || typeof workflow !== "object" || !("jobs" in workflow) || !workflow.jobs || typeof workflow.jobs !== "object") throw new Error("Expected workflow jobs");
    const steps = Object.values(workflow.jobs).flatMap((job: unknown) => {
      if (!job || typeof job !== "object" || !("steps" in job) || !Array.isArray(job.steps)) throw new Error("Expected workflow steps");
      return job.steps.map((step: unknown) => step && typeof step === "object" && "run" in step ? step.run : undefined);
    });
    expect(steps).toContain("bun install --frozen-lockfile");
    expect(steps).toContain("bun run docs:build");
  }, 180_000);

  // Contract: real browser interaction teaches branching, dependencies and handoffs.
  // Broken scripts, inaccessible controls, missing animation or ignored motion preferences fail.
  // Static build proof cannot establish interaction; the browser uses the unmodified site.
  test("ARK-116-AC4 explores lifecycle branches, execution dependencies and the ticket walkthrough with keyboard and reduced motion", async () => {
    const output = build();
    // Load inside the test: base has no browser dependency and must still report a test result.
    const { chromium, expect: browserExpect } = await import("@playwright/test");
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
      expect(await current.evaluate((element) => element.getAnimations().length)).toBeGreaterThan(0);
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

      const screenshots = process.env.ARK_OUT?.includes("/artifacts/test/")
        ? join(process.env.ARK_OUT.split("/artifacts/test/")[0], "artifacts", "screenshots", "ARK-116-AC4")
        : join(tmpdir(), "ark-documentation-screenshots", "ARK-116-AC4");
      mkdirSync(screenshots, { recursive: true });
      await lifecycle.screenshot({ path: join(screenshots, "lifecycle-approved.png") });
      await diagram.screenshot({ path: join(screenshots, "execution-review.png") });
      await walkthrough.screenshot({ path: join(screenshots, "walkthrough-merge-request.png") });

      await page.emulateMedia({ reducedMotion: "reduce" });
      await lifecycle.getByRole("button", { name: "Reset lifecycle", exact: true }).click();
      await lifecycle.getByRole("button", { name: "analysis.completed", exact: false }).click();
      await browserExpect(current).toHaveText("analyzed");
      expect(await current.evaluate((element) => element.getAnimations().length)).toBe(0);
      await walkthrough.getByRole("button", { name: "Restart walkthrough", exact: true }).click();
      await next.click();
      await browserExpect(details.getByRole("heading", { name: "Criteria: clarify before moving", exact: true })).toBeVisible();
      expect(await details.evaluate((element) => element.getAnimations({ subtree: true }).length)).toBe(0);
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: join(screenshots, "reduced-motion-mobile.png"), fullPage: true });
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await server.stop(true);
    }
  }, 180_000);

  // Contract: published help follows the actual command-line interface (CLI), including test.
  // A hardcoded reference or stale generated file fails the second build after a real help edit.
  // The CLI is an independent oracle for the documentation generator, not the generator itself.
  // Mutate only a disposable repository copy; no product hooks or service mocks are needed.
  test("ARK-116-AC5 publishes actual CLI help and refreshes it after the CLI help changes", () => {
    const help = command(["bun", "cli/ark.ts", "--help"]);
    expect(help).toContain("test <run_id> --criteria");
    expect(publishedHelp(build())).toBe(help);
    const temporary = mkdtempSync(join(tmpdir(), "ark-documentation-help-"));
    try {
      copyDirectory(repository, temporary, {
        recursive: true,
        filter: (source) => ![".git", "node_modules", "dist", ".astro", ".generated"].includes(basename(source)),
      });
      symlinkSync(join(repository, "node_modules"), join(temporary, "node_modules"), "dir");
      const commandFile = join(temporary, "cli", "ark.ts");
      const source = readFileSync(commandFile, "utf8");
      const changed = source.replace("Print this help", "Print this help with the documentation freshness sentinel");
      expect(changed).not.toBe(source);
      writeFileSync(commandFile, changed);
      const changedHelp = command(["bun", "cli/ark.ts", "--help"], temporary);
      expect(changedHelp).toContain("documentation freshness sentinel");
      expect(changedHelp).not.toBe(help);
      const refreshed = publishedHelp(build(temporary));
      expect(refreshed).toBe(changedHelp);
      expect(refreshed).toContain("documentation freshness sentinel");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 180_000);
});
