import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempArkHome, tempGitRepo, writeProject } from "./helpers";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(60_000);

const repositoryRoot = join(import.meta.dir, "..");
const serviceNames = ["auto-merger", "temp-cleaner", "sweep"];

let home = "";
let arkHomeDirectory = "";
let commandDirectory = "";
let launchLog = "";
let agents = "";

const workspace = tempGitRepo();
const config = (mergeRequests: "open" | "none") => ({
  workspace,
  ticket_source: "local",
  merge_requests: mergeRequests,
  suites: [{ name: "unit", level: "unit", repo: ".", command: "true {report}", parser: "bun" }],
  roles: {
    implementer: { harness: "claude", model: "claude-sonnet" },
    validator: { harness: "codex", model: "gpt-codex" },
    reviewer: { harness: "codex", model: "gpt-codex" },
  },
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ark-services-home-"));
  arkHomeDirectory = tempArkHome();
  commandDirectory = mkdtempSync(join(tmpdir(), "ark-services-bin-"));
  launchLog = join(commandDirectory, "launchctl.log");
  agents = join(home, "Library", "LaunchAgents");
  mkdirSync(join(commandDirectory, "loaded"));
  // Fake launchctl. `load` of a loaded label fails like the real one; `list <label>` prints the real dict
  // (exit 113 for an unknown label; a "PID" line only when loaded/<label> holds a pid).
  const fake = join(commandDirectory, "launchctl");
  writeFileSync(
    fake,
    `#!/bin/sh
d="${commandDirectory}"
echo "$*" >> "${launchLog}"
case "$1" in
  load) label=$(basename "$3" .plist)
    [ -e "$d/failload" ] && { echo "Load failed: 5" >&2; exit 1; }
    [ -e "$d/loaded/$label" ] && { echo "$label: service already loaded" >&2; exit 1; }
    : > "$d/loaded/$label" ;;
  unload) [ -e "$d/failunload" ] && { echo "Unload failed: 5" >&2; exit 1; }
    rm -f "$d/loaded/$(basename "$2" .plist)" ;;
  list) [ -e "$d/faillist" ] && { echo "launchctl unavailable" >&2; exit 1; }
    [ -e "$d/loaded/$2" ] || { echo "Could not find service \\"$2\\" in domain" >&2; exit 113; }
    printf '{\\n\\t"Label" = "%s";\\n' "$2"
    pid=$(cat "$d/loaded/$2")
    [ -n "$pid" ] && printf '\\t"PID" = %s;\\n' "$pid"
    printf '\\t"LastExitStatus" = 0;\\n};\\n' ;;
esac
exit 0
`,
  );
  chmodSync(fake, 0o755);
});

function arkServices(
  environment: Record<string, string>,
  ...arguments_: string[]
): { code: number; out: string; err: string } {
  const result = Bun.spawnSync(
    [process.execPath, join(repositoryRoot, "cli", "ark.ts"), ...arguments_],
    {
      env: {
        ...process.env,
        HOME: home,
        ARK_HOME: arkHomeDirectory,
        ARK_LAUNCHCTL: join(commandDirectory, "launchctl"),
        PATH: `${commandDirectory}:/usr/bin:/bin`,
        ...environment,
      },
    },
  );
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

const plist = (project: string, service: string) =>
  join(agents, `dev.ark.${project}.${service}.plist`);
const installed = () =>
  existsSync(agents)
    ? readdirSync(agents)
        .filter((file) => file.startsWith("dev.ark."))
        .sort()
    : [];
const launchCalls = () =>
  existsSync(launchLog) ? readFileSync(launchLog, "utf8").trim().split("\n") : [];
const setLoaded = (project: string, service: string, pid: string | null) => {
  const label = join(commandDirectory, "loaded", `dev.ark.${project}.${service}`);
  if (pid === null) Bun.spawnSync(["rm", "-f", label]);
  else writeFileSync(label, pid);
};

test("ARK-T294 ark services install writes and loads one LaunchAgent per service, a second install leaves one copy, uninstall removes them", () => {
  writeProject("ark", config("open"));
  writeProject("other", config("open"));
  // The hub and proxy agents are not touched by any services command.
  mkdirSync(agents, { recursive: true });
  for (const name of ["hub", "proxy"])
    writeFileSync(join(agents, `dev.ark.${name}.plist`), `old ${name}`);

  // 1. One plist for each service with the keys that keep it running.
  const first = arkServices({}, "services", "install", "--project", "ark");
  expect(first.code, first.err).toBe(0);
  expect(installed()).toEqual([
    "dev.ark.ark.auto-merger.plist",
    "dev.ark.ark.sweep.plist",
    "dev.ark.ark.temp-cleaner.plist",
    "dev.ark.hub.plist",
    "dev.ark.proxy.plist",
  ]);
  for (const service of serviceNames) {
    const contents = readFileSync(plist("ark", service), "utf8");
    expect(contents).toContain(`<key>Label</key><string>dev.ark.ark.${service}</string>`);
    expect(contents).toContain("<key>RunAtLoad</key><true/>");
    // True, not SuccessfulExit false: a loop that exits 0 is restarted too.
    expect(contents).toContain("<key>KeepAlive</key><true/>");
    expect(contents).not.toContain("SuccessfulExit");
    expect(contents).toContain("<key>ARK_PROJECT</key><string>ark</string>");
    expect(contents).toContain(
      `<string>${join(repositoryRoot, "scripts", `${service}.sh`)}</string>`,
    );
    const log = join(arkHomeDirectory, "projects", "ark", "services", `${service}.log`);
    expect(contents).toContain(`<key>StandardOutPath</key><string>${log}</string>`);
    expect(contents).toContain(`<key>StandardErrorPath</key><string>${log}</string>`);
  }
  expect(launchCalls().filter((call) => call.startsWith("load"))).toHaveLength(3);

  // 2. Same plists: nothing is loaded again.
  const callsAfterFirst = launchCalls();
  const second = arkServices({}, "services", "install", "--project", "ark");
  expect(second.code, second.err).toBe(0);
  expect(launchCalls()).toEqual(callsAfterFirst);
  expect(installed()).toHaveLength(5);

  // 3. A different PATH changes the plists: unload then load for each, still one copy.
  const third = arkServices(
    { PATH: `${commandDirectory}:/usr/bin:/bin:/usr/sbin` },
    "services",
    "install",
    "--project",
    "ark",
  );
  expect(third.code, third.err).toBe(0);
  const updated = launchCalls().slice(callsAfterFirst.length);
  for (const service of serviceNames) {
    const path = plist("ark", service);
    expect(updated.indexOf(`unload ${path}`)).toBeGreaterThanOrEqual(0);
    expect(updated.indexOf(`load -w ${path}`)).toBeGreaterThan(updated.indexOf(`unload ${path}`));
    expect(readFileSync(path, "utf8")).toContain("/usr/sbin");
  }
  expect(installed()).toHaveLength(5);

  // 4. Another project gets its own labels and leaves the first alone.
  const arkPlist = readFileSync(plist("ark", "sweep"), "utf8");
  expect(arkServices({}, "services", "install", "--project", "other").code).toBe(0);
  expect(installed()).toHaveLength(8);
  expect(readFileSync(plist("other", "sweep"), "utf8")).toContain(
    "<key>ARK_PROJECT</key><string>other</string>",
  );
  expect(readFileSync(plist("ark", "sweep"), "utf8")).toBe(arkPlist);

  // 5. Uninstall unloads and deletes the three of ark only.
  const before = launchCalls().length;
  const removed = arkServices({}, "services", "uninstall", "--project", "ark");
  expect(removed.code, removed.err).toBe(0);
  const unloads = launchCalls().slice(before);
  for (const service of serviceNames) expect(unloads).toContain(`unload ${plist("ark", service)}`);
  expect(installed().filter((file) => file.startsWith("dev.ark.ark."))).toEqual([]);
  expect(installed().filter((file) => file.startsWith("dev.ark.other."))).toHaveLength(3);

  // 6. Nothing left to remove is not an error.
  expect(arkServices({}, "services", "uninstall", "--project", "ark").code).toBe(0);

  // 7. Hub and proxy untouched.
  for (const name of ["hub", "proxy"])
    expect(readFileSync(join(agents, `dev.ark.${name}.plist`), "utf8")).toBe(`old ${name}`);
});

test("ARK-T294 ark services install exits 1 and leaves no plist when launchctl load fails", () => {
  writeProject("ark", config("open"));
  writeFileSync(join(commandDirectory, "failload"), "");

  const result = arkServices({}, "services", "install", "--project", "ark");

  expect(result.code).toBe(1);
  expect(result.err).toContain("launchctl load failed");
  expect(installed()).toEqual([]);
});

test("ARK-T294 ark services uninstall keeps the plist and exits 1 when launchctl unload fails and the service is still loaded", () => {
  writeProject("ark", config("open"));
  expect(arkServices({}, "services", "install", "--project", "ark").code).toBe(0);
  writeFileSync(join(commandDirectory, "failunload"), "");

  const result = arkServices({}, "services", "uninstall", "--project", "ark");

  expect(result.code).toBe(1);
  expect(result.err).toContain("still loaded");
  expect(result.out).not.toContain("Removed LaunchAgent");
  expect(installed()).toHaveLength(3);

  // Once the unload works, a retry still finds the plists.
  Bun.spawnSync(["rm", join(commandDirectory, "failunload")]);
  const retry = arkServices({}, "services", "uninstall", "--project", "ark");
  expect(retry.code, retry.err).toBe(0);
  expect(installed()).toEqual([]);
});

test("ARK-T294 ark services uninstall keeps the plist and exits 1 when launchctl unload and launchctl list both fail", () => {
  writeProject("ark", config("open"));
  expect(arkServices({}, "services", "install", "--project", "ark").code).toBe(0);
  writeFileSync(join(commandDirectory, "failunload"), "");
  writeFileSync(join(commandDirectory, "faillist"), "");

  const result = arkServices({}, "services", "uninstall", "--project", "ark");

  expect(result.code).toBe(1);
  expect(result.err).toContain("did not say it is unloaded");
  expect(installed()).toHaveLength(3);
});

test("ARK-T298 ark services install keeps a loaded auto-merger and exits 1 when its unload fails after the project changed to none", () => {
  writeProject("ark", config("open"));
  expect(arkServices({}, "services", "install", "--project", "ark").code).toBe(0);
  writeProject("ark", config("none"));
  writeFileSync(join(commandDirectory, "failunload"), "");

  const result = arkServices({}, "services", "install", "--project", "ark");

  expect(result.code).toBe(1);
  expect(result.err).toContain("still loaded");
  expect(result.out).not.toContain("Removed LaunchAgent");
  expect(existsSync(plist("ark", "auto-merger"))).toBe(true);
});

test("ARK-T297 ark services status shows each service as not installed, loaded or running with pid and last log line", () => {
  writeProject("ark", config("open"));
  const status = () => arkServices({}, "services", "status", "--project", "ark");
  const line = (output: string, service: string) =>
    output.split("\n").find((row) => row.startsWith(service))!;

  // 1. Nothing installed: all three, exit 0.
  const none = status();
  expect(none.code, none.err).toBe(0);
  for (const service of serviceNames) {
    expect(line(none.out, service)).toMatch(/^\S+\s+not installed$/);
  }

  // 2-3. Installed (all loaded): auto-merger loaded, cleaner running with a log, sweep gone from launchd.
  expect(arkServices({}, "services", "install", "--project", "ark").code).toBe(0);
  setLoaded("ark", "temp-cleaner", "4242");
  setLoaded("ark", "sweep", null);
  const logs = join(arkHomeDirectory, "projects", "ark", "services");
  writeFileSync(join(logs, "temp-cleaner.log"), "first\nsecond\nlast line\n\n");
  const mixed = status();
  expect(mixed.code, mixed.err).toBe(0);
  expect(line(mixed.out, "auto-merger")).toMatch(/^auto-merger\s+loaded\s+pid -\s+last log: none$/);
  expect(line(mixed.out, "temp-cleaner")).toMatch(
    /^temp-cleaner\s+running\s+pid 4242\s+last log: last line$/,
  );
  expect(line(mixed.out, "sweep")).toMatch(/^sweep\s+not installed$/);

  // 4. Running with pid 777 and the last non-empty log line.
  setLoaded("ark", "sweep", "777");
  writeFileSync(join(logs, "sweep.log"), "closed 2\n\n");
  expect(line(status().out, "sweep")).toMatch(/^sweep\s+running\s+pid 777\s+last log: closed 2$/);
});

test("ARK-T298 ark services install installs no auto-merger for merge_requests none and removes one left from an earlier setting", () => {
  writeProject("nomr", config("none"));
  writeProject("ark", config("open"));

  // 1-2. A none project: the cleaner and the sweep only; status calls the auto-merger not installed.
  const none = arkServices({}, "services", "install", "--project", "nomr");
  expect(none.code, none.err).toBe(0);
  expect(installed()).toEqual(["dev.ark.nomr.sweep.plist", "dev.ark.nomr.temp-cleaner.plist"]);
  expect(launchCalls().join("\n")).not.toContain("auto-merger");
  const status = arkServices({}, "services", "status", "--project", "nomr");
  expect(status.code, status.err).toBe(0);
  expect(status.out).toMatch(/^auto-merger\s+not installed$/m);
  expect(status.out).toMatch(/^temp-cleaner\s+loaded/m);
  expect(status.out).toMatch(/^sweep\s+loaded/m);

  // 3. Control: an open project gets all three.
  expect(arkServices({}, "services", "install", "--project", "ark").code).toBe(0);
  expect(installed().filter((file) => file.startsWith("dev.ark.ark."))).toHaveLength(3);

  // 4. The project changes to none: its auto-merger is unloaded and deleted, the rest stays.
  writeProject("ark", config("none"));
  const calls = launchCalls().length;
  const changed = arkServices({}, "services", "install", "--project", "ark");
  expect(changed.code, changed.err).toBe(0);
  expect(launchCalls().slice(calls)).toEqual([`unload ${plist("ark", "auto-merger")}`]);
  expect(installed().filter((file) => file.startsWith("dev.ark.ark."))).toEqual([
    "dev.ark.ark.sweep.plist",
    "dev.ark.ark.temp-cleaner.plist",
  ]);

  // 5. Uninstall of a project that never had an auto-merger is not an error.
  expect(arkServices({}, "services", "uninstall", "--project", "nomr").code).toBe(0);
});
