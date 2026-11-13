import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(300_000);

const repositoryRoot = join(import.meta.dir, "..");
const snapshotPath = join(import.meta.dir, "command-table.snapshot.json");
// Commands whose handlers start a hub, write outside the directory, or (run close) reject
// zero positionals themselves: only the fail side of their bounds is probed.
const failSideOnly: Record<string, { minimum: number; maximum: number }> = {
  ui: { minimum: 0, maximum: 0 },
  "ui install": { minimum: 0, maximum: 0 },
  "ui uninstall": { minimum: 0, maximum: 0 },
  "services install": { minimum: 0, maximum: 0 },
  "services uninstall": { minimum: 0, maximum: 0 },
  "run close": { minimum: 0, maximum: 2 },
};
const probeLimit = 5;

const sandbox = mkdtempSync(join(tmpdir(), "ark-table-"));
const env: { [name: string]: string | undefined } = {
  ...process.env,
  HOME: sandbox,
  ARK_HOME: sandbox,
};
delete env.ARK_PROJECT;

async function ark(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn(["bun", join(repositoryRoot, "cli/ark.ts"), ...args], {
    cwd: sandbox,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, out, err };
}

const wrongCount = (err: string) => err.includes("wrong number of arguments");
const positionals = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);

type Arity = "absent" | "switch" | "value";
type Row = {
  command: string;
  usage: string;
  description: string;
  flags: { [flag: string]: Arity };
  minimum: number;
  maximum: number | "unbounded";
};

async function probeFlag(words: string[], flag: string): Promise<Arity> {
  const { err } = await ark(...words, flag, "--zz-first", "--zz-second");
  const named = err.match(/unknown flag (--\S+)/)?.[1];
  if (named === flag) return "absent";
  if (named === "--zz-first") return "switch";
  if (named === "--zz-second") {
    expect((await ark(...words, flag)).err).toContain(`${flag} needs a value`);
    return "value";
  }
  throw new Error(`ark ${words.join(" ")} ${flag}: unexpected stderr ${err}`);
}

async function probeBounds(words: string[], command: string) {
  const fixed = failSideOnly[command];
  if (fixed) {
    // Pass side skipped (see failSideOnly); the bound is fixed here and its fail side probed.
    expect(wrongCount((await ark(...words, ...positionals(fixed.maximum + 1))).err)).toBe(true);
    return fixed;
  }
  const accepted: boolean[] = [];
  for (let n = 0; n <= probeLimit; n++) {
    accepted.push(!wrongCount((await ark(...words, ...positionals(n))).err));
  }
  const minimum = accepted.indexOf(true);
  const last = accepted.lastIndexOf(true);
  expect(minimum).toBeGreaterThanOrEqual(0);
  expect(accepted.slice(minimum, last + 1).every(Boolean)).toBe(true);
  return { minimum, maximum: last === probeLimit ? ("unbounded" as const) : last };
}

async function describe(line: string): Promise<Row> {
  const words = line.match(/^[a-z][a-z-]*(?: [a-z][a-z-]*)*/)![0].split(" ");
  const command = words.join(" ");
  const help = (await ark(...words, "--help")).out;
  const separator = help.trim().indexOf("\n\n");
  const usageLine = help.trim().slice(0, separator);
  const description = help.trim().slice(separator + 2);
  expect(usageLine).toBe(`ark ${line}`);
  expect((await ark(...words, "--zz-first")).err).toContain("unknown flag --zz-first");
  const flags: Row["flags"] = {};
  for (const flag of line.match(/--[a-z][a-z-]*/g) ?? [])
    flags[flag] = await probeFlag(words, flag);
  return { command, usage: line, description, flags, ...(await probeBounds(words, command)) };
}

test("ARK-T283 the command table is the same as at base - order, usage, description, usage-advertised flags with arity, argument counts", async () => {
  try {
    const help = (await ark("--help")).out.trim().split("\n");
    expect(help[0]).toBe("Usage: ark <command>");
    const lines = help.slice(1).map((line) => line.trim());
    expect(lines.some((line) => line.startsWith("test-runner"))).toBe(false);
    const records = await Promise.all(lines.map(describe));
    if (process.env.UPDATE_COMMAND_TABLE) {
      writeFileSync(snapshotPath, `${JSON.stringify(records, null, 2)}\n`);
    }
    expect(records).toEqual(JSON.parse(readFileSync(snapshotPath, "utf8")));
    expect(records).toHaveLength(30);
    // Longest match: a command that is a prefix of another still prints its own usage.
    for (const command of ["ui", "ui install", "test", "test-case new", "test-audit inventory"]) {
      expect((await ark(...command.split(" "), "--help")).out).toStartWith(`ark ${command} `);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
