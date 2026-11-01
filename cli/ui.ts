import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import index from "../ui/index.html";
import { isLocalRequest, runAction } from "./hub/actions.ts";
import { arkHome } from "./paths.ts";
import { createNotifier, markActed } from "./hub/notify.ts";
import { createHub, knownUrls, markSeen } from "./hub/state.ts";

const stateIntervalMilliseconds = 1000;
const refreshIntervalMilliseconds = 3000;
const heartbeatMilliseconds = 10_000;

/**
 * Serves the hub. Port 0 picks a free port. Runs until the process ends.
 *
 * Ark's files are read every second, so a change in `events.ndjson` reaches the page at once.
 * Orca and Plannotator are read every 3 seconds in the background, each with a hard timeout,
 * and never delay that push.
 */
export function ui(port: number): void {
  const hub = createHub();
  const encoder = new TextEncoder();
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const notifier = createNotifier(() => server.port!);
  let lastPushed = "";
  let refreshedOnce = false;

  const push = () => {
    const state = hub.state();
    notifier.poll(state.needs_me, {
      ark: refreshedOnce,
      orca: state.readers.orca === "ok",
      plannotator: state.readers.plannotator === "ok",
    });
    const json = JSON.stringify(state);
    if (json === lastPushed) return;
    lastPushed = json;
    for (const client of clients) client.enqueue(encoder.encode(`data: ${json}\n\n`));
  };

  // ponytail: re-reads every run's log each second; watch the files if hundreds of runs make this slow.
  setInterval(push, stateIntervalMilliseconds);
  setInterval(() => {
    for (const client of clients) client.enqueue(encoder.encode(": keep-alive\n\n"));
  }, heartbeatMilliseconds);
  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      await hub.refresh();
      refreshedOnce = true;
    } finally {
      refreshing = false;
    }
  };
  void refresh();
  setInterval(() => void refresh(), refreshIntervalMilliseconds);

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    routes: {
      "/": index,
      "/api/state": () => Response.json(hub.state()),
      "/api/runs/:run": async (request) => {
        const detail = await hub.detail(request.params.run);
        return detail
          ? Response.json(detail)
          : Response.json({ error: "no such run" }, { status: 404 });
      },
      "/api/needs-me": () => Response.json(hub.state().needs_me),
      "/api/events": () => {
        let controller: ReadableStreamDefaultController<Uint8Array>;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(streamController) {
              controller = streamController;
              clients.add(controller);
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(hub.state())}\n\n`));
            },
            cancel() {
              clients.delete(controller);
            },
          }),
          { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
        );
      },
      "/api/seen": {
        POST: (request) => {
          if (!isLocalRequest(request, server.port!))
            return Response.json({ error: "foreign origin" }, { status: 403 });
          markSeen();
          return Response.json({ ok: true });
        },
      },
      "/api/notifications/acted": {
        POST: async (request) => {
          if (!isLocalRequest(request, server.port!))
            return Response.json({ error: "foreign origin" }, { status: 403 });
          const { id } = (await request.json().catch(() => ({}))) as { id?: unknown };
          if (typeof id !== "string") return Response.json({ error: "id needed" }, { status: 400 });
          markActed(id);
          return Response.json({ ok: true });
        },
      },
      "/api/actions/:name": {
        POST: async (request) => {
          if (!isLocalRequest(request, server.port!))
            return Response.json({ error: "foreign origin" }, { status: 403 });
          const params = (await request.json().catch(() => ({}))) as Record<string, unknown>;
          const { status, body } = await runAction(
            request.params.name,
            params,
            knownUrls(hub.state()),
          );
          return Response.json(body, { status });
        },
      },
    },
    fetch: () => new Response("not found", { status: 404 }),
  });
  console.log(`Ark hub on http://127.0.0.1:${server.port}`);
}

const label = "dev.ark.hub";
const notifierCommand = () => process.env.ARK_NOTIFIER || "terminal-notifier";
const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const launchctl = (...arguments_: string[]): { ok: boolean; error: string } => {
  try {
    const result = Bun.spawnSync([process.env.ARK_LAUNCHCTL || "launchctl", ...arguments_], {
      stdout: "ignore",
      stderr: "pipe",
    });
    return { ok: result.exitCode === 0, error: result.stderr.toString().trim() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

const xml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function plistFor(port: number, log: string): string {
  const arguments_ = [process.execPath, join(import.meta.dir, "ark.ts"), "ui", "--port", `${port}`];
  // launchd starts with a bare PATH, so hand over this one: the hub finds orca and the notifier by it.
  const environment = {
    PATH: process.env.PATH ?? "",
    ARK_HOME: process.env.ARK_HOME ?? "",
    ARK_NOTIFIER: notifierCommand(),
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
  const notifier = notifierCommand();
  if (!Bun.which(notifier)) {
    console.error(
      `${notifier} is not installed. Notifications cannot open the hub on click without it.\nInstall it, then run this again:\n  brew install terminal-notifier\nNothing was written.`,
    );
    process.exitCode = 1;
    return;
  }
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
    // Remove the plist so a second run retries instead of reporting "already installed".
    rmSync(path);
    console.error(
      `launchctl load failed: ${loaded.error || "no error text"}\nThe hub is not running.`,
    );
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

/** Unloads and deletes the LaunchAgent. The notification history stays. */
export function uiUninstall(): void {
  const path = plistPath();
  if (!existsSync(path)) {
    console.log(`LaunchAgent ${label} is not installed. Nothing changed.`);
    return;
  }
  launchctl("unload", path);
  rmSync(path);
  console.log(
    `Removed LaunchAgent ${label}\n  plist:  ${path} (deleted)\nThe hub is stopped and will not start at login.\nNotification history in ${join(arkHome(), "hub", "notifications.ndjson")} is kept.`,
  );
}
