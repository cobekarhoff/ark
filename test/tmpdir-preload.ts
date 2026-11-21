import { afterAll, beforeEach, setDefaultTimeout } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { commandLines, holdTestBudget } from "../cli/bare-test-budget.ts";
import { writeOwnerFile } from "../cli/owner-file.ts";

// ARK-292: default for the first file only; bun resets it per file, so each test file also calls setDefaultTimeout(30_000).
setDefaultTimeout(30_000);

// One root per bun test process. os.tmpdir() and child processes use it.
// afterAll, not process "exit": exit hooks do not fire in a bun test preload.
// `bun test --rerun-each=N <one file>` runs the file N times in this one process, and afterAll fires after every repeat,
// so a root goes only after repeat N. The preload sees no flag in argv, so it reads its own command line once; a missing
// flag or a failed `ps` gives N = 1, today's removal after the one run. A repeat in which no test started (the file
// failed to load, so bun runs no repeat and fires afterAll once; or `-t` matched nothing) removes the root at once.
// One file in one process only: `--parallel` and several files fire afterAll on other counts.
// A killed process (SIGKILL, crash) skips afterAll and leaves its root.
const repeatCount = Number(
  /(?:^|\s)--rerun-each[=\s]+(\d+)(?:\s|$)/.exec(
    commandLines([process.pid]).get(process.pid) ?? "",
  )?.[1] ?? 1,
);
let testsStarted = 0;
beforeEach(() => {
  testsStarted += 1;
});
// ARK-610: a removal that fails never fails the bun test process. EFAULT and EBUSY (a transient race on the Linux CI
// runner) get 3 retries, 4 calls in all, with no back-off; ENOENT means the root is gone. Any other code, or a failure
// that outlasts the retries, prints one stderr line with the root and the code, leaves the root (scripts/temp-cleaner.sh
// removes it once its owner is dead) and goes on, so the exit status stays that of the tests.
// Opt-in, read here only: ARK_PRELOAD_RM_FAULTS=<N|all> makes the first N (or every) rmSync call of the bun-test-* root
// throw EFAULT; ARK_PRELOAD_RM_LOG=<file> gets one line with the root before every rmSync call of either root.
const retriedCodes = new Set(["EFAULT", "EBUSY"]);
const faultLimit =
  process.env.ARK_PRELOAD_RM_FAULTS === "all"
    ? Infinity
    : Number(process.env.ARK_PRELOAD_RM_FAULTS ?? 0);
let faultsThrown = 0;
function removeRoot(root: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (process.env.ARK_PRELOAD_RM_LOG)
        appendFileSync(process.env.ARK_PRELOAD_RM_LOG, `${root}\n`);
      if (root === tempRoot && faultsThrown < faultLimit) {
        faultsThrown += 1;
        throw Object.assign(
          new Error(`EFAULT: bad address in system call argument, rm '${root}'`),
          {
            code: "EFAULT",
          },
        );
      }
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? String(error);
      if (code === "ENOENT") return;
      if (retriedCodes.has(code) && attempt < 3) continue;
      console.error(`ark preload: could not remove ${root}: ${code}`);
      return;
    }
  }
}
function removeAfterLastRepeat(root: string): () => void {
  let repeatsDone = 0;
  let startedBefore = 0;
  return () => {
    repeatsDone += 1;
    const idle = testsStarted === startedBefore;
    startedBefore = testsStarted;
    if (idle || repeatsDone >= repeatCount) removeRoot(root);
  };
}
const tempRoot = writeOwnerFile(mkdtempSync(join(realpathSync(tmpdir()), "bun-test-")));
process.env.TMPDIR = tempRoot;

// ARK-569: a `bun test --parallel` worker whose coordinator died (SIGKILL, a test timeout, a crashed run) keeps its
// event loop, or a synchronous call, and sleeps for hours with parent pid 1. A thread of the worker (parent-watch.ts)
// compares its parent with the one it started with and kills the process within 10 s of any change. A run that
// started with parent pid 1 has no parent to lose, and a serial run is never a worker.
if (process.env.BUN_TEST_WORKER_ID !== undefined || process.argv.includes("--test-worker")) {
  if (process.ppid !== 1)
    new Worker(new URL("./parent-watch.ts", import.meta.url), { workerData: process.ppid }).unref();
}

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
// ARK-456: `git init` names its branch `main` on every host, as the Linux CI runner defaults to `master`.
// Every git process of a test inherits these through process.env.
Object.assign(process.env, {
  GIT_CONFIG_COUNT: "3",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
  GIT_CONFIG_KEY_2: "init.defaultBranch",
  GIT_CONFIG_VALUE_2: "main",
});

// Removing the root after a full run can outlast bun's 5s default hook timeout.
const cleanupTimeoutMilliseconds = 60_000;

afterAll(removeAfterLastRepeat(tempRoot), cleanupTimeoutMilliseconds);

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
afterAll(removeAfterLastRepeat(hostRoot));

// ARK-513: a whole-suite `bun test` outside `ark test` waits for the shared test budget. After the fake host above,
// so the memory admission inside the wait reads the healthy host a test of this repo expects.
await holdTestBudget();

// ARK-586: after the hold above, so a bare run reads the real host; the tests see both readings pinned.
// ARK_FAKE_CPU_PERCENT: `ark test` holds a suite on CPU use over 90 percent while another suite runs, so a suite a test
// starts would wait on the real CPU; a test that needs another value sets it itself.
// ARK_FAKE_LOAD_ONE: no hold reads the load, but `test.completed` records loadAtStart and loadPeak for display, and a test
// that asserts them (ARK-T135) needs a load that does not move with the host.
process.env.ARK_FAKE_CPU_PERCENT ??= "0";
process.env.ARK_FAKE_LOAD_ONE ??= "0";
