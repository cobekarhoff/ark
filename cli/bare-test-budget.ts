import { closeSync, openSync, realpathSync, statSync, writeSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { loadConfig, type ProjectConfig } from "./config.ts";
import { isInside, listProjects, projectDirectory } from "./paths.ts";
import { budgetHeldVariable, openTestBudget, runHoldsCores } from "./test-lock.ts";

/** The label of the ticket of a bare `bun test`, read by `ark chief state` and the hub. */
const ticketLabel = "bun test";

/** `pid` to command line, from one `ps` call. A failing or missing `ps` gives an empty map. */
function commandLines(pids: number[]): Map<number, string> {
  const lines = new Map<number, string>();
  try {
    const output = Bun.spawnSync(["ps", "-o", "pid=,command=", "-p", pids.join(",")], {
      stderr: "ignore",
    }).stdout.toString();
    for (const line of output.split("\n")) {
      const [, pid, command] = /^\s*(\d+)\s+(.*)$/.exec(line) ?? [];
      if (pid !== undefined && command !== undefined) lines.set(Number(pid), command);
    }
  } catch {
    // no ps: the run goes on with no wait
  }
  return lines;
}

/**
 * The cores a `bun test` command line asks for when it runs a whole suite (no positional argument, or only
 * directories: `bun test test --parallel=3`); null for a single-file run, a filter, or any other command.
 * ponytail: an option value in a separate token (`--timeout 5000`) reads as a positional, so that run never waits;
 * upgrade: a list of the options of `bun test` that take a value.
 */
function coresOfWholeSuite(commandLine: string): number | null {
  const [, subcommand, ...tokens] = commandLine.trim().split(/\s+/);
  if (subcommand !== "test") return null;
  const isDirectory = (path: string) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  };
  if (!tokens.filter((token) => !token.startsWith("-")).every(isDirectory)) return null;
  const parallel = tokens.find(
    (token) => token === "--parallel" || token.startsWith("--parallel="),
  );
  if (parallel === undefined) return 1;
  if (parallel === "--parallel") return availableParallelism();
  const cores = Number(parallel.slice("--parallel=".length));
  return Number.isInteger(cores) ? cores : 1;
}

/** The project named by `ARK_PROJECT`, else the one whose run folder or `workspace` holds `folder`. */
function projectOfFolder(folder: string): ProjectConfig | null {
  if (process.env.ARK_PROJECT) return loadConfig(process.env.ARK_PROJECT);
  for (const project of listProjects()) {
    try {
      if (isInside(folder, join(realpathSync(projectDirectory(project)), "runs")))
        return loadConfig(project);
      const config = loadConfig(project);
      if (isInside(folder, realpathSync(config.workspace))) return config;
    } catch {
      // the ark.yml of another project must not stop this run
    }
  }
  return null;
}

/** A person at a terminal sees the line live; a --parallel worker's own output waits until its file ends. */
function showLine(line: string, inWorker: boolean): void {
  if (inWorker) {
    try {
      const terminal = openSync("/dev/tty", "w");
      try {
        writeSync(terminal, `${line}\n`);
        return;
      } finally {
        closeSync(terminal);
      }
    } catch {
      // no terminal: the line goes to the output of the worker
    }
  }
  process.stderr.write(`${line}\n`);
}

/**
 * Called by the `bun test` preload. A whole-suite `bun test` started outside `ark test` takes its cores from the
 * test budget of its project and starts its files when they are free. One ticket for each `bun test`, owned by
 * its coordinator: the preload runs again in every --parallel worker for every file, and those runs find the
 * ticket and wait for it. A run under `ark test` or under a held bare run (its marker names a live run with a
 * started ticket), a single-file run, and a host with no project, no readable `ark.yml` or no `ps` start at once:
 * this hook never refuses a run. A whole-suite run that a single-file run starts holds no cores and waits.
 */
export async function holdTestBudget(): Promise<void> {
  if (runHoldsCores(process.env[budgetHeldVariable])) return;
  try {
    const lines = commandLines([process.pid, process.ppid]);
    // A --parallel worker runs `bun test --test-worker`; its parent holds the arguments the person typed.
    const inWorker = (lines.get(process.pid) ?? "").includes(" --test-worker");
    const coordinator = inWorker ? process.ppid : process.pid;
    const asked = coresOfWholeSuite(lines.get(coordinator) ?? "");
    // A run of test files is outside the budget and takes no marker: a whole suite its tests start waits like a bare run.
    if (asked === null) return;
    const config = projectOfFolder(realpathSync(process.cwd()));
    if (config === null) return;
    const cores = Math.min(Math.max(1, asked), config.test_budget_cores);
    let announced = false;
    const budget = openTestBudget(ticketLabel, config.test_budget_cores, {
      owner: coordinator,
      minimumFreeMemoryPercent: config.test_min_free_memory_percent,
      maximumSwapGigabytes: config.test_max_swap_gb,
      maximumLoad: config.test_max_load,
      print: (line) => {
        const first = !announced && line.startsWith("waiting:");
        announced ||= first;
        showLine(
          first
            ? `bun test: waiting for the test budget (${cores} cores): ${line}`
            : `bun test: ${line}`,
          inWorker,
        );
      },
    });
    await budget.take(cores);
    // A whole-suite `bun test` that a test starts now runs inside these cores.
    process.env[budgetHeldVariable] = String(coordinator);
  } catch {
    // never fail or hold a run for a problem of the hook
  }
}
