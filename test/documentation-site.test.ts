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
  // Contract: the documented build emits authored pages and is a continuous integration (CI) step.
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
    const documentationJob: unknown = "docs" in workflow.jobs ? workflow.jobs.docs : undefined;
    if (!documentationJob || typeof documentationJob !== "object" || !("steps" in documentationJob) || !Array.isArray(documentationJob.steps)) throw new Error("Expected documentation workflow steps");
    const steps = documentationJob.steps.map((step: unknown) => step && typeof step === "object" && "run" in step ? step.run : undefined);
    expect(steps).toContain("bun install --frozen-lockfile");
    expect(steps).toContain("bun run docs:build");
    expect(steps).toContain("bun test test/documentation-site.test.ts");
  }, 180_000);

  // Contract: real browser interaction teaches branching, dependencies and handoffs.
  // Broken scripts, inaccessible controls, missing animation or ignored motion preferences fail.
  // Static build proof cannot establish interaction; the browser uses the unmodified site.
  test("ARK-116-AC4 explores lifecycle branches, execution dependencies and the ticket walkthrough with keyboard and reduced motion", () => {
    const output = build();
    const screenshots = process.env.ARK_OUT?.includes("/artifacts/test/")
      ? join(process.env.ARK_OUT.split("/artifacts/test/")[0], "artifacts", "screenshots", "ARK-116-AC4")
      : join(tmpdir(), "ark-documentation-screenshots", "ARK-116-AC4");
    mkdirSync(screenshots, { recursive: true });
    // A fresh process sees dependencies installed by the build, without Bun's stale resolution cache.
    // Launch inside the test so a base without the site still records a failing test.
    command(["bun", join(import.meta.dir, "documentation-site-browser.ts"), output, screenshots]);
  }, 180_000);

  // Contract: published help follows the actual command-line interface (CLI), including test.
  // A hardcoded reference or stale generated file fails a warm rebuild after a real help edit.
  // The CLI is an independent oracle for the documentation generator, not the generator itself.
  // Mutate only a disposable repository copy; no product hooks or service mocks are needed.
  test("ARK-116-AC5 publishes actual CLI help and refreshes it after the CLI help changes", () => {
    const help = command(["bun", "cli/ark.ts", "--help"]);
    expect(help).toContain("test <run_id> --criteria");
    const temporary = mkdtempSync(join(tmpdir(), "ark-documentation-help-"));
    try {
      copyDirectory(repository, temporary, {
        recursive: true,
        filter: (source) => ![".git", "node_modules", "dist", ".astro", ".generated"].includes(basename(source)),
      });
      symlinkSync(join(repository, "node_modules"), join(temporary, "node_modules"), "dir");
      const initialHelp = publishedHelp(build(temporary));
      expect(initialHelp).toBe(help);
      const commandFile = join(temporary, "cli", "ark.ts");
      const source = readFileSync(commandFile, "utf8");
      const changed = source.replace("Print this help", "Print this help with the documentation freshness sentinel");
      expect(changed).not.toBe(source);
      writeFileSync(commandFile, changed);
      const changedHelp = command(["bun", "cli/ark.ts", "--help"], temporary);
      expect(changedHelp).toContain("documentation freshness sentinel");
      expect(changedHelp).not.toBe(help);
      const refreshed = publishedHelp(build(temporary));
      expect(refreshed).not.toBe(initialHelp);
      expect(refreshed).toBe(changedHelp);
      expect(refreshed).toContain("documentation freshness sentinel");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 180_000);
});
