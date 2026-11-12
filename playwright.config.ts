import { defineConfig, devices } from "@playwright/test";

// Browser specs run under Node (Playwright does not support Bun). `bun test` never sees them: the
// suffix is .pw.ts and bunfig.toml ignores test/pw.
// ARK-423: no background git maintenance or gc in any git process a spec or the hub starts.
Object.assign(process.env, {
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
});
export default defineConfig({
  testDir: "test/pw",
  testMatch: "**/*.pw.ts",
  fullyParallel: true,
  workers: 2,
  retries: 0,
  // Slow Linux CI runners timed out the Bun.WebView tests (ARK-180, ARK-235).
  timeout: 60_000,
  expect: { timeout: 15_000 },
  globalTeardown: "./test/pw/global-teardown.ts",
  outputDir: "test-results",
  // PLAYWRIGHT_JUNIT_OUTPUT_FILE is the report path `ark test` passes as {report}.
  reporter: process.env.PLAYWRIGHT_JUNIT_OUTPUT_FILE ? [["junit"]] : [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1280, height: 900 },
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
