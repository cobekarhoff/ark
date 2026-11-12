import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ArkError } from "./errors.ts";

/** One LaunchAgent. `keepAlive` "crash" restarts after a failure only; "always" restarts after any exit too. */
export type Agent = {
  label: string;
  noun: string;
  arguments_: string[];
  keepAlive: false | "crash" | "always";
  log: string;
  /** Defaults to the PATH and ARK_HOME of the installing shell. */
  environment?: Record<string, string>;
  /** Seconds launchd waits before it starts the agent again. */
  throttleSeconds?: number;
};

export const plistPath = (label: string) =>
  join(homedir(), "Library", "LaunchAgents", `${label}.plist`);

export const launchctl = (
  ...arguments_: string[]
): { ok: boolean; output: string; error: string } => {
  try {
    const result = Bun.spawnSync([process.env.ARK_LAUNCHCTL || "launchctl", ...arguments_], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      ok: result.exitCode === 0,
      output: result.stdout.toString(),
      error: result.stderr.toString().trim(),
    };
  } catch (error) {
    return {
      ok: false,
      output: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const xml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const keepAliveXml = {
  false: "<false/>",
  crash: "<dict><key>SuccessfulExit</key><false/></dict>",
  always: "<true/>",
};

function plistFor(agent: Agent): string {
  // launchd starts with a bare PATH, so hand over the installing shell's: the hub finds orca by it, portless finds node.
  const environment = agent.environment ?? {
    PATH: process.env.PATH ?? "",
    ARK_HOME: process.env.ARK_HOME ?? "",
  };
  const entries = Object.entries(environment)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `    <key>${key}</key><string>${xml(value)}</string>`);
  const throttle =
    agent.throttleSeconds === undefined
      ? ""
      : `  <key>ThrottleInterval</key><integer>${agent.throttleSeconds}</integer>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${agent.label}</string>
  <key>ProgramArguments</key>
  <array>
${agent.arguments_.map((argument) => `    <string>${xml(argument)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>${keepAliveXml[`${agent.keepAlive}`]}
${throttle}  <key>EnvironmentVariables</key>
  <dict>
${entries.join("\n")}
  </dict>
  <key>StandardOutPath</key><string>${xml(agent.log)}</string>
  <key>StandardErrorPath</key><string>${xml(agent.log)}</string>
</dict>
</plist>
`;
}

export type Outcome = { failed: boolean; changed: boolean; lines: string[] };

/**
 * Writes one agent's plist and loads it. An unchanged plist is not loaded again (launchctl refuses a
 * loaded label); a changed one is unloaded, written and loaded. A failed load restores the previous plist.
 * `updateNote` adds a suffix to the "Updated" line from the old plist text.
 */
export function installAgent(
  agent: Agent,
  extraLines: string[],
  updateNote: (oldPlist: string) => string = () => "",
): Outcome {
  const path = plistPath(agent.label);
  const plist = plistFor(agent);
  const old = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (old === plist) return { failed: false, changed: false, lines: [`  plist:  ${path}`] };
  mkdirSync(join(path, ".."), { recursive: true });
  mkdirSync(join(agent.log, ".."), { recursive: true });
  if (old !== null) launchctl("unload", path);
  writeFileSync(path, plist);
  const loaded = launchctl("load", "-w", path);
  if (!loaded.ok) {
    let recovery: string;
    if (old === null) {
      rmSync(path);
      recovery = `The ${agent.noun} is not running.`;
    } else {
      writeFileSync(path, old);
      const restored = launchctl("load", "-w", path);
      recovery = restored.ok
        ? `The update was not applied. Restored the previous LaunchAgent ${agent.label} and reloaded it.\nThe ${agent.noun} is running with the old settings.`
        : `The previous LaunchAgent was restored, but reloading it failed: ${restored.error || "no error text"}\nThe ${agent.noun} is not running.`;
    }
    console.error(`launchctl load failed: ${loaded.error || "no error text"}\n${recovery}`);
    return { failed: true, changed: false, lines: [] };
  }
  return {
    failed: false,
    changed: true,
    lines: [
      old === null
        ? `Installed LaunchAgent ${agent.label}`
        : `Updated LaunchAgent ${agent.label}${updateNote(old)}. Reloaded.`,
      `  plist:  ${path}`,
      ...extraLines,
      `  log:    ${agent.log}`,
    ],
  };
}

/**
 * Unloads and deletes one agent's plist. Returns false when it was not installed. A failed unload keeps the plist
 * (so a retry still finds it) and throws, unless launchd says the label is not loaded.
 */
export function removeAgent(label: string): boolean {
  const path = plistPath(label);
  if (!existsSync(path)) return false;
  if (!launchctl("unload", path).ok && launchctl("list", label).ok)
    throw new ArkError(
      `launchctl unload ${path} failed and ${label} is still loaded. The plist was kept.`,
    );
  rmSync(path);
  return true;
}
