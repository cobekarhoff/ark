import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");

function runArkWithEnvironment(environment: Record<string, string>, ...arguments_: string[]) {
  return Bun.spawnSync([process.execPath, join(repositoryRoot, "cli", "ark.ts"), ...arguments_], {
    env: { ...process.env, ...environment },
  });
}

function writeCommand(directory: string, name: string, contents: string): string {
  const command = join(directory, name);
  writeFileSync(command, `#!/bin/sh\n${contents}\n`);
  chmodSync(command, 0o755);
  return command;
}

test("ARK-178-AC1 install writes a restarting LaunchAgent and loads it", () => {
  const temporaryHome = mkdtempSync(join(tmpdir(), "ark-install-home-"));
  const arkHomeDirectory = mkdtempSync(join(tmpdir(), "ark-install-state-"));
  const commandDirectory = mkdtempSync(join(tmpdir(), "ark-install-bin-"));
  const launchLog = join(commandDirectory, "launchctl.log");
  writeCommand(commandDirectory, "launchctl", `printf '%s\\n' "$*" >> "${launchLog}"`);

  const result = runArkWithEnvironment(
    {
      HOME: temporaryHome,
      ARK_HOME: arkHomeDirectory,
      ARK_LAUNCHCTL: join(commandDirectory, "launchctl"),
      PATH: commandDirectory,
    },
    "ui",
    "install",
  );
  const plist = join(temporaryHome, "Library", "LaunchAgents", "dev.ark.hub.plist");
  const contents = readFileSync(plist, "utf8");
  expect(result.exitCode).toBe(0);
  expect(contents).toContain("<key>RunAtLoad</key><true/>");
  expect(contents).toContain("<key>KeepAlive</key><true/>");
  expect(contents).toContain(`<string>${join(repositoryRoot, "cli", "ark.ts")}</string>`);
  expect(contents).toContain(`<string>${process.execPath}</string>`);
  expect(contents).toContain("<string>ui</string>");
  expect(readFileSync(launchLog, "utf8").trim()).toBe(`load -w ${plist}`);
});

test("ARK-178-AC1 repeating install leaves the LaunchAgent unchanged", () => {
  const temporaryHome = mkdtempSync(join(tmpdir(), "ark-install-home-"));
  const arkHomeDirectory = mkdtempSync(join(tmpdir(), "ark-install-state-"));
  const commandDirectory = mkdtempSync(join(tmpdir(), "ark-install-bin-"));
  const launchLog = join(commandDirectory, "launchctl.log");
  const launchctlCommand = writeCommand(
    commandDirectory,
    "launchctl",
    `printf '%s\\n' "$*" >> "${launchLog}"`,
  );
  const environment = {
    HOME: temporaryHome,
    ARK_HOME: arkHomeDirectory,
    ARK_LAUNCHCTL: launchctlCommand,
    PATH: commandDirectory,
  };

  const firstResult = runArkWithEnvironment(environment, "ui", "install");
  const plist = join(temporaryHome, "Library", "LaunchAgents", "dev.ark.hub.plist");
  const firstContents = readFileSync(plist, "utf8");
  const secondResult = runArkWithEnvironment(environment, "ui", "install");

  expect(firstResult.exitCode).toBe(0);
  expect(secondResult.exitCode).toBe(0);
  expect(readFileSync(plist, "utf8")).toBe(firstContents);
  expect(readFileSync(launchLog, "utf8").trim().split("\n")).toEqual([`load -w ${plist}`]);
});

for (const recoverySucceeds of [true, false]) {
  test(`ARK-213-AC1 failed update restores the previous plist when recovery ${recoverySucceeds ? "succeeds" : "fails"}`, () => {
    const temporaryHome = mkdtempSync(join(tmpdir(), "ark-install-home-"));
    const arkHomeDirectory = mkdtempSync(join(tmpdir(), "ark-install-state-"));
    const commandDirectory = mkdtempSync(join(tmpdir(), "ark-install-bin-"));
    const launchctlCommand = writeCommand(commandDirectory, "launchctl", "exit 0");
    const environment = {
      HOME: temporaryHome,
      ARK_HOME: arkHomeDirectory,
      ARK_LAUNCHCTL: launchctlCommand,
      PATH: commandDirectory,
    };
    const installed = runArkWithEnvironment(environment, "ui", "install", "--port", "4317");
    expect(installed.exitCode).toBe(0);
    const plist = join(temporaryHome, "Library", "LaunchAgents", "dev.ark.hub.plist");
    const previousContents = readFileSync(plist);
    const attemptedPlist = join(commandDirectory, "attempted.plist");
    const recoveryPlist = join(commandDirectory, "recovery.plist");
    writeCommand(
      commandDirectory,
      "launchctl",
      `if [ "$1" = "unload" ]; then exit 0; fi
if [ ! -f "${attemptedPlist}" ]; then
  /bin/cp "$3" "${attemptedPlist}" || exit 99
  echo "Update load failed: 5: Input/output error" >&2
  exit 5
fi
/bin/cp "$3" "${recoveryPlist}" || exit 99
${recoverySucceeds ? "exit 0" : 'echo "Recovery load failed: 6: Device not configured" >&2; exit 6'}`,
    );

    const result = runArkWithEnvironment(environment, "ui", "install", "--port", "4318");
    expect(result.exitCode).toBe(1);
    expect(readFileSync(attemptedPlist, "utf8")).toContain("<string>4318</string>");
    expect(readFileSync(plist)).toEqual(previousContents);
    expect(readFileSync(recoveryPlist)).toEqual(previousContents);
    const errorOutput = result.stderr.toString();
    expect(errorOutput).toContain("Update load failed: 5: Input/output error");
    if (recoverySucceeds) {
      expect(errorOutput).toContain("reloaded");
      expect(errorOutput).toContain("running with the old settings");
      expect(errorOutput).not.toContain("hub is not running");
    } else {
      expect(errorOutput).toContain("Recovery load failed: 6: Device not configured");
      expect(errorOutput).toContain("hub is not running");
      expect(errorOutput).not.toContain("running with the old settings");
    }
    expect(result.stdout.toString()).not.toContain("It is running now");
  });
}

test("ARK-178-AC1 ARK-213-AC2 failed new install removes its plist and exits 1 with the launchctl error", () => {
  const temporaryHome = mkdtempSync(join(tmpdir(), "ark-install-home-"));
  const arkHomeDirectory = mkdtempSync(join(tmpdir(), "ark-install-state-"));
  const commandDirectory = mkdtempSync(join(tmpdir(), "ark-install-bin-"));
  const launchctlCommand = writeCommand(
    commandDirectory,
    "launchctl",
    `echo "Load failed: 5: Input/output error" >&2; exit 5`,
  );

  const result = runArkWithEnvironment(
    {
      HOME: temporaryHome,
      ARK_HOME: arkHomeDirectory,
      ARK_LAUNCHCTL: launchctlCommand,
      PATH: commandDirectory,
    },
    "ui",
    "install",
  );

  expect(result.exitCode).toBe(1);
  expect(existsSync(join(temporaryHome, "Library", "LaunchAgents", "dev.ark.hub.plist"))).toBe(
    false,
  );
  expect(result.stderr.toString()).toContain("Load failed: 5: Input/output error");
  expect(result.stdout.toString()).not.toContain("It is running now");
});

test("ARK-178-AC1 uninstall removes the LaunchAgent twice", () => {
  const temporaryHome = mkdtempSync(join(tmpdir(), "ark-uninstall-home-"));
  const arkHomeDirectory = mkdtempSync(join(tmpdir(), "ark-uninstall-state-"));
  const commandDirectory = mkdtempSync(join(tmpdir(), "ark-uninstall-bin-"));
  const launchLog = join(commandDirectory, "launchctl.log");
  const launchctlCommand = writeCommand(
    commandDirectory,
    "launchctl",
    `printf '%s\\n' "$*" >> "${launchLog}"`,
  );
  const environment = {
    HOME: temporaryHome,
    ARK_HOME: arkHomeDirectory,
    ARK_LAUNCHCTL: launchctlCommand,
    PATH: commandDirectory,
  };
  const installed = runArkWithEnvironment(environment, "ui", "install");
  const plist = join(temporaryHome, "Library", "LaunchAgents", "dev.ark.hub.plist");

  const firstRemoval = runArkWithEnvironment(environment, "ui", "uninstall");
  const missingAfterFirstRemoval = !existsSync(plist);
  const secondRemoval = runArkWithEnvironment(environment, "ui", "uninstall");

  expect(installed.exitCode).toBe(0);
  expect(firstRemoval.exitCode).toBe(0);
  expect(secondRemoval.exitCode).toBe(0);
  expect(missingAfterFirstRemoval).toBe(true);
  expect(readFileSync(launchLog, "utf8").trim().split("\n")).toEqual([
    `load -w ${plist}`,
    `unload ${plist}`,
  ]);
});

function sandbox() {
  const temporaryHome = mkdtempSync(join(tmpdir(), "ark-install-home-"));
  const commandDirectory = mkdtempSync(join(tmpdir(), "ark-install-bin-"));
  const launchctl = writeCommand(commandDirectory, "launchctl", "exit 0");
  const portless = writeCommand(commandDirectory, "portless", "exit 0");
  const environment = {
    HOME: temporaryHome,
    ARK_HOME: mkdtempSync(join(tmpdir(), "ark-install-state-")),
    ARK_LAUNCHCTL: launchctl,
    ARK_PORTLESS: portless,
    PATH: commandDirectory,
  };
  const agents = join(temporaryHome, "Library", "LaunchAgents");
  return {
    environment,
    commandDirectory,
    portless,
    hub: join(agents, "dev.ark.hub.plist"),
    proxy: join(agents, "dev.ark.proxy.plist"),
  };
}

test("ARK-300 install with portless writes the proxy agent and the wrapped hub, then uninstall removes both", () => {
  const { environment, portless, hub, proxy } = sandbox();
  const result = runArkWithEnvironment(environment, "ui", "install", "--port", "4317");
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("  name:   http://ark.localhost");
  const proxyPlist = readFileSync(proxy, "utf8");
  expect(proxyPlist).toContain(
    `<string>${portless}</string>\n    <string>proxy</string>\n    <string>start</string>\n    <string>--unprivileged</string>`,
  );
  expect(proxyPlist).toContain("<key>KeepAlive</key><false/>");
  const hubPlist = readFileSync(hub, "utf8");
  expect(hubPlist).toContain(
    `<string>${portless}</string>\n    <string>ark</string>\n    <string>--app-port</string>\n    <string>4317</string>\n    <string>${process.execPath}</string>`,
  );
  expect(hubPlist).toContain("<string>--name</string>\n    <string>ark.localhost</string>");
  const again = runArkWithEnvironment(environment, "ui", "install", "--port", "4317");
  expect(again.stdout.toString()).toContain("Nothing changed");
  runArkWithEnvironment(environment, "ui", "uninstall");
  expect(existsSync(hub) || existsSync(proxy)).toBe(false);
});

test("ARK-300 without portless install keeps the plain hub, writes no proxy agent and exits 0", () => {
  const { environment, hub, proxy } = sandbox();
  const result = runArkWithEnvironment(
    { ...environment, ARK_PORTLESS: join(environment.PATH, "missing") },
    "ui",
    "install",
    "--port",
    "4400",
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain(
    "portless not found: the hub stays at http://127.0.0.1:4400",
  );
  expect(readFileSync(hub, "utf8")).not.toContain("--name");
  expect(existsSync(proxy)).toBe(false);
});

test("ARK-300 a switch from plain to wrapped form reloads, and a port change reports port a -> port b", () => {
  const { environment, hub } = sandbox();
  const missing = { ...environment, ARK_PORTLESS: join(environment.PATH, "missing") };
  runArkWithEnvironment(missing, "ui", "install", "--port", "4317");
  const switched = runArkWithEnvironment(environment, "ui", "install", "--port", "4317");
  expect(switched.stdout.toString()).toContain("Updated LaunchAgent dev.ark.hub. Reloaded.");
  expect(readFileSync(hub, "utf8")).toContain("ark.localhost");
  const moved = runArkWithEnvironment(environment, "ui", "install", "--port", "4318");
  expect(moved.stdout.toString()).toContain("(port 4317 -> 4318)");
});

test("ARK-300 a failed proxy load restores only the proxy and exits 1, the hub stays loaded", () => {
  const { environment, commandDirectory, hub, proxy } = sandbox();
  const failing = writeCommand(
    commandDirectory,
    "launchctl-fail",
    `case "$3" in *proxy.plist) echo "proxy load failed" >&2; exit 5;; esac`,
  );
  const result = runArkWithEnvironment({ ...environment, ARK_LAUNCHCTL: failing }, "ui", "install");
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("proxy load failed");
  expect(existsSync(proxy)).toBe(false);
  expect(existsSync(hub)).toBe(true);
});
