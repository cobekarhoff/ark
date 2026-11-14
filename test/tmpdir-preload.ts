import { afterAll, setDefaultTimeout } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeOwnerFile } from "../cli/owner-file.ts";

// ARK-292: default for the first file only; bun resets it per file, so each test file also calls setDefaultTimeout(30_000).
setDefaultTimeout(30_000);

// One root per bun test process. os.tmpdir() and child processes use it.
// afterAll, not process "exit": exit hooks do not fire in a bun test preload.
// A killed process (SIGKILL, crash) skips afterAll and leaves its root.
const tempRoot = writeOwnerFile(mkdtempSync(join(realpathSync(tmpdir()), "bun-test-")));
process.env.TMPDIR = tempRoot;

// ARK-390: a real orca, gh, glab, omp, plannotator, launchctl or portless must never run in a test.
// The shims come first on PATH; a test's own fake (writeFakeCommand) goes in front of them and wins.
const shimDirectory = join(tempRoot, "refusing-shims");
mkdirSync(shimDirectory);
for (const tool of ["orca", "gh", "glab", "omp", "plannotator", "launchctl", "portless"]) {
  const file = join(shimDirectory, tool);
  writeFileSync(
    file,
    `#!/bin/sh\necho "bun test refuses the real ${tool}: install a fake first" >&2\nexit 127\n`,
  );
  chmodSync(file, 0o755);
}
process.env.PATH = `${shimDirectory}:${process.env.PATH}`;

// ARK-380: `ark merge-request open` and `ark run close <run> handed_off` refuse without gitleaks and osv-scanner, and a
// real scan must never run in a test. Clean fakes come first on PATH; a test's own fake goes in front of them and wins.
const cleanScanners: Record<string, string> = {
  gitleaks:
    '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = --report-path ] && echo "[]" > "$2"; shift; done\nexit 0\n',
  "osv-scanner": "#!/bin/sh\necho '{\"results\":[]}'\nexit 0\n",
};
for (const [tool, script] of Object.entries(cleanScanners)) {
  writeFileSync(join(shimDirectory, tool), script);
  chmodSync(join(shimDirectory, tool), 0o755);
}

// ARK-423: background `git maintenance` and `gc --auto` race the template copy and the tests' own commits.
// Every git process of a test inherits these through process.env.
Object.assign(process.env, {
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
});

// Removing the root after a full run can outlast bun's 5s default hook timeout.
const cleanupTimeoutMilliseconds = 60_000;

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
}, cleanupTimeoutMilliseconds);

// Bun resolves a bare command of a spawn with no `env` against the PATH of process start, so the shims and a test's own
// fake would be skipped. Default `env` to the live process.env.
for (const name of ["spawn", "spawnSync"] as const) {
  const original = Bun[name] as (...args: unknown[]) => unknown;
  (Bun as Record<string, unknown>)[name] = (first: unknown, second?: Record<string, unknown>) => {
    if (Array.isArray(first)) return original(first, { env: process.env, ...second });
    return original({ env: process.env, ...(first as Record<string, unknown>) });
  };
}

// ARK-417: `ark test` waits while memory is short, so a suite a test starts would wait on the runner's real memory.
// A healthy host (50 percent free, 2 GB swap) is faked once here, at the boundary the reader parses: macOS
// `memory_pressure` and `sysctl vm.swapusage`. The files live in /tmp, never in the caller TMPDIR, which
// ARK-T153 and ARK-235-AC2 check for new entries, and a test rewrites them with setFakeHost() in test/helpers.ts. Linux reads /proc/meminfo, which no
// PATH fake reaches, so there a test that starts a suite reads the real host.
const hostRoot = mkdtempSync("/tmp/ark-fake-host-");
const hostBin = join(hostRoot, "bin");
mkdirSync(hostBin);
const realSysctl = Bun.which("sysctl") ?? "/usr/sbin/sysctl";
writeFileSync(
  join(hostBin, "memory_pressure"),
  '#!/bin/sh\ncat "$ARK_FAKE_HOST/memory_pressure" 2>/dev/null\n',
);
writeFileSync(
  join(hostBin, "sysctl"),
  `#!/bin/sh\nif [ "$1" = vm.swapusage ]; then cat "$ARK_FAKE_HOST/swapusage" 2>/dev/null; status=$?; echo >> "$ARK_FAKE_HOST/reads"; exit $status; fi\nexec ${realSysctl} "$@"\n`,
);
chmodSync(join(hostBin, "memory_pressure"), 0o755);
chmodSync(join(hostBin, "sysctl"), 0o755);
writeFileSync(join(hostRoot, "memory_pressure"), "System-wide memory free percentage: 50%\n");
writeFileSync(
  join(hostRoot, "swapusage"),
  "vm.swapusage: total = 4096.00M  used = 2048.00M  free = 2048.00M  (encrypted)\n",
);
process.env.ARK_FAKE_HOST = hostRoot;
process.env.PATH = `${hostBin}:${process.env.PATH}`;
afterAll(() => {
  rmSync(hostRoot, { recursive: true, force: true });
});
