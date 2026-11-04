/** The hub's stable name: one or more lowercase labels (1 to 63 of `[a-z0-9-]`, no edge `-`), then `localhost`. */
export const hubNamePattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+localhost$/;

export const isHubName = (name: string): boolean => hubNamePattern.test(name);

/** The port the name proxy listens on. */
export const proxyPort = 80;

/** The name the main hub answers to. */
export const mainHubName = "ark.localhost";

/** Absolute path of portless (`ARK_PORTLESS`, else `portless` on PATH), or null when it is not found. */
export const portlessProgram = (): string | null =>
  Bun.which(process.env.ARK_PORTLESS || "portless");

/**
 * Arguments of the proxy LaunchAgent.
 *
 * `portless proxy start` daemonizes the proxy and exits 0 at once, also when a proxy runs already.
 * So the agent has RunAtLoad true and KeepAlive false: with KeepAlive true, launchd would see the
 * exit as a crash and respawn it every 10 s. Cost: a proxy that dies later is not restarted
 * (run `ark ui install` again). `--foreground` would allow KeepAlive, but the form is fixed by ARK-300.
 */
export const proxyStartArguments = (portless: string): string[] => [
  portless,
  "proxy",
  "start",
  "--unprivileged",
];

/** Arguments of the hub LaunchAgent when portless routes `ark.localhost` to the hub's port. */
export const wrappedHubArguments = (
  portless: string,
  port: number,
  hubArguments: string[],
): string[] => [portless, "ark", "--app-port", `${port}`, ...hubArguments, "--name", mainHubName];
