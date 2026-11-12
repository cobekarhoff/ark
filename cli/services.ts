import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installAgent, launchctl, plistPath, removeAgent } from "./agent.ts";
import { loadConfig, mergeRequestsMode } from "./config.ts";
import { arkHome, projectDirectory, resolveProject } from "./paths.ts";

/** The background jobs of a project: the script of each and the seconds between its passes. */
const services = [
  { name: "auto-merger", script: "auto-merger.sh", interval: 60 },
  { name: "temp-cleaner", script: "temp-cleaner.sh", interval: 300 },
  { name: "sweep", script: "sweep.sh", interval: 300 },
] as const;

const label = (project: string, service: string) => `dev.ark.${project}.${service}`;
const logPath = (project: string, service: string) =>
  join(projectDirectory(project), "services", `${service}.log`);

/**
 * Writes and loads one LaunchAgent for each service of the project. The auto-merger is skipped for
 * `merge_requests: none`, and one loaded by an earlier setting is removed. A second run with the same
 * plists changes nothing; a changed plist is unloaded and loaded again. Exit code 1 if a load failed.
 */
export function servicesInstall(inProject: string | undefined): void {
  const project = resolveProject(inProject);
  const workspace = resolve(loadConfig(project).workspace);
  const scripts = join(import.meta.dir, "..", "scripts");
  const environment = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ARK_HOME: arkHome(),
    ARK_PROJECT: project,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
  };
  // launchd uses the PATH of this shell, so a missing program fails at run time, not here: say so now.
  const missing = ["ark", "gh", "orca", "jq"].filter((program) => !Bun.which(program));
  const lines: string[] = [];
  if (missing.length > 0)
    lines.push(
      `Warning: ${missing.join(", ")} not found on the PATH of this shell. The services get this PATH, so the jobs that need them will log a notice and do nothing.`,
    );
  let failed = false;
  for (const service of services) {
    const agentLabel = label(project, service.name);
    if (service.name === "auto-merger" && mergeRequestsMode(project) === "none") {
      lines.push(
        removeAgent(agentLabel)
          ? `Removed LaunchAgent ${agentLabel}: merge_requests: none, so no MR is merged.`
          : `${service.name}: not installed, merge_requests: none.`,
      );
      continue;
    }
    const outcome = installAgent(
      {
        label: agentLabel,
        noun: service.name,
        arguments_: ["/bin/bash", join(scripts, service.script), workspace, `${service.interval}`],
        // The scripts loop until stopped, so any exit is a fault or a stop: restart it, slowly.
        keepAlive: "always",
        throttleSeconds: 30,
        log: logPath(project, service.name),
        environment,
      },
      [],
    );
    failed ||= outcome.failed;
    lines.push(
      ...(outcome.changed || outcome.failed
        ? outcome.lines
        : [`LaunchAgent ${agentLabel} is already installed. Nothing changed.`, ...outcome.lines]),
    );
  }
  console.log(lines.join("\n"));
  if (failed) process.exitCode = 1;
}

/** Unloads and deletes the LaunchAgents of the project. Nothing installed is not an error. */
export function servicesUninstall(inProject: string | undefined): void {
  const project = resolveProject(inProject);
  const removed = services.filter((service) => removeAgent(label(project, service.name)));
  console.log(
    removed.length === 0
      ? `No services of project ${project} are installed. Nothing changed.`
      : removed.map((service) => `Removed LaunchAgent ${label(project, service.name)}`).join("\n"),
  );
}

/** One line for each service: `not installed`, `loaded` or `running` with the pid, and the last log line. */
export function servicesStatusText(project: string): string {
  return services
    .map((service) => {
      const listed = launchctl("list", label(project, service.name));
      const name = service.name.padEnd(14);
      if (!listed.ok || !existsSync(plistPath(label(project, service.name))))
        return `${name}not installed`;
      const pid = listed.output.match(/"PID"\s*=\s*(\d+)/)?.[1];
      const log = logPath(project, service.name);
      const last = existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter((line) => line.trim() !== "")
            .at(-1)
        : undefined;
      return `${name}${pid ? "running".padEnd(10) : "loaded".padEnd(10)}${pid ? `pid ${pid}` : "pid -"}   last log: ${last ?? "none"}`;
    })
    .join("\n");
}

export function servicesStatus(inProject: string | undefined): void {
  console.log(servicesStatusText(resolveProject(inProject)));
}
