import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Each case runs a scratch `bun test` in the repo, with TMPDIR set to its own scratch directory,
// then lists that directory. The repo's bunfig.toml (and so the preload) applies because the cwd is the repo.
const repositoryRoot = resolve(import.meta.dir, "..");
const helpersPath = join(import.meta.dir, "helpers.ts");
const fixtureRoot = mkdtempSync(join(tmpdir(), "preload-fixtures-")); // inside this process's own preload root

function scratchDirectory(): string {
  return mkdtempSync(join(fixtureRoot, "scratch-"));
}

function writeFixture(name: string, source: string): string {
  const path = join(fixtureRoot, `${name}.test.ts`);
  writeFileSync(path, source);
  return path;
}

function spawnBunTest(
  fixturePath: string,
  scratch: string,
  extraArguments: string[] = [],
  extraEnvironment = {},
) {
  return Bun.spawn(["bun", "test", ...extraArguments, fixturePath], {
    cwd: repositoryRoot,
    env: { ...process.env, ...extraEnvironment, TMPDIR: scratch },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function runBunTest(fixturePath: string, scratch: string, extraArguments: string[] = []) {
  const child = spawnBunTest(fixturePath, scratch, extraArguments);
  const output = await new Response(child.stdout).text();
  const errorOutput = await new Response(child.stderr).text();
  return { exitCode: await child.exited, output: output + errorOutput };
}

const makesTempDirectory = (outcome: "pass" | "fail") => `
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("fixture", () => {
  for (const prefix of ["ark-", "ark179-", "ark199-", "plannotator-data-"]) {
    writeFileSync(join(mkdtempSync(join(tmpdir(), prefix)), "file"), "x");
  }
  expect(1).toBe(${outcome === "pass" ? 1 : 2});
});
`;

test.each(["pass", "fail"] as const)(
  "ARK-235-AC1 a bun test process that ends with a %s leaves nothing in the temporary directory",
  async (outcome) => {
    const scratch = scratchDirectory();
    const { exitCode, output } = await runBunTest(
      writeFixture(`suite-${outcome}`, makesTempDirectory(outcome)),
      scratch,
    );
    expect(exitCode === 0).toBe(outcome === "pass");
    expect(output).toContain(outcome === "pass" ? " 1 pass" : " 1 fail");
    expect(readdirSync(scratch)).toEqual([]);
  },
  { timeout: 60_000 },
);

const opensWebView = `
import { test, expect } from "bun:test";
test("fixture opens a chrome WebView", async () => {
  await using view = new Bun.WebView({ backend: "chrome", width: 400, height: 300 });
  await view.navigate("data:text/html,<title>x</title>hello");
  expect(await view.evaluate("document.body.textContent")).toBe("hello");
});
`;

test(
  "ARK-235-AC1 a browser test file leaves no .bun-chrome profile in the temporary directory",
  async () => {
    const fixturePath = writeFixture("webview", opensWebView);

    // Control: without the preload, Chrome's profile lands in the scratch TMPDIR. Proves the check can fail.
    const emptyConfig = join(fixtureRoot, "empty-bunfig.toml");
    writeFileSync(emptyConfig, "");
    const controlScratch = scratchDirectory();
    const control = await runBunTest(fixturePath, controlScratch, [`--config=${emptyConfig}`]);
    expect(control.exitCode, control.output).toBe(0);
    expect(readdirSync(controlScratch).some((entry) => entry.endsWith(".bun-chrome"))).toBe(true);

    const scratch = scratchDirectory();
    const result = await runBunTest(fixturePath, scratch);
    expect(result.exitCode, result.output).toBe(0);
    expect(readdirSync(scratch)).toEqual([]);
  },
  { timeout: 120_000 },
);

// Prints its tmpdir() to <signal>/<name>.dir, writes a file there, and waits for <signal>/<name>.go.
// After the signal, the file must still exist or the fixture fails.
const concurrentFixture = (signalDirectory: string, name: string) => `
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("fixture ${name}", async () => {
  const ownDirectory = join(tmpdir(), "ark-concurrent-${name}");
  mkdirSync(ownDirectory);
  writeFileSync(join(ownDirectory, "file"), "x");
  writeFileSync(${JSON.stringify(join(signalDirectory, `${name}.dir`))}, tmpdir());
  while (!existsSync(${JSON.stringify(join(signalDirectory, `${name}.go`))})) await Bun.sleep(20);
  expect(existsSync(join(ownDirectory, "file"))).toBe(true);
});
`;

async function waitFor(path: string): Promise<void> {
  for (let attempt = 0; attempt < 1500 && !existsSync(path); attempt++) await Bun.sleep(20);
  expect(existsSync(path), `${path} never appeared`).toBe(true);
}

test(
  "ARK-235-AC2 two bun test processes at once use different roots, and one ending leaves the other's files",
  async () => {
    // Cross-process signal files: no in-process event to await.
    const signalDirectory = mkdtempSync(join(fixtureRoot, "signal-"));
    const scratch = scratchDirectory();
    const first = spawnBunTest(
      writeFixture("concurrent-a", concurrentFixture(signalDirectory, "a")),
      scratch,
    );
    const second = spawnBunTest(
      writeFixture("concurrent-b", concurrentFixture(signalDirectory, "b")),
      scratch,
    );

    await waitFor(join(signalDirectory, "a.dir"));
    await waitFor(join(signalDirectory, "b.dir"));
    const firstRoot = await Bun.file(join(signalDirectory, "a.dir")).text();
    const secondRoot = await Bun.file(join(signalDirectory, "b.dir")).text();
    expect(firstRoot).not.toBe(secondRoot);
    expect(readdirSync(scratch).length).toBe(2);

    writeFileSync(join(signalDirectory, "a.go"), "");
    expect(await first.exited).toBe(0);
    // The first process removed its root; the second still has its own, and its fixture re-checks its file.
    expect(readdirSync(scratch).length).toBe(1);
    writeFileSync(join(signalDirectory, "b.go"), "");
    expect(await second.exited).toBe(0);
    expect(readdirSync(scratch)).toEqual([]);
  },
  { timeout: 60_000 },
);

test(
  "ARK-235-AC3 a single test file that calls tempArkHome leaves nothing in the temporary directory",
  async () => {
    const scratch = scratchDirectory();
    const fixturePath = writeFixture(
      "single",
      `
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { tempArkHome } from ${JSON.stringify(helpersPath)};
test("fixture", () => {
  expect(existsSync(tempArkHome())).toBe(true);
});
`,
    );
    const { exitCode, output } = await runBunTest(fixturePath, scratch);
    expect(exitCode, output).toBe(0);
    expect(readdirSync(scratch)).toEqual([]);
  },
  { timeout: 60_000 },
);
