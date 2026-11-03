import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { arkHome } from "./paths.ts";

/** Serves the hub in `hub/` as a child process and ends with it. Port 0 picks a free port. */
export async function ui(port: number, name?: string): Promise<void> {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "..", "hub", "main.ts"),
      "--port",
      `${port}`,
      ...(name === undefined ? [] : ["--name", name]),
    ],
    {
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  process.exitCode = await child.exited;
}

const label = "dev.ark.hub";
const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const launchctl = (...arguments_: string[]): { ok: boolean; error: string } => {
  try {
    const result = Bun.spawnSync([process.env.ARK_LAUNCHCTL || "launchctl", ...arguments_], {
      stdout: "ignore",
      stderr: "pipe",
    });
    return {
      ok: result.exitCode === 0,
      error: result.stderr.toString().trim(),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const xml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function plistFor(port: number, log: string): string {
  const arguments_ = [process.execPath, join(import.meta.dir, "ark.ts"), "ui", "--port", `${port}`];
  // launchd starts with a bare PATH, so hand over this one: the hub finds orca by it.
  const environment = {
    PATH: process.env.PATH ?? "",
    ARK_HOME: process.env.ARK_HOME ?? "",
  };
  const entries = Object.entries(environment)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `    <key>${key}</key><string>${xml(value)}</string>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${arguments_.map((argument) => `    <string>${xml(argument)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
${entries.join("\n")}
  </dict>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

/** Writes the LaunchAgent that starts the hub at login and loads it. A second run with the same plist changes nothing. */
export function uiInstall(port: number): void {
  const path = plistPath();
  const log = join(arkHome(), "hub", "hub.log");
  const plist = plistFor(port, log);
  const old = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (old === plist) {
    console.log(
      `LaunchAgent ${label} is already installed. Nothing changed.\n  plist:  ${path}\n  hub:    http://127.0.0.1:${port}`,
    );
    return;
  }
  mkdirSync(join(path, ".."), { recursive: true });
  mkdirSync(join(log, ".."), { recursive: true });
  if (old !== null) launchctl("unload", path);
  writeFileSync(path, plist);
  const loaded = launchctl("load", "-w", path);
  if (!loaded.ok) {
    let recovery: string;
    if (old === null) {
      rmSync(path);
      recovery = "The hub is not running.";
    } else {
      writeFileSync(path, old);
      const restored = launchctl("load", "-w", path);
      recovery = restored.ok
        ? `The update was not applied. Restored the previous LaunchAgent ${label} and reloaded it.\nThe hub is running with the old settings.`
        : `The previous LaunchAgent was restored, but reloading it failed: ${restored.error || "no error text"}\nThe hub is not running.`;
    }
    console.error(`launchctl load failed: ${loaded.error || "no error text"}\n${recovery}`);
    process.exitCode = 1;
    return;
  }
  const oldPort = old?.match(/<string>--port<\/string>\s*<string>(\d+)</)?.[1];
  console.log(
    [
      old === null
        ? `Installed LaunchAgent ${label}`
        : `Updated LaunchAgent ${label}${oldPort && oldPort !== `${port}` ? ` (port ${oldPort} -> ${port})` : ""}. Reloaded.`,
      `  plist:  ${path}`,
      `  hub:    http://127.0.0.1:${port}`,
      `  log:    ${log}`,
      "The hub starts at login and restarts after a crash. It is running now.",
      "Remove it with: ark ui uninstall",
    ].join("\n"),
  );
}

/** Unloads and deletes the LaunchAgent. */
export function uiUninstall(): void {
  const path = plistPath();
  if (!existsSync(path)) {
    console.log(`LaunchAgent ${label} is not installed. Nothing changed.`);
    return;
  }
  launchctl("unload", path);
  rmSync(path);
  console.log(
    `Removed LaunchAgent ${label}\n  plist:  ${path} (deleted)\nThe hub is stopped and will not start at login.`,
  );
}
