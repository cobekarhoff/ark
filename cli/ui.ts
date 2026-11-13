import { join } from "node:path";
import { installAgent, type Outcome, plistPath, removeAgent } from "./agent.ts";
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
  const portNote = (old: string) => {
    const oldPort = old.match(/<string>--port<\/string>\s*<string>(\d+)</)?.[1];
    return oldPort && oldPort !== `${port}` ? ` (port ${oldPort} -> ${port})` : "";
  };
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
        portNote,
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
        keepAlive: "crash",
        log: hubLog,
      },
      hubLines,
      portNote,
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
    if (removeAgent(label))
      removed.push(`Removed LaunchAgent ${label}\n  plist:  ${path} (deleted)`);
  }
  console.log(
    removed.length === 0
      ? `LaunchAgents ${hubLabel} and ${proxyLabel} are not installed. Nothing changed.`
      : `${removed.join("\n")}\nThe hub is stopped and neither agent starts at login. The shared portless proxy keeps running until you run: portless proxy stop`,
  );
}
