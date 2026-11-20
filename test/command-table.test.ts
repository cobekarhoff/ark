import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");

async function runArk(
  sandbox: string,
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const environment: { [name: string]: string | undefined } = {
    ...process.env,
    HOME: join(sandbox, "home"),
    ARK_HOME: join(sandbox, "ark-home"),
  };
  delete environment.ARK_PROJECT;
  const child = Bun.spawn(["bun", join(repositoryRoot, "cli/ark.ts"), ...args], {
    cwd: join(sandbox, "work"),
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

test("ARK-T704 a bad call of an ark command stops in the parser with its reason and its usage, and help of a command that has a longer sibling prints its own usage", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ark-parser-"));
  for (const folder of ["home", "ark-home", "work"]) mkdirSync(join(sandbox, folder));
  try {
    const retroUsage = "usage: ark retro <run> [--project <name>]";
    const rejected: { args: string[]; reason: string; usage: string }[] = [
      { args: ["retro"], reason: "wrong number of arguments", usage: retroUsage },
      { args: ["retro", "a", "b"], reason: "wrong number of arguments", usage: retroUsage },
      { args: ["retro", "a", "--project"], reason: "--project needs a value", usage: retroUsage },
      {
        args: ["status", "--zz-first"],
        reason: "unknown flag --zz-first",
        usage: "usage: ark status [<run>] [--project <name>]",
      },
      {
        args: ["chief", "state", "extra"],
        reason: "wrong number of arguments",
        usage: "usage: ark chief state [--project <name>]",
      },
    ];
    for (const { args, reason, usage } of rejected) {
      const result = await runArk(sandbox, ...args);
      const label = `ark ${args.join(" ")}`;
      expect({ label, code: result.code }).toEqual({ label, code: 1 });
      expect(result.stderr).toContain(reason);
      expect(result.stderr.split("\n")).toContain(usage);
      expect(result.stdout).toBe("");
    }
    // No handler ran: none wrote into the empty ARK_HOME or working directory (Bun's own
    // cache lands in HOME).
    expect(readdirSync(join(sandbox, "ark-home"))).toEqual([]);
    expect(readdirSync(join(sandbox, "work"))).toEqual([]);

    // Longest match: a command that is a prefix of another still prints its own usage.
    const installHelp = await runArk(sandbox, "ui", "install", "--help");
    expect(installHelp.code).toBe(0);
    expect(installHelp.stdout).toStartWith("ark ui install ");
    const uiHelp = await runArk(sandbox, "ui", "--help");
    expect(uiHelp.code).toBe(0);
    expect(uiHelp.stdout).toStartWith("ark ui [--port");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}, 120_000);
