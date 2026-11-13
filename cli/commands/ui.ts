import { ui, uiInstall, uiUninstall } from "../ui.ts";
import type { Command } from "./types.ts";

export const uiCommand: Command = {
  usage: "ui [--port <number>] [--name <host>]",
  description:
    "Serves the hub in hub/ on 127.0.0.1, port 4317 unless --port says otherwise (0 picks a free port). --name <host> (such as ark.localhost) also lets the hub answer to that name. One background reader builds a snapshot of the runs, plans, models, MRs, usage cost, tickets and roadmap; the page gets it over one Server-Sent Events stream (/events; GET /api/snapshot returns the same JSON). A closed run, its decisions, files and agent transcripts are read when the page asks, not kept in the snapshot. Views: Home (tiles for what needs you, then blockers, the review queue and run progress with usage), Runs (every run on one board and a cross-run dependency graph; #/map redirects here), a run page (any run: progress strip, plan, agents, MR evidence, decisions, files, transcripts) and Roadmap (grouped table; a ticket opens as a full page with its dependency graph; the ticket text is read when the page asks, GET /api/ticket/<project>/<id>). The hub's one action is POST /api/open-in-orca, which runs orca terminal switch for a live terminal; it sends no text to a terminal, changes no run state and steers no agent. One hub runs per Ark repo: a second hub for the same repo (any port) prints `Ark hub already runs on http://127.0.0.1:<port>` with the port of the running hub and exits 0 (lock file in ARK_HOME; a lock of a dead pid is taken over). The reader runs only while a page is connected to /events: an idle hub runs no Orca, Plannotator or GitHub read and watches no Ark folder (GET /api/snapshot does not wake it), and it reads Plannotator only while an open run has an open gate.",
  flags: { "--port": true, "--name": true },
  minimum: 0,
  maximum: 0,
  run: (_positionals, flags) =>
    ui(Number(flags["--port"] ?? 4317), flags["--name"] as string | undefined),
};

export const uiInstallCommand: Command = {
  usage: "ui install [--port <number>]",
  description:
    "Writes the LaunchAgents dev.ark.proxy and dev.ark.hub in ~/Library/LaunchAgents and loads them (proxy first), so the name proxy (portless proxy start --unprivileged) starts at login and the hub starts at login and restarts after a crash (KeepAlive SuccessfulExit false: not after a clean exit, such as a refused second hub) (port 4317 unless --port says otherwise). When portless is found (ARK_PORTLESS, else PATH; it needs Node 24+ on the PATH of the shell that runs install), the hub runs through it as http://ark.localhost and install prints the line '  name:   http://ark.localhost'. When it is not found, install writes no proxy agent, keeps the plain hub, prints 'portless not found: the hub stays at http://127.0.0.1:<port>' and exits 0. A second run with the same settings changes nothing; with a new port or a switch between the two forms it rewrites the plist and reloads. If loading an agent fails, install restores and reloads the previous plist of that agent only (or removes a new plist), reports any reload failure, and exits 1. See docs/how-to/local-names.md.",
  flags: { "--port": true },
  minimum: 0,
  maximum: 0,
  run: (_positionals, flags) => uiInstall(Number(flags["--port"] ?? 4317)),
};

export const uiUninstallCommand: Command = {
  usage: "ui uninstall",
  description:
    "Unloads and deletes the LaunchAgents dev.ark.hub and dev.ark.proxy, so the hub stops and neither starts at login. It does not stop the shared portless proxy: that keeps running until you run `portless proxy stop`. It does nothing, and exits 0, when neither agent is installed.",
  flags: {},
  minimum: 0,
  maximum: 0,
  run: () => uiUninstall(),
};
