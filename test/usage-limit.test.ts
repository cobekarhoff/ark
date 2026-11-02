import { beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Item } from "../cli/hub/types.ts";
import {
  ark,
  recordEvaluation,
  tempArkHome,
  tempGitRepo,
  testNow,
  useFrozenClock,
  writeProject,
  writeTicket,
} from "./helpers.ts";

useFrozenClock();

const repositoryRoot = join(import.meta.dir, "..");
const workerHandle = "term_limit";
let orcaDirectory: string;
let orcaStateDirectory: string;
let terminalLog: string;
let runId: string;

const limitLine = (waitSeconds: number) =>
  JSON.stringify({
    type: "error",
    error: { type: "usage_limit_reached", resets_in_seconds: waitSeconds },
  });

/** The next `orca terminal read` of the worker returns these lines. */
const setTail = (lines: string[]) =>
  writeFileSync(join(orcaStateDirectory, `tail-${workerHandle}`), JSON.stringify(lines));

const setWorkerVerdict = (verdict: string) =>
  writeFileSync(
    join(orcaStateDirectory, "worker-list"),
    JSON.stringify({
      result: {
        workers: [
          {
            taskId: "task-limit",
            agentTerminalHandle: workerHandle,
            projection: {
              liveness: { verdict },
              provider: { model: "pi/task" },
            },
          },
        ],
      },
    }),
  );

beforeEach(() => {
  tempArkHome();
  const projectDirectory = writeProject("demo", {
    workspace: tempGitRepo(),
    ticket_source: "local",
    suites: [
      {
        name: "cli",
        level: "integration",
        repo: ".",
        command: "bun test",
        parser: "bun",
      },
    ],
    roles: {
      implementer: { harness: "omp", model: "pi/task" },
      validator: { harness: "omp", model: "pi/task" },
      reviewer: { harness: "omp", model: "pi/task" },
    },
  });
  orcaDirectory = mkdtempSync(join(tmpdir(), "ark199-orca-"));
  orcaStateDirectory = mkdtempSync(join(tmpdir(), "ark199-state-"));
  terminalLog = join(orcaStateDirectory, "terminal.log");
  process.env.ORCA_STATE_DIRECTORY = orcaStateDirectory;
  process.env.ARK_OMP_SESSIONS = mkdtempSync(join(tmpdir(), "ark199-omp-"));
  process.env.ARK_CLAUDE_SESSIONS = mkdtempSync(join(tmpdir(), "ark199-claude-"));
  process.env.ARK_CODEX_SESSIONS = mkdtempSync(join(tmpdir(), "ark199-codex-"));

  const ticketFile = writeTicket("demo", "ARK-199-LIMIT", [
    { id: "ARK-199-LIMIT-AC1", text: "Any criterion" },
  ]);
  const started = ark("run", "start", ticketFile, "--project", "demo");
  expect(started.code).toBe(0);
  runId = started.out.trim();
  recordEvaluation(join(projectDirectory, "runs", runId));

  writeFileSync(
    join(orcaStateDirectory, "run-list"),
    JSON.stringify({
      result: {
        runs: [
          {
            id: "orca-run",
            objective: `Ark run ${runId}`,
            coordinator_handle: "term_lead",
          },
        ],
      },
    }),
  );
  writeFileSync(
    join(orcaStateDirectory, "task-list"),
    JSON.stringify({
      result: { tasks: [{ id: "task-limit", task_title: "limit-tests" }] },
    }),
  );
  setWorkerVerdict("live");
  setTail([]);

  // Per-terminal tails and a read failure switch, so one test can change what each refresh reads.
  const fakeOrca = join(orcaDirectory, "orca");
  writeFileSync(
    fakeOrca,
    `#!/bin/sh
if [ "$1" = "terminal" ]; then
  case "$2" in
    show) printf '{"result":{"terminal":{"connected":true,"agentIdentity":"omp"}}}' ;;
    list) cat "$ORCA_STATE_DIRECTORY/terminal-list" 2>/dev/null || printf '{"result":{"terminals":[]}}' ;;
    switch) printf '%s\\n' "$*" >> "$ORCA_STATE_DIRECTORY/terminal.log"; printf '{"result":{}}' ;;
    read)
      printf '%s\\n' "$4" >> "$ORCA_STATE_DIRECTORY/reads.log"
      if [ -e "$ORCA_STATE_DIRECTORY/fail-$4" ]; then
        printf 'failed %s\\n' "$4" >> "$ORCA_STATE_DIRECTORY/read.log"
        exit 1
      fi
      if [ -e "$ORCA_STATE_DIRECTORY/tail-$4" ]; then
        printf '{"result":{"terminal":{"tail":%s}}}' "$(cat "$ORCA_STATE_DIRECTORY/tail-$4")"
      else
        printf '{"result":{"terminal":{"tail":[]}}}'
      fi
      ;;
    *) exit 2 ;;
  esac
  exit 0
fi
cat "$ORCA_STATE_DIRECTORY/$2"
`,
  );
  chmodSync(fakeOrca, 0o755);
  process.env.PATH = `${orcaDirectory}:${process.env.PATH}`;
});

async function startUi(): Promise<{
  process: Bun.Subprocess;
  baseUrl: string;
}> {
  const uiProcess = Bun.spawn(["bun", join(repositoryRoot, "cli", "ark.ts"), "ui", "--port", "0"], {
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = uiProcess.stdout.getReader();
  let output = "";
  while (!output.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`ark ui exited before serving: ${output}`);
    output += new TextDecoder().decode(chunk.value);
  }
  const port = Number(output.match(/127\.0\.0\.1:(\d+)/)?.[1]);
  if (!port) throw new Error(`ark ui did not print its listening port: ${output}`);
  return { process: uiProcess, baseUrl: `http://127.0.0.1:${port}` };
}

async function withUi<T>(callback: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = await startUi();
  try {
    return await callback(server.baseUrl);
  } finally {
    server.process.kill();
    await server.process.exited;
  }
}

const needsMe = async (baseUrl: string): Promise<Item[]> =>
  ((await (await fetch(`${baseUrl}/api/state`)).json()) as { needs_me: Item[] }).needs_me;

/** Polls the hub until the usage_limit items satisfy `done`; the hub refreshes Orca every 3 seconds. */
async function waitForLimits(baseUrl: string, done: (limits: Item[]) => boolean): Promise<Item[]> {
  let limits: Item[] = [];
  for (let attempt = 0; attempt < 80; attempt++) {
    limits = (await needsMe(baseUrl)).filter((item) => item.kind === "usage_limit");
    if (done(limits)) return limits;
    await Bun.sleep(100);
  }
  throw new Error(`usage_limit items never matched: ${JSON.stringify(limits)}`);
}

test("ARK-199-AC1 a live agent's usage-limit error gives a usage_limit item with provider and reset time", async () => {
  setTail(["working...", limitLine(4805)]);
  await withUi(async (baseUrl) => {
    const [item] = await waitForLimits(baseUrl, (limits) => limits.length === 1);
    expect(item.project).toBe("demo");
    expect(item.ticket).toBe("ARK-199-LIMIT");
    expect(item.title).toContain("limit-tests");
    expect(item.action).toMatchObject({
      name: "orca-terminal-switch",
      params: { handle: workerHandle },
    });
    expect(item.limit?.provider).toBe("codex");
    expect(item.limit?.reset_at).toBe(new Date(testNow() + 4805_000).toISOString());
  });
});

test("ARK-199-AC1 a rate-limit error with no wait time gives a usage_limit item with no reset time", async () => {
  setTail(["Claude AI usage limit reached"]);
  await withUi(async (baseUrl) => {
    const [item] = await waitForLimits(baseUrl, (limits) => limits.length === 1);
    expect(item.limit).toEqual({ provider: "claude", reset_at: null });
  });
});

test("ARK-199-AC2 the usage_limit item is gone once the output no longer shows the error", async () => {
  setTail([limitLine(4805)]);
  await withUi(async (baseUrl) => {
    await waitForLimits(baseUrl, (limits) => limits.length === 1);
    setTail(["resumed work", "all green"]);
    expect(await waitForLimits(baseUrl, (limits) => limits.length === 0)).toEqual([]);
  });
});

test("ARK-199-AC2 the usage_limit item is gone once the agent exits", async () => {
  setTail([limitLine(4805)]);
  await withUi(async (baseUrl) => {
    await waitForLimits(baseUrl, (limits) => limits.length === 1);
    // The terminal still shows the error, but the agent is dead.
    setWorkerVerdict("dead");
    await waitForLimits(baseUrl, (limits) => limits.length === 0);
    expect((await needsMe(baseUrl)).some((item) => item.kind === "agent")).toBe(true);
  });
});

test("ARK-199-AC2 a failed terminal read keeps the previous usage_limit item", async () => {
  setTail([limitLine(4805)]);
  const readLog = join(orcaStateDirectory, "read.log");
  await withUi(async (baseUrl) => {
    const [item] = await waitForLimits(baseUrl, (limits) => limits.length === 1);
    writeFileSync(join(orcaStateDirectory, `fail-${workerHandle}`), "");
    // Two failed reads mean at least one full refresh finished with the failure.
    for (let attempt = 0; attempt < 120; attempt++) {
      const failures = existsSync(readLog)
        ? readFileSync(readLog, "utf8").trim().split("\n").length
        : 0;
      if (failures >= 2) break;
      await Bun.sleep(100);
    }
    expect(readFileSync(readLog, "utf8").trim().split("\n").length).toBeGreaterThanOrEqual(2);
    const [kept] = await waitForLimits(baseUrl, (limits) => limits.length === 1);
    expect(kept).toEqual(item);
  });
});

test("ARK-199-AC1 output that only quotes the usage-limit words gives no usage_limit item", async () => {
  setTail([
    "> grep usage_limit cli/hub/types.ts",
    '  | export type ItemKind = "gate" | "usage_limit"',
    "  // too many requests and quota exceeded are handled elsewhere",
  ]);
  const readsLog = join(orcaStateDirectory, "reads.log");
  const reads = () =>
    existsSync(readsLog) ? readFileSync(readsLog, "utf8").trim().split("\n").length : 0;
  await withUi(async (baseUrl) => {
    // A second read means the refresh that handled the first read has finished.
    for (let attempt = 0; attempt < 120 && reads() < 2; attempt++) await Bun.sleep(100);
    expect(reads()).toBeGreaterThanOrEqual(2);
    expect((await needsMe(baseUrl)).filter((item) => item.kind === "usage_limit")).toEqual([]);
  });
});

test("ARK-199-AC2 the usage_limit item is gone once the agent has printed more lines after the error", async () => {
  setTail([limitLine(4805)]);
  await withUi(async (baseUrl) => {
    await waitForLimits(baseUrl, (limits) => limits.length === 1);
    setTail([limitLine(4805), "agent resumed", "working... 1", "working... 2"]);
    expect(await waitForLimits(baseUrl, (limits) => limits.length === 0)).toEqual([]);
  });
});

test("ARK-199-AC1 an agent terminal outside any Ark run gives a usage_limit item with its project", async () => {
  const folder = join(orcaStateDirectory, "outside");
  writeFileSync(
    join(orcaStateDirectory, "terminal-list"),
    JSON.stringify({
      result: {
        terminals: [
          {
            handle: "term_free",
            connected: true,
            agentIdentity: "claude",
            title: "side quest",
            worktreePath: folder,
          },
        ],
      },
    }),
  );
  writeFileSync(
    join(orcaStateDirectory, "tail-term_free"),
    JSON.stringify(["Claude AI usage limit reached"]),
  );
  await withUi(async (baseUrl) => {
    const limits = await waitForLimits(baseUrl, (found) =>
      found.some((item) => item.id.endsWith(":term_free")),
    );
    const item = limits.find((candidate) => candidate.id.endsWith(":term_free"))!;
    expect(item.limit).toEqual({ provider: "claude", reset_at: null });
    expect(item.title).toContain("side quest");
    expect(item.action).toMatchObject({ params: { handle: "term_free" } });
  });
});

test(
  "ARK-199-AC3 the headless Map lists the usage_limit item on its agent node, as the API counts it",
  { timeout: 30_000 },
  async () => {
    setTail([limitLine(4805)]);
    await using view = new Bun.WebView({
      backend: "chrome",
      width: 1440,
      height: 1000,
    });
    await withUi(async (baseUrl) => {
      await waitForLimits(baseUrl, (limits) => limits.length === 1);
      await view.navigate(baseUrl);
      const nodeSelector = `[data-node="agent:${runId}:${workerHandle}"]`;
      await view.evaluate(
        `document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }))`,
      );
      for (let attempt = 0; attempt < 80; attempt++) {
        if (await view.evaluate(`document.querySelector('${nodeSelector}') !== null`)) break;
        await Bun.sleep(100);
      }
      await view.evaluate(
        `document.querySelector('${nodeSelector}').dispatchEvent(new MouseEvent('click', { bubbles: true }))`,
      );
      const labels = (await view.evaluate(
        `Array.from(document.querySelectorAll('aside.detail button.btn.primary')).map((button) => button.textContent)`,
      )) as string[];
      expect(labels).toEqual(["Open in Orca"]);
    });
  },
);

test(
  "ARK-199-AC3 headless Home shows the usage_limit item with a countdown and its action switches Orca to the agent",
  { timeout: 30_000 },
  async () => {
    setTail([limitLine(4805)]);
    await using view = new Bun.WebView({
      backend: "chrome",
      width: 1440,
      height: 1000,
    });
    await withUi(async (baseUrl) => {
      await view.navigate(baseUrl);
      const rowSelector = `[data-need^="limit:"]`;
      for (let attempt = 0; attempt < 80; attempt++) {
        if (await view.evaluate(`document.querySelector('${rowSelector}') !== null`)) break;
        await Bun.sleep(100);
      }
      const countdown = (await view.evaluate(
        `document.querySelector('${rowSelector} [data-countdown]').textContent`,
      )) as string;
      // 4805 seconds is 80 minutes and a few seconds, so the page rounds up to 1h 21m or 1h 20m.
      expect(countdown).toMatch(/^codex · resets in 1h 2?[01]m$/);
      await view.evaluate(`document.querySelector('${rowSelector} button.act').click()`);
      for (let attempt = 0; attempt < 40 && !existsSync(terminalLog); attempt++)
        await Bun.sleep(50);
      expect(readFileSync(terminalLog, "utf8")).toContain(
        `terminal switch --terminal ${workerHandle}`,
      );
    });
  },
);
