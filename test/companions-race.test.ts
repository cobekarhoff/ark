// ARK-T661: real `ark` processes that run at the same time against one companions/<name>/ folder.
// Each process waits on a barrier file, so they start together; the fake orca takes 200 ms for a
// worker-start, a worker-stop and a send, so the processes overlap inside it.
import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advance,
  dispatchOf,
  entry,
  isoNow,
  mergedRows,
  project,
  rawRun,
  readCursor,
  runId,
  scenario,
  useCompanionTestEnvironment,
} from "./companions-fixtures.ts";

// Ten rounds of three steps, each with several bun processes that start a fake bun process.
setDefaultTimeout(600_000);
useCompanionTestEnvironment();

const arkScript = join(import.meta.dir, "..", "cli", "ark.ts");

type Finished = { code: number; out: string; err: string };

/** Starts every command at once (each waits for the barrier file), and resolves with their results in order. */
async function together(commands: string[][]): Promise<Finished[]> {
  const barrier = join(mkdtempSync(join(tmpdir(), "ark-barrier-")), "go");
  const children = commands.map((args) =>
    Bun.spawn(
      [
        "sh",
        "-c",
        'until [ -e "$0" ]; do sleep 0.01; done; exec "$@"',
        barrier,
        "bun",
        arkScript,
        ...args,
        "--project",
        project,
      ],
      { env: process.env, stdout: "pipe", stderr: "pipe" },
    ),
  );
  writeFileSync(barrier, "");
  return Promise.all(
    children.map(async (child) => {
      const [out, err] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code: await child.exited, out, err };
    }),
  );
}

/** A process that ends well, or refuses with one `ark: ` line; never with a stack trace. */
function expectClean(result: Finished, allowed?: RegExp): void {
  expect(result.err).not.toMatch(/\n\s+at |error: /);
  if (result.code === 0) return;
  expect(result.code).toBe(1);
  expect(result.err.trim().split("\n")).toHaveLength(1);
  expect(result.err).toMatch(/^ark: /);
  if (allowed) expect(result.err).toMatch(allowed);
}

const anotherSync = /another sync is running/;

test("ARK-T661 two syncs that start together start one worker and wake once for each event, and parallel answers and asks stay whole and go to the live dispatch", async () => {
  const { folder, fake } = scenario([entry("cortana", ["run.merged"])]);
  fake.configure({ delayMilliseconds: 200 });
  const cortana = () => dispatchOf(folder, "cortana");
  const wakesFor = (run: string) =>
    fake.sent().filter((message) => message.body.includes(`run: ${run}`));
  rawRun(runId(1000), mergedRows(runId(1000)));

  // Step 1: no worker, no cursor.
  const first = await together([
    ["companions", "sync"],
    ["companions", "sync"],
  ]);
  for (const result of first) expectClean(result, anotherSync);
  expect(first.some((result) => result.code === 0)).toBe(true);
  expect(fake.started()).toHaveLength(1);
  expect(fake.live()).toEqual([cortana()]);
  expect(fake.sent()).toEqual([]);
  expect(readCursor(folder, "cortana").runs[runId(1000)]).toBeDefined();

  for (let round = 1; round <= 10; round++) {
    const label = `round ${round}`;
    fake.retain(cortana());
    fake.clearCalls();

    // Step 2: a live worker and a merged run waiting, two syncs at once.
    advance(60);
    const waiting = runId(1000 + round * 10);
    rawRun(waiting, mergedRows(waiting));
    const pair = await together([
      ["companions", "sync"],
      ["companions", "sync"],
    ]);
    for (const result of pair) expectClean(result, anotherSync);
    expect(
      pair.some((result) => result.code === 0),
      label,
    ).toBe(true);
    expect(wakesFor(waiting), label).toHaveLength(1);
    expect(wakesFor(waiting)[0].to).toBe(`dispatch:${cortana()}`);
    expect(fake.started(), label).toHaveLength(0);
    const [again] = await together([["companions", "sync"]]);
    expect(again.code, label).toBe(0);
    expect(wakesFor(waiting), label).toHaveLength(1);

    // Step 3: eight answers of 2 KB and a sync that writes the cursor, at once.
    advance(60);
    const third = runId(1001 + round * 10);
    rawRun(third, mergedRows(third));
    const mergedAt = isoNow();
    const texts = Array.from({ length: 8 }, (_, index) =>
      `answer ${index + 1} of ${label}\n${"x".repeat(100)}\n`.repeat(20).trimEnd(),
    );
    const mixed = await together([
      ...texts.map((text) => ["companion", "answer", "cortana", text]),
      ["companions", "sync"],
    ]);
    for (const result of mixed) expectClean(result, anotherSync);
    const answers = readFileSync(join(folder, "companions", "cortana", "answers.md"), "utf8");
    // Entries are `## <time>`, a blank line, the text, a blank line: every text of this round is whole.
    const entries = answers
      .split(/^## \S+\n\n/m)
      .filter(Boolean)
      .map((entryText) => entryText.trimEnd());
    for (const text of texts)
      expect(
        entries.filter((e) => e === text),
        label,
      ).toHaveLength(1);
    expect(readCursor(folder, "cortana").runs[third]?.time, label).toBe(mergedAt);

    // Step 4: the worker closed and a merged run waiting: a sync restarts it while an ask goes out.
    advance(60);
    const closedRun = runId(1002 + round * 10);
    rawRun(closedRun, mergedRows(closedRun));
    const closedWorker = cortana();
    fake.close(closedWorker);
    fake.clearCalls();
    const [sync, ask] = await together([
      ["companions", "sync"],
      ["companion", "ask", "cortana", "question"],
    ]);
    expectClean(sync, anotherSync);
    expectClean(ask, /not running/);
    const questions = fake.sent().filter((message) => message.subject === "Question for you");
    // Sent to the live worker, or refused: never to the dispatch that was closed.
    for (const question of questions)
      expect(question.to, label).not.toBe(`dispatch:${closedWorker}`);
    expect(questions, label).toHaveLength(ask.code === 0 ? 1 : 0);
    expect(fake.started(), label).toHaveLength(1);
    expect(cortana(), label).not.toBe(closedWorker);
    // The restarted worker is not started a second time.
    const [settled] = await together([["companions", "sync"]]);
    expect(settled.code, label).toBe(0);
    expect(fake.started(), label).toHaveLength(1);

    // Two asks at once to the live worker: one send each, with its own text, to the same dispatch.
    fake.retain(cortana());
    fake.clearCalls();
    const asks = await together([
      ["companion", "ask", "cortana", "first"],
      ["companion", "ask", "cortana", "second"],
    ]);
    for (const result of asks) expect(result.code, label).toBe(0);
    const sent = fake.sent();
    expect(sent, label).toHaveLength(2);
    expect(new Set(sent.map((message) => message.to)), label).toEqual(
      new Set([`dispatch:${cortana()}`]),
    );
    expect(sent.filter((message) => message.body.includes("Question: first"))).toHaveLength(1);
    expect(sent.filter((message) => message.body.includes("Question: second"))).toHaveLength(1);
  }
});
