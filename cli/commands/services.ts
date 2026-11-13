import { servicesInstall, servicesStatus, servicesUninstall } from "../services.ts";
import type { Command } from "./types.ts";

export const servicesInstallCommand: Command = {
  usage: "services install [--project <name>]",
  description:
    "Writes one LaunchAgent for each background job of the project in ~/Library/LaunchAgents and loads it: dev.ark.<project>.auto-merger (scripts/auto-merger.sh, every 60 s), dev.ark.<project>.temp-cleaner (scripts/temp-cleaner.sh, every 300 s) and dev.ark.<project>.sweep (scripts/sweep.sh, every 300 s). They start at login (RunAtLoad), restart after any exit (KeepAlive true, ThrottleInterval 30) and log to ~/.ark/projects/<project>/services/<service>.log. The scripts run from this clone (resolved from the module, not the workspace) and get the PATH, HOME, TMPDIR, ARK_HOME and ARK_PROJECT of the shell that runs install; it warns when ark, gh, orca or jq is not on that PATH. A second run with the same plists loads nothing again; a changed plist is unloaded and loaded again. A project with `merge_requests: none` gets no auto-merger, and one loaded from an earlier setting is unloaded and deleted. The labels carry the project, so they never collide with dev.ark.hub or dev.ark.proxy. Exits 1 when a load fails. --project falls back to ARK_PROJECT.",
  flags: { "--project": true },
  minimum: 0,
  maximum: 0,
  run: (_positionals, flags) => servicesInstall(flags["--project"] as string | undefined),
};

export const servicesUninstallCommand: Command = {
  usage: "services uninstall [--project <name>]",
  description:
    "Unloads and deletes the three LaunchAgents of the project (auto-merger, temp-cleaner, sweep). It leaves the logs and the other projects alone, and it does nothing, and exits 0, when none is installed. --project falls back to ARK_PROJECT.",
  flags: { "--project": true },
  minimum: 0,
  maximum: 0,
  run: (_positionals, flags) => servicesUninstall(flags["--project"] as string | undefined),
};

export const servicesStatusCommand: Command = {
  usage: "services status [--project <name>]",
  description:
    "Prints one line for each service of the project: `not installed`, `loaded` (loaded, no process) or `running` with `pid <n>` (from `launchctl list <label>`), and `last log: <last line of its log>`. `ark chief state` prints the same lines under its Services heading. A project with `merge_requests: none` shows the auto-merger as not installed. --project falls back to ARK_PROJECT.",
  flags: { "--project": true },
  minimum: 0,
  maximum: 0,
  run: (_positionals, flags) => servicesStatus(flags["--project"] as string | undefined),
};
