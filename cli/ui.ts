import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { arkHome } from "./paths.ts";
import { mainHubName, portlessProgram, proxyStartArguments, wrappedHubArguments } from "./proxy.ts";

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
const hubLabel = "dev.ark.hub";
const proxyLabel = "dev.ark.proxy";
const plistPath = (label: string) => join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
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

type Agent = {
  label: string;
  noun: string;
  arguments_: string[];
  keepAlive: boolean;
  log: string;
};

function plistFor(agent: Agent): string {
  // launchd starts with a bare PATH, so hand over this one: the hub finds orca by it, portless finds node.
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
  <key>Label</key><string>${agent.label}</string>
  <key>ProgramArguments</key>
  <array>
${agent.arguments_.map((argument) => `    <string>${xml(argument)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>${agent.keepAlive ? "<dict><key>SuccessfulExit</key><false/></dict>" : "<false/>"}
  <key>EnvironmentVariables</key>
  <dict>
${entries.join("\n")}
  </dict>
  <key>StandardOutPath</key><string>${xml(agent.log)}</string>
  <key>StandardErrorPath</key><string>${xml(agent.log)}</string>
</dict>
</plist>
`;
}

type Outcome = { failed: boolean; changed: boolean; lines: string[] };

/** Writes one agent's plist and loads it. A failed load restores that agent's previous plist. */
function installAgent(agent: Agent, extraLines: string[], port: number): Outcome {
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
  const oldPort = old?.match(/<string>--port<\/string>\s*<string>(\d+)</)?.[1];
  return {
    failed: false,
    changed: true,
    lines: [
      old === null
        ? `Installed LaunchAgent ${agent.label}`
        : `Updated LaunchAgent ${agent.label}${oldPort && oldPort !== `${port}` ? ` (port ${oldPort} -> ${port})` : ""}. Reloaded.`,
      `  plist:  ${path}`,
      ...extraLines,
      `  log:    ${agent.log}`,
    ],
  };
}

/**
 * Writes the LaunchAgents that start the hub (and, when portless is found, the name proxy) at login
 * and loads them. A second run with the same plists changes nothing. The proxy loads first, then the
 * hub; each agent is restored on its own, and the exit code is 1 if any load failed.
 * The hub may still start before the proxy at login; portless then starts a proxy itself.
 */
export function uiInstall(port: number): void {
  const hubLog = join(arkHome(), "hub", "hub.log");
  const portless = portlessProgram();
  const plainArguments = [
    process.execPath,
    join(import.meta.dir, "ark.ts"),
    "ui",
    "--port",
    `${port}`,
  ];
  const hubLines = [`  hub:    http://127.0.0.1:${port}`];
  if (portless) hubLines.push(`  name:   http://${mainHubName}`);
  const outcomes: Outcome[] = [];
  const labels: string[] = [];
  if (portless) {
    labels.push(proxyLabel);
    outcomes.push(
      installAgent(
        {
          label: proxyLabel,
          noun: "proxy",
          arguments_: proxyStartArguments(portless),
          keepAlive: false,
          log: join(arkHome(), "hub", "proxy.log"),
        },
        [],
        port,
      ),
    );
  } else {
    console.log(`portless not found: the hub stays at http://127.0.0.1:${port}`);
  }
  labels.push(hubLabel);
  outcomes.push(
    installAgent(
      {
        label: hubLabel,
        noun: "hub",
        arguments_: portless ? wrappedHubArguments(portless, port, plainArguments) : plainArguments,
        keepAlive: true,
        log: hubLog,
      },
      hubLines,
      port,
    ),
  );
  if (outcomes.some((outcome) => outcome.failed)) {
    for (const outcome of outcomes)
      if (outcome.lines.length > 0) console.log(outcome.lines.join("\n"));
    process.exitCode = 1;
    return;
  }
  const names = labels.join(" and ");
  if (outcomes.every((outcome) => !outcome.changed)) {
    console.log(
      [
        `LaunchAgent${labels.length > 1 ? "s" : ""} ${names} ${labels.length > 1 ? "are" : "is"} already installed. Nothing changed.`,
        ...outcomes.flatMap((outcome) => outcome.lines),
        ...hubLines,
      ].join("\n"),
    );
    return;
  }
  console.log(
    [
      ...outcomes.flatMap((outcome, index) => [
        ...(outcome.changed
          ? outcome.lines
          : [
              `LaunchAgent ${labels[index]} is already installed. Nothing changed.`,
              ...outcome.lines,
            ]),
        ...(labels[index] === hubLabel && !outcome.changed ? hubLines : []),
      ]),
      portless
        ? "The proxy starts at login. The hub starts at login and restarts after a crash. Both are running now.\nRemove them with: ark ui uninstall"
        : "The hub starts at login and restarts after a crash. It is running now.\nRemove it with: ark ui uninstall",
    ].join("\n"),
  );
}

/** Unloads and deletes both LaunchAgents. */
export function uiUninstall(): void {
  const removed: string[] = [];
  for (const label of [hubLabel, proxyLabel]) {
    const path = plistPath(label);
    if (!existsSync(path)) continue;
    launchctl("unload", path);
    rmSync(path);
    removed.push(`Removed LaunchAgent ${label}\n  plist:  ${path} (deleted)`);
  }
  console.log(
    removed.length === 0
      ? `LaunchAgents ${hubLabel} and ${proxyLabel} are not installed. Nothing changed.`
      : `${removed.join("\n")}\nThe hub is stopped and neither agent starts at login. The shared portless proxy keeps running until you run: portless proxy stop`,
  );
}
