import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseBun } from "../cli/parsers/bun.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

const root = resolve(import.meta.dir, "..");
const long = 300_000;
// Built, not written, so this file does not match its own "no browser API" check.
const forbidden = "Web" + "View";

// The hub specs of ARK-277: the whole Playwright suite, in test/pw/hub.pw.ts.
const hubSpecIds = [
  "ARK-T133",
  "ARK-T260",
  "ARK-T367",
  "ARK-T368",
  ...["AC3", "AC7", "AC9", "AC11"].map((ac) => `ARK-277-${ac}`),
];

function playwright(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  const env: Record<string, string | undefined> = { ...process.env, ...options.env };
  delete env.PLAYWRIGHT_JUNIT_OUTPUT_FILE;
  delete env.JEST_WORKER_ID; // set by bun test --parallel; Playwright refuses it
  const result = Bun.spawnSync(["bunx", "playwright", ...args], {
    cwd: options.cwd ?? root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
  };
}

type Spec = { title: string; tests: { projectName: string }[] };
type Suite = { specs?: Spec[]; suites?: Suite[] };

function listed(): { project: string; title: string }[] {
  const { code, out, err } = playwright(["test", "--list", "--reporter=json"]);
  if (code !== 0) throw new Error(err || out);
  const found: { project: string; title: string }[] = [];
  const walk = (suite: Suite) => {
    for (const spec of suite.specs ?? [])
      for (const t of spec.tests) found.push({ project: t.projectName, title: spec.title });
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of (JSON.parse(out) as Suite).suites ?? []) walk(suite);
  return found;
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "pw-migration-"));
}

describe("playwright migration", () => {
  test(
    "ARK-243-AC1 no test file uses the old browser API and the migrated tests run only in chromium",
    () => {
      const offenders = [...new Bun.Glob("**/*").scanSync({ cwd: join(root, "test") })].filter(
        (file) => readFileSync(join(root, "test", file), "utf8").includes(forbidden),
      );
      expect(offenders).toEqual([]);

      const found = listed();
      expect(found.length).toBeGreaterThanOrEqual(hubSpecIds.length);
      expect(new Set(found.map((t) => t.project))).toEqual(new Set(["chromium"]));
    },
    long,
  );

  test("ARK-T9 bun test discovers no Playwright spec", () => {
    const result = Bun.spawnSync(["bun", "test", "--dry-run", "test/pw"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = result.stdout.toString() + result.stderr.toString();
    expect(text).not.toContain(".pw.ts");
  });

  test(
    "ARK-T10 every Playwright test title starts with an AC id or a test case id",
    () => {
      const titles = listed().map((t) => t.title);
      for (const id of hubSpecIds)
        expect(
          titles.some((title) => title.startsWith(`${id} `)),
          id,
        ).toBe(true);
      expect(titles.every((title) => /^(ARK-\d+-AC\d+|ARK-T\d+) /.test(title))).toBe(true);
    },
    long,
  );

  test("ARK-243-AC2 the bun parser maps Playwright JUnit statuses and criterion ids", async () => {
    const report = await Bun.file(join(root, "test/fixtures/playwright/junit.xml")).text();
    expect(parseBun({ report, stdout: "" })).toEqual([
      {
        name: "ARK-901-AC1 passes & stays green",
        criteria: ["ARK-901-AC1"],
        cases: [],
        status: "passed",
      },
      {
        name: "ARK-901-AC2 fails with a message",
        criteria: ["ARK-901-AC2"],
        cases: [],
        status: "failed",
      },
      { name: "ARK-901-AC3 is skipped", criteria: ["ARK-901-AC3"], cases: [], status: "skipped" },
    ]);
  });

  test("ARK-243-AC4 ci.yml runs the Playwright suite in its own ubuntu job after installing chromium", async () => {
    const ci = Bun.YAML.parse(await Bun.file(join(root, ".github/workflows/ci.yml")).text()) as {
      jobs: Record<string, { "runs-on": string; steps: { run?: string }[] }>;
    };
    const runs = (job: string) => ci.jobs[job]!.steps.flatMap((s) => (s.run ? [s.run] : []));
    const jobs = Object.entries(ci.jobs).filter(([, j]) =>
      j.steps.some((s) => s.run?.includes("playwright test")),
    );
    expect(jobs.length).toBe(1);
    const [name, job] = jobs[0]!;
    expect(name).not.toBe("test");
    expect(job["runs-on"]).toBe("ubuntu-latest");
    const steps = runs(name);
    const install = steps.findIndex((r) => r.includes("playwright install --with-deps chromium"));
    const run = steps.findIndex((r) => r.includes("playwright test"));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(install).toBeLessThan(run);
  });

  test(
    "ARK-243-AC5 a failing Playwright test keeps a trace and a screenshot in the output folder",
    async () => {
      const dir = scratch();
      try {
        symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
        await Bun.write(
          join(dir, "playwright.config.ts"),
          `import base from ${JSON.stringify(join(root, "playwright.config.ts"))};\n` +
            `export default { ...base, testDir: ".", globalTeardown: undefined };\n`,
        );
        await Bun.write(
          join(dir, "fail.pw.ts"),
          `import { test, expect } from "@playwright/test";\n` +
            `test("always fails", async ({ page }) => {\n` +
            `  await page.setContent("<h1>hi</h1>");\n  expect(1).toBe(2);\n});\n`,
        );
        const result = playwright(["test", "-c", "playwright.config.ts"], { cwd: dir });
        expect(result.code).not.toBe(0);
        const files = [
          ...new Bun.Glob("test-results/**/*").scanSync({ cwd: dir, onlyFiles: true }),
        ];
        expect(files.some((f) => f.endsWith("trace.zip"))).toBe(true);
        expect(files.some((f) => f.endsWith(".png"))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    long,
  );

  test(
    "ARK-T99 ARK-330/AC1 one Playwright spec run leaves nothing in the temporary folder",
    () => {
      const dir = scratch();
      try {
        const result = playwright(["test", "test/pw/checkpoint.pw.ts", "--reporter=line"], {
          env: { TMPDIR: dir },
        });
        expect(result.code, result.out + result.err).toBe(0);
        expect(result.out).toMatch(/\n\s*1 passed/);
        expect(readdirSync(dir)).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    long,
  );
});
