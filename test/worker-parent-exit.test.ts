import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { budgetHeldVariable } from "../cli/test-lock.ts";
import { isLive } from "./helpers.ts";

// ARK-569: a bun test worker whose parent exited exits by itself. Every case runs a real `bun test` in a scratch repo
// that loads the repo's own preload, where the watch lives, and kills or leaves a real parent by its pid.
setDefaultTimeout(90_000);

const preload = resolve(import.meta.dir, "tmpdir-preload.ts");
// The time the cases that run to the end observe: longer than the watch interval and the 10 s limit.
const longRunSeconds = 12;
const exitLimitMilliseconds = 10_000;

// Only processes this file started, by pid.
const started: number[] = [];
afterEach(() => {
  for (const pid of started.splice(0))
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
});

/** The environment of a `bun test` the case starts: no marker, no worker variables, no project, so the budget never waits. */
function environment(): Record<string, string> {
  const merged: Record<string, string | undefined> = { ...process.env };
  for (const name of [budgetHeldVariable, "BUN_TEST_WORKER_ID", "JEST_WORKER_ID", "ARK_PROJECT"])
    delete merged[name];
  merged.ARK_HOME = realpathSync(mkdtempSync(join(tmpdir(), "worker-exit-home-")));
  merged.ARK_FAKE_LOAD_ONE = "0";
  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined),
  ) as Record<string, string>;
}

/** A scratch repo with the repo preload and the test files `files` (name to body); `markers` is where the files write. */
function scratchRepo(files: Record<string, (markers: string) => string>) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "worker-exit-repo-")));
  const markers = realpathSync(mkdtempSync(join(tmpdir(), "worker-exit-markers-")));
  writeFileSync(join(directory, "bunfig.toml"), `[test]\npreload = [${JSON.stringify(preload)}]\n`);
  mkdirSync(join(directory, "test"));
  for (const [name, body] of Object.entries(files))
    writeFileSync(join(directory, "test", `${name}.test.ts`), body(markers));
  return { directory, markers };
}

const imports = `import { test } from "bun:test";
import { openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
`;

/**
 * A file that opens the write end of the pipe `alive-<name>` (a `cat` of the case reads it and ends with the worker),
 * records `<pid> <ppid>`, and then blocks the whole worker thread in a synchronous read of the pipe `gate-<name>`,
 * which the case holds open and never writes to. A worker that is blocked like this runs no timer of its main thread,
 * as the workers of the ARK-515 runs were.
 */
const holdFile = (name: string) => (markers: string) =>
  `import { test } from "bun:test";
import { openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
test("FAKE-1-AC1 ${name}", () => {
  openSync(join(${JSON.stringify(markers)}, "alive-${name}"), "w");
  writeFileSync(join(${JSON.stringify(markers)}, "pids-${name}"), process.pid + " " + process.ppid + "\\n");
  readFileSync(join(${JSON.stringify(markers)}, "gate-${name}"));
}, 120_000);
`;

/**
 * A file that runs `longRunSeconds`, one tick file each second, writes `finished-<name>` and passes. The one real
 * delay of this file: the cases observe the parent watch against the wall clock, which fake timers cannot drive.
 */
const longFile = (name: string) => (markers: string) =>
  `${imports}test("FAKE-1-AC1 ${name}", async () => {
  writeFileSync(join(${JSON.stringify(markers)}, "pid-${name}"), process.pid + " " + process.ppid + "\\n");
  const { promise, resolve } = Promise.withResolvers();
  let tick = 0;
  const timer = setInterval(() => {
    writeFileSync(join(${JSON.stringify(markers)}, "tick-${name}-" + tick), "");
    if (++tick === ${longRunSeconds}) {
      clearInterval(timer);
      resolve();
    }
  }, 1000);
  await promise;
  writeFileSync(join(${JSON.stringify(markers)}, "finished-${name}"), "");
}, 60_000);
`;

/** Resolves when `ready()` holds, re-checked on every change of `directory`; rejects with the name after `within` ms. */
function waitFor(
  directory: string,
  ready: () => boolean,
  name: string,
  within: number,
): Promise<void> {
  const { promise, resolve: done, reject } = Promise.withResolvers<void>();
  const check = () => {
    if (ready()) done();
  };
  const watcher = watch(directory, check);
  AbortSignal.timeout(within).addEventListener("abort", () =>
    reject(new Error(`no ${name} within ${within} ms`)),
  );
  check();
  return promise.finally(() => watcher.close());
}

/** A pid line is complete when it ends in a newline: `writeFileSync` creates the file before it writes. */
const lineOf = (markers: string, name: string): string[] | null => {
  const file = join(markers, name);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  return text.endsWith("\n") ? text.trim().split(" ") : null;
};

test("ARK-T708 the workers of a bun test --parallel run whose coordinator was killed exit by themselves within 10 s", async () => {
  const { directory, markers } = scratchRepo({ "hold-1": holdFile("1"), "hold-2": holdFile("2") });
  // A `cat` reads each worker's pipe and ends when the worker ends: the event that reports the end of a process that is
  // not our child once its coordinator is gone.
  const ended = ["1", "2"].map((name) => {
    const pipe = join(markers, `alive-${name}`);
    Bun.spawnSync(["mkfifo", pipe]);
    const reader = Bun.spawn(["cat", pipe], { stdout: "ignore" });
    started.push(reader.pid);
    return reader.exited;
  });
  // The case holds the write end of each `gate-<name>` pipe open and never writes: the worker blocks in its read of it
  // until the case ends the holder. `sleep` inherits the descriptor from the shell that opened it.
  for (const name of ["1", "2"]) {
    const gate = join(markers, `gate-${name}`);
    Bun.spawnSync(["mkfifo", gate]);
    const holder = Bun.spawn(["sh", "-c", 'exec 3>"$0"; exec sleep 600', gate], {
      stdout: "ignore",
    });
    started.push(holder.pid);
  }
  const coordinator = Bun.spawn([process.execPath, "test", "--parallel=2"], {
    cwd: directory,
    env: environment(),
    stdout: "ignore",
    stderr: "ignore",
  });
  started.push(coordinator.pid);
  await waitFor(
    markers,
    () => lineOf(markers, "pids-1") !== null && lineOf(markers, "pids-2") !== null,
    "pid files of both workers",
    30_000,
  );
  const workers = ["pids-1", "pids-2"].map((name) => lineOf(markers, name)!.map(Number));
  started.push(...workers.map(([pid]) => pid!));
  for (const [pid, parent] of workers) {
    expect(parent, `parent of worker ${pid}`).toBe(coordinator.pid);
    expect(isLive(pid!)).toBe(true);
  }

  coordinator.kill("SIGKILL");
  await coordinator.exited;
  const deadline = Promise.withResolvers<never>();
  AbortSignal.timeout(exitLimitMilliseconds).addEventListener("abort", () => {
    // What a worker left behind looks like: still alive, with the parent of an orphan.
    const left = workers
      .filter(([pid]) => isLive(pid!))
      .map(([pid]) => {
        const parent = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)]).stdout.toString();
        return `${pid} (parent pid ${parent.trim()})`;
      });
    deadline.reject(
      new Error(
        `workers ${left.join(", ")} still alive ${exitLimitMilliseconds} ms after the kill of their coordinator ${coordinator.pid}`,
      ),
    );
  });
  await Promise.race([Promise.all(ended), deadline.promise]);
});

test("ARK-T708 a bun test --parallel run with a live coordinator keeps its workers running to the end of their files", async () => {
  const { directory, markers } = scratchRepo({ "long-1": longFile("1"), "long-2": longFile("2") });
  const run = Bun.spawn([process.execPath, "test", "--parallel=2"], {
    cwd: directory,
    env: environment(),
    stdout: "pipe",
    stderr: "pipe",
  });
  started.push(run.pid);
  const output = Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()]);
  const code = await run.exited;
  expect(code, (await output).join("\n")).toBe(0);
  const files = readdirSync(markers);
  for (const name of ["1", "2"]) {
    expect(files.filter((file) => file.startsWith(`tick-${name}-`))).toHaveLength(longRunSeconds);
    expect(files).toContain(`finished-${name}`);
  }
});

test("ARK-T708 a serial bun test run that the host started with parent pid 1 keeps running to the end of its file", async () => {
  const { directory, markers } = scratchRepo({ "long-1": longFile("1") });
  // A double fork: the subshell waits until the outer shell has gone, then replaces itself with bun, so bun starts without its parent (pid 1, or a subreaper on a Linux runner).
  const forked = Bun.spawn(
    [
      "sh",
      "-c",
      `( while kill -0 $$ 2>/dev/null; do :; done; exec "$0" test test/long-1.test.ts > "$1/output" 2>&1 ) &`,
      process.execPath,
      markers,
    ],
    { cwd: directory, env: environment(), stdout: "ignore", stderr: "ignore" },
  );
  await forked.exited;
  await waitFor(
    markers,
    () => lineOf(markers, "pid-1") !== null,
    "start of the serial run",
    30_000,
  );
  const [pid, parent] = lineOf(markers, "pid-1")!.map(Number);
  started.push(pid);
  // The run read its own parent. The outer shell has exited by then, so the run lost it: on macOS and in a container
  // the new parent is pid 1, on a Linux runner it is the nearest subreaper. Only the loss is asserted, never "1".
  expect(parent, "the serial run still has the outer shell as its parent").not.toBe(forked.pid);

  await waitFor(
    markers,
    () => existsSync(join(markers, "finished-1")),
    "end of the serial run (it was stopped early)",
    longRunSeconds * 1000 + 20_000,
  );
  expect(readdirSync(markers).filter((file) => file.startsWith("tick-1-"))).toHaveLength(
    longRunSeconds,
  );
});
