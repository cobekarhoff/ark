import { expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

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

const refusedTools = ["orca", "gh", "glab", "omp", "plannotator", "launchctl", "portless"];

test(
  "ARK-T154 bun test refuses a real orca, gh, glab, omp, plannotator, launchctl or portless and a test's own fake still wins",
  async () => {
    // Sentinels stand in for the real tools, behind the preload shims on the PATH the child inherits. Each logs its
    // name and exits 0, so a refusal cannot come from a real tool's own failure. The PATH holds nothing else named
    // like a tool: the sentinels, then the system folders and the folder of bun.
    const sentinels = mkdtempSync(join(fixtureRoot, "sentinels-"));
    const sentinelLog = join(sentinels, "calls.log");
    for (const tool of refusedTools) {
      const file = join(sentinels, tool);
      writeFileSync(file, `#!/bin/sh\necho ${tool} >> ${sentinelLog}\n`);
      chmodSync(file, 0o755);
    }
    const environment = { PATH: `${sentinels}:/usr/bin:/bin:${dirname(process.execPath)}` };
    const fixturePath = writeFixture(
      "refused-tools",
      `
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

// Product code spawns with Bun's default environment (cli/exec.ts); a test may also pass env: process.env.
const environments = [{}, { env: process.env }];

test.each(${JSON.stringify(refusedTools)})("refuses %s by name", (tool) => {
  for (const options of environments) {
    const result = Bun.spawnSync([tool, "--version"], { stdout: "pipe", stderr: "pipe", ...options });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString() + result.stderr.toString()).toContain(tool);
  }
});

test("a test's own fake orca gets the call", () => {
  const directory = mkdtempSync(join(tmpdir(), "fake-orca-"));
  writeFileSync(join(directory, "orca"), "#!/bin/sh\\necho fake-orca-output\\n");
  chmodSync(join(directory, "orca"), 0o755);
  process.env.PATH = directory + ":" + process.env.PATH;
  for (const options of environments) {
    const result = Bun.spawnSync(["orca"], { stdout: "pipe", ...options });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe("fake-orca-output");
  }
});

test("a tool outside the seven still runs", () => {
  expect(Bun.spawnSync(["git", "--version"]).exitCode).toBe(0);
});
`,
    );
    const child = Bun.spawn(["bun", "test", fixturePath], {
      cwd: repositoryRoot,
      env: { ...environment, TMPDIR: scratchDirectory(), HOME: process.env.HOME! },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output =
      (await new Response(child.stdout).text()) + (await new Response(child.stderr).text());
    expect(await child.exited, output).toBe(0);
    expect(output).toContain(" 9 pass");
    expect(existsSync(sentinelLog)).toBe(false);
  },
  { timeout: 60_000 },
);
