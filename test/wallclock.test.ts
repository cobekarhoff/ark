import { expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

setDefaultTimeout(30_000);

// ARK-331 guard: a test that waits on, or asserts against, the wall clock fails under load. Each
// file may hold at most its count in wallclock-allowed.json; a new use fails this test. Use an event
// wait or a controlled clock instead. Lower a count when a use is removed:
//   ARK_WALLCLOCK_PRINT=1 bun test test/wallclock.test.ts
// wallclock-base.json holds the counts of the base commit (16b4198). The allowed list may never
// exceed it, so it cannot be raised to make the guard pass.
// A *.pw.ts spec may not read a date at all (new Date( or Date.now(): see wallclock-dates.ts, limit 0, no allowance);
// it takes dates from isoAt, dateOf and testNow in test/pw/helpers.ts, which follow the frozen ARK_NOW.
// ponytail: line-pattern scan, not an AST; a sleep hidden behind a helper escapes it.
const forbidden = [
  /\bwaitForTimeout\(/,
  /\bBun\.sleep\(/,
  /\bsetTimeout\(/,
  /\.toBeLessThan\(\s*\d[\d_]{2,}\s*\)/,
];

const testRoot = resolve(import.meta.dir);
const readCounts = (name: string): Record<string, number> =>
  JSON.parse(readFileSync(join(testRoot, name), "utf8"));

export function countUses(text: string): number {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//") && forbidden.some((p) => p.test(line)))
    .length;
}

/** Files whose count is above their allowance. */
export function above(
  counts: Record<string, number>,
  limits: Record<string, number>,
): [file: string, count: number, limit: number][] {
  return Object.entries(counts)
    .filter(([file, count]) => count > (limits[file] ?? 0))
    .map(([file, count]) => [file, count, limits[file] ?? 0]);
}

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? entry.name === "fixtures" || entry.name === "cases"
        ? []
        : sources(join(directory, entry.name))
      : /\.(test|pw)\.ts$/.test(entry.name) && entry.name !== "wallclock.test.ts"
        ? [join(directory, entry.name)]
        : [],
  );
}

function currentCounts(): Record<string, number> {
  const uses: Record<string, number> = {};
  for (const file of sources(testRoot)) {
    const count = countUses(readFileSync(file, "utf8"));
    if (count > 0) uses[file.slice(testRoot.length - "test".length)] = count;
  }
  return uses;
}

test("ARK-T126 no test file gains a wall-clock wait or millisecond budget", () => {
  const uses = currentCounts();
  if (process.env.ARK_WALLCLOCK_PRINT) console.log(JSON.stringify(uses, null, 2));
  expect(
    above(uses, readCounts("wallclock-allowed.json")),
    "[file, count, allowed]: use an event wait or a controlled clock",
  ).toEqual([]);
});

test("ARK-T126 the allowed list never exceeds the base-commit list", () => {
  expect(above(readCounts("wallclock-allowed.json"), readCounts("wallclock-base.json"))).toEqual(
    [],
  );
});

// The date guard and helper load inside their tests, so a missing module fails that test alone.
const loadDates = async () =>
  (await import("./wallclock-dates" as string)) as { countDateReads: (text: string) => number };

const spec = readFileSync(join(testRoot, "pw/checkpoint.pw.ts"), "utf8");
const specFile = "test/pw/checkpoint.pw.ts";

test("ARK-T126 an appended waitForTimeout, Bun.sleep, setTimeout or toBeLessThan(ms) fails and names the file", () => {
  const allowed = { [specFile]: countUses(spec) };
  expect(above({ [specFile]: countUses(spec) }, allowed)).toEqual([]);
  for (const line of [
    "await page.waitForTimeout(100);",
    "await Bun.sleep(1);",
    "setTimeout(() => {}, 1);",
    "expect(elapsed).toBeLessThan(5000);",
  ]) {
    const grown = countUses(`${spec}\n${line}`);
    expect(above({ [specFile]: grown }, allowed), line).toEqual([
      [specFile, allowed[specFile] + 1, allowed[specFile]],
    ]);
  }
});

test("ARK-T126 a file below its listed count passes", () => {
  expect(above({ [specFile]: 2 }, { [specFile]: 3 })).toEqual([]);
});

test("ARK-T126 a raised allowance fails against the base list and a lowered one passes", () => {
  const base = { "test/hub.test.ts": 17, "test/run.test.ts": 2 };
  expect(above({ "test/hub.test.ts": 16, "test/run.test.ts": 2 }, base)).toEqual([]);
  expect(above({ "test/hub.test.ts": 18, "test/run.test.ts": 2 }, base)).toEqual([
    ["test/hub.test.ts", 18, 17],
  ]);
  expect(above({ "test/new.test.ts": 1 }, base)).toEqual([["test/new.test.ts", 1, 0]]);
});

test("ARK-T126 an appended new Date( or Date.now( fails a pw spec at limit 0; a comment or a unit test file does not", async () => {
  const { countDateReads } = await loadDates();
  expect(countDateReads(spec), "checkpoint.pw.ts starts clean").toBe(0);
  for (const line of ["const d = new Date();", "const n = Date.now();"]) {
    expect(above({ [specFile]: countDateReads(`${spec}\n${line}`) }, {}), line).toEqual([
      [specFile, 1, 0],
    ]);
  }
  expect(countDateReads(`${spec}\n// new Date(`)).toBe(0);
  // the date list covers *.pw.ts only: the same line in a unit test is left to the shared list
  expect(countUses("const d = new Date();")).toBe(0);
});

const specs = sources(testRoot).filter((file) => file.endsWith(".pw.ts"));
const relative = (file: string) => file.slice(testRoot.length - "test".length);

test("ARK-T349 no playwright spec reads the wall clock", async () => {
  const { countDateReads } = await loadDates();
  expect(specs.length).toBeGreaterThan(0);
  expect(
    above(
      Object.fromEntries(
        specs.map((file) => [relative(file), countDateReads(readFileSync(file, "utf8"))]),
      ),
      {},
    ),
    "[file, count, 0]: use isoAt from test/pw/helpers.ts",
  ).toEqual([]);
});

test("ARK-T349 isoAt follows ARK_NOW", async () => {
  const { isoAt } = (await import("./pw/helpers.ts" as string)) as {
    isoAt: (offsetMs?: number) => string;
  };
  const saved = process.env.ARK_NOW;
  try {
    for (const instant of ["2026-11-04T23:30:00Z", "2026-02-01T00:00:00Z"]) {
      process.env.ARK_NOW = instant;
      expect(isoAt()).toBe(new Date(instant).toISOString());
      expect(isoAt(-60_000)).toBe(new Date(Date.parse(instant) - 60_000).toISOString());
    }
  } finally {
    if (saved === undefined) delete process.env.ARK_NOW;
    else process.env.ARK_NOW = saved;
  }
});

/** Spec files that break the ARK_NOW rules: [file, rule]. */
function clockRuleBreaks(texts: Record<string, string>): [string, string][] {
  return Object.entries(texts).flatMap(([file, text]) => [
    ...(/\bstartHub\(/.test(text) && !/\buseCleanup\(/.test(text)
      ? [[file, "startHub without useCleanup"] as [string, string]]
      : []),
    ...(text.includes("delete process.env.ARK_NOW")
      ? [[file, "delete process.env.ARK_NOW"] as [string, string]]
      : []),
  ]);
}

test("ARK-T350 every spec that starts a hub calls useCleanup and none deletes ARK_NOW", () => {
  const texts = Object.fromEntries(
    specs.map((file) => [relative(file), readFileSync(file, "utf8")]),
  );
  expect(Object.keys(texts)).toContain("test/pw/hub.pw.ts");
  expect(clockRuleBreaks(texts)).toEqual([]);
  // the scan sees both breaks on a mutated copy of the hub spec
  const hub = texts["test/pw/hub.pw.ts"];
  expect(clockRuleBreaks({ hub: `${hub}\ndelete process.env.ARK_NOW;` })).toEqual([
    ["hub", "delete process.env.ARK_NOW"],
  ]);
  expect(clockRuleBreaks({ hub: hub.replaceAll("useCleanup(", "noop(") })).toEqual([
    ["hub", "startHub without useCleanup"],
  ]);
});
