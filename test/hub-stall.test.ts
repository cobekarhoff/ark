// ARK-533: the hub answers every request within 1 s on a large home, reports its loop lag and the pass
// time of each source on a health route, logs a slow pass and a loop lag above 1 s, and `ark chief
// state` and `ark services status` print a Hub line that says stalled. Real `hub/main.ts` processes with
// fake `orca`, `gh`, `omp` and `plannotator` on PATH.
//
// Waiting rule (test/wallclock.test.ts, ARK-T126): no timer and no sleep in this file. Every wait is an
// event: a request loop (the requests are the wait), a process exit, a stream read or a marker file of a
// fake tool. A fixed delay that stands for a slow tool lives in a fixture: the fake `orca`,
// `test/fixtures/hub-stall/freeze.sh` and `test/fixtures/hub-stall/delay-proxy.ts`.
import { expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sourceAffects, type Snapshot } from "../hub/types.ts";
import {
  ompSessionText,
  runDirectoryOf,
  today,
  transcriptText,
  writeBacklogTicket,
  writeRun,
} from "./hub-fixtures.ts";
import {
  endedAt,
  health,
  healthProber,
  installHooks,
  openPage,
  pages,
  processes,
  readHealth,
  snapshotOf,
  stage,
  startHub,
  type Health,
  type HealthAnswer,
  type Hub,
  type PassHealth,
  type Stage,
} from "./hub-stall-support.ts";
import { tempGitRepo, writeProject } from "./helpers.ts";

setDefaultTimeout(60_000);

const root = resolve(import.meta.dir, "..");
const fixtures = join(import.meta.dir, "fixtures", "hub-stall");

/** A request must be answered within 1 s (ARK-533/AC1). */
const answerLimitMilliseconds = 1000;
/** A reader pass must hold the event loop for at most 200 ms (ARK-533/AC1). */
const lagLimitMilliseconds = 200;
/** The loop lag line of the log starts above 1 s (ARK-533/AC3). */
const lagLineMilliseconds = 1000;
/** `ark chief state` and `ark services status` call the hub stalled after 5 s (ARK-533/AC4). */
const stallLimitMilliseconds = 5000;
/** The health route keeps the largest lag of the last minute (ARK-533/AC2). */
const windowMilliseconds = 60_000;
/** `ARK_HUB_INTERVAL_MS` of the tests that need a normal pass below its interval and a forced slow pass above it. */
const slowTestIntervalMilliseconds = 4000;
/** The fake `orca` sleeps this long on `terminal list` for a forced slow pass. */
const orcaSleepSeconds = 6;

installHooks();

const project = "p";

/** Three runs in `building`, so every source has something to read. */
function threeRuns(): string[] {
  return [1, 2, 3].map((number) => {
    const run = `${today()}-ARK-9${number}-1`;
    writeRun({
      project,
      run,
      ticket: { id: `ARK-9${number}`, title: `Stall ${number}` },
      phase: "building",
    });
    return run;
  });
}

// ---------------------------------------------------------------- the health route

/**
 * Reads the route back to back until `done` holds: the requests are the wait. Every answer must
 * be within the answer limit, and each source's `slow` flag must follow its own last pass (duration
 * above the interval). The case timeout is the only upper bound.
 */
async function pollHealth(
  hub: Hub,
  done: (answer: HealthAnswer) => boolean,
  interval = slowTestIntervalMilliseconds,
): Promise<HealthAnswer> {
  for (;;) {
    const answer = await health(hub);
    if (answer.milliseconds > answerLimitMilliseconds)
      throw new Error(`GET /api/health took ${Math.round(answer.milliseconds)} ms`);
    for (const [name, pass] of Object.entries(answer.health.sources ?? {}))
      if (
        pass.last_ms !== null &&
        pass.last_ms !== undefined &&
        pass.slow !== pass.last_ms > interval
      )
        throw new Error(
          `${name}: slow is ${pass.slow} for a pass of ${pass.last_ms} ms, interval ${interval} ms`,
        );
    if (done(answer)) return answer;
  }
}

/** `freeze.sh`: stop the hub, hold it, continue it. Resolves when the hub runs again. */
const freeze = (hub: Hub, seconds: number) =>
  Bun.spawn(["sh", join(fixtures, "freeze.sh"), String(hub.pid), String(seconds)], {
    stdout: "ignore",
    stderr: "ignore",
  }).exited;

/** Each duration written in a line, in ms: `6100 ms`, `1.45 s`. */
const durationsOf = (line: string): number[] =>
  [...line.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s)\b/g)].map(([, value, unit]) =>
    unit === "ms" ? Number(value) : Number(value) * 1000,
  );

const linesOf = (text: string) => text.split("\n").filter((line) => line.trim() !== "");
const startLine = /^Ark hub on http:\/\/127\.0\.0\.1:\d+$/;

// ---------------------------------------------------------------- ARK-T703

test("ARK-T703 With no page the health route answers and shows no pass and no lag, the hub still reads nothing, and a pass dropped when the last page leaves is not recorded as a pass", async () => {
  const fake = stage();
  threeRuns();
  const idleWindowMilliseconds = 2500; // above the 2000 ms interval
  const settleMilliseconds = 1000;
  const hub = await startHub({ interval: 2000 });

  // Step 1: no page, so no lag and no pass; the route still answers.
  const first = await health(hub);
  expect(first.milliseconds <= answerLimitMilliseconds).toBe(true);
  expect(first.health.lag_ms ?? null, "no page: no measured lag, not 0").toBeNull();
  for (const [name, pass] of Object.entries(first.health.sources ?? {})) {
    expect(pass.last_ms ?? null, `${name} duration with no page`).toBeNull();
    expect(pass.ended_at ?? null, `${name} end time with no page`).toBeNull();
  }
  expect(first.health.slow ?? []).toEqual([]);

  // Step 2: probe for longer than one interval; no read runs.
  const started = performance.now();
  while (performance.now() - started < idleWindowMilliseconds) await health(hub);
  expect(fake.lines("orca.terminal-list"), "an idle hub read Orca").toBe(0);
  expect((await health(hub)).health).toEqual(first.health);

  // Step 3: a page, with a held Orca read in flight and the first lag sample taken.
  fake.set("orca.hold", "");
  const page = openPage(hub);
  await pollHealth(
    hub,
    (answer) =>
      fake.lines("orca.terminal-list") >= 1 &&
      fake.lines("orca.done") === 0 &&
      typeof answer.health.lag_ms === "number",
    2000,
  );

  // Step 4: the last page leaves; the lag goes absent (the hub saw the disconnect) before the release.
  page.close();
  await pollHealth(
    hub,
    (answer) => {
      expect(fake.lines("orca.done"), "the held call ended before the page left").toBe(0);
      return (answer.health.lag_ms ?? null) === null;
    },
    2000,
  );
  fake.remove("orca.hold");

  // Steps 5 and 6: the dropped pass is no pass, at every probe after the release.
  await pollHealth(hub, () => fake.lines("orca.done") >= 1, 2000);
  const released = performance.now();
  do {
    const answer = await health(hub);
    expect(answer.milliseconds <= answerLimitMilliseconds).toBe(true);
    expect(answer.health.sources?.orca?.last_ms ?? null, "duration of a dropped pass").toBeNull();
    expect(endedAt(answer.health.sources?.orca), "end time of a dropped pass").toBeNull();
  } while (performance.now() - released < settleMilliseconds);
  const last = await health(hub);
  expect(last.health.sources?.orca?.last_ms ?? null).toBeNull();
}, 60_000);

// ---------------------------------------------------------------- ARK-T700

test("ARK-T700 The health route answers within 1 s with loop lag (the largest of the last minute) and, for each reader source, last pass duration and end time, and names a source whose last pass took longer than its interval", async () => {
  const fake = stage();
  threeRuns();
  fake.set("orca.sleep", String(orcaSleepSeconds));
  const testStart = Date.now();
  const hub = await startHub({ interval: slowTestIntervalMilliseconds });
  openPage(hub);

  // Step 2: the route answers while the slow Orca pass is in flight.
  await pollHealth(
    hub,
    () => fake.lines("orca.terminal-list") >= 1 && fake.lines("orca.done") === 0,
  );

  // Step 3: the slow pass ended; its duration, end time and slow flag.
  const slow = await pollHealth(hub, (answer) => endedAt(answer.health.sources?.orca) !== null);
  const snapshot = await snapshotOf(hub);
  expect(typeof slow.health.lag_ms, "lag_ms").toBe("number");
  const orca = slow.health.sources.orca;
  expect(orca.last_ms! >= orcaSleepSeconds * 1000, `orca pass took ${orca.last_ms} ms`).toBe(true);
  expect(endedAt(orca)! >= testStart && endedAt(orca)! <= Date.now(), "orca end time").toBe(true);
  expect(orca.slow).toBe(true);
  expect(slow.health.slow).toContain("orca");
  expect(snapshot.sources.orca.ok, "the slow call completed, it did not time out").toBe(true);
  expect(fake.lines("orca.done")).toBeGreaterThanOrEqual(1);
  for (const name of Object.keys(snapshot.sources))
    expect(slow.health.sources[name], `${name} has an entry`).toBeDefined();
  for (const name of ["ark", "usage", "evidence"]) {
    expect(slow.health.sources[name].slow, `${name} slow`).toBe(false);
    expect(slow.health.sources[name].last_ms, `${name} duration`).not.toBeNull();
    expect(endedAt(slow.health.sources[name]), `${name} end time`).not.toBeNull();
  }
  expect(slow.health.slow).not.toContain("ark");
  expect(slow.health.slow).not.toContain("usage");

  // Step 4: a normal pass clears the flag.
  fake.set("orca.sleep", "0");
  const firstEnd = endedAt(orca)!;
  const recovered = await pollHealth(
    hub,
    (answer) => endedAt(answer.health.sources.orca)! > firstEnd && !answer.health.sources.orca.slow,
  );
  expect(recovered.health.sources.orca.last_ms! <= slowTestIntervalMilliseconds).toBe(true);
  expect(recovered.health.slow).not.toContain("orca");

  // Step 5: a 1.5 s freeze is the largest lag the route reports, as soon as the loop runs again.
  await freeze(hub, 1.5);
  const freezeEndedAt = performance.now();
  let requests = 0;
  const frozen = await pollHealth(hub, (answer) => {
    requests += 1;
    expect(requests, "requests after the freeze without a lag of 1 s").toBeLessThanOrEqual(500);
    return (answer.health.lag_ms ?? 0) >= lagLineMilliseconds;
  });
  const frozenLag = frozen.health.lag_ms!;

  // Step 6: after later passes the maximum is still there, not the latest sample.
  const arkEnd = endedAt(frozen.health.sources.ark)!;
  const later = await pollHealth(hub, (answer) => endedAt(answer.health.sources.ark)! > arkEnd);
  expect(later.health.lag_ms!).toBeGreaterThanOrEqual(frozenLag);

  // Step 7: the lag expires with its window.
  const expired = await pollHealth(hub, (answer) => (answer.health.lag_ms ?? 0) < frozenLag);
  expect(
    performance.now() - freezeEndedAt >= windowMilliseconds - 5000,
    `the lag of the freeze expired after ${Math.round(performance.now() - freezeEndedAt)} ms`,
  ).toBe(true);
  expect(expired.health.lag_ms!).toBeLessThan(frozenLag);

  // Step 8: a foreign Origin is refused as on every other GET route.
  const headers = { origin: "http://evil.example" };
  const foreign = await readHealth(hub, headers);
  const foreignSnapshot = await fetch(`${hub.baseUrl()}/api/snapshot`, { headers });
  expect(foreignSnapshot.status).toBe(403);
  expect(foreign.status).toBe(foreignSnapshot.status);
}, 150_000);

// ---------------------------------------------------------------- ARK-T701

test("ARK-T701 The hub logs one line for each pass longer than its interval and one for each loop lag above 1 s, naming the source and the duration, and no line for a normal pass or a lag below 1 s", async () => {
  const fake = stage();
  threeRuns();
  const sourceName =
    /\b(ark|orca|plannotator|github|usage|providerLimits|agentWait|evidence|queue|chiefUnread|resources)\b/;
  const endedTwice = new Map<string, Set<number>>();
  const watchEnds = (answer: HealthAnswer) => {
    for (const [name, pass] of Object.entries(answer.health.sources ?? {})) {
      const ended = endedAt(pass);
      if (ended === null) continue;
      endedTwice.set(name, (endedTwice.get(name) ?? new Set()).add(ended));
    }
  };

  // Scenario A: normal passes write nothing.
  const first = await startHub({ interval: slowTestIntervalMilliseconds });
  openPage(first);
  await pollHealth(first, (answer) => {
    watchEnds(answer);
    return (
      (endedTwice.get("ark")?.size ?? 0) >= 2 &&
      (endedTwice.get("usage")?.size ?? 0) >= 2 &&
      ["orca", "github", "evidence", "queue"].every(
        (name) => (endedTwice.get(name)?.size ?? 0) >= 1,
      )
    );
  });
  expect(linesOf(first.output()), `normal passes wrote a line: ${first.output()}`).toHaveLength(1);
  expect(first.output().trim()).toMatch(startLine);

  // Scenario C: a lag of 0.3 s writes nothing, a lag of 1.5 s writes one line.
  const advance = async () => {
    const before = Math.max(...(endedTwice.get("ark") ?? [0]));
    await pollHealth(first, (answer) => {
      watchEnds(answer);
      return endedAt(answer.health.sources.ark)! > before;
    });
  };
  await freeze(first, 0.3);
  await advance();
  expect(linesOf(first.output()), `a lag of 0.3 s wrote a line: ${first.output()}`).toHaveLength(1);

  await freeze(first, 1.5);
  await advance();
  await advance();
  const lagLines = linesOf(first.output()).slice(1);
  expect(lagLines, "a lag of 1.5 s writes one line").toHaveLength(1);
  expect(lagLines[0]).toMatch(/lag/i);
  expect(Math.max(...durationsOf(lagLines[0])) >= lagLineMilliseconds).toBe(true);
  expect(lagLines[0], "a lag line names no source").not.toMatch(sourceName);

  // Scenario B: two slow passes of orca on a second hub of the same home.
  pages.splice(0).forEach((page) => page.close());
  first.child.kill("SIGTERM");
  await first.exited;
  fake.set("orca.sleep", String(orcaSleepSeconds));
  const second = await startHub({ interval: slowTestIntervalMilliseconds });
  openPage(second);
  const orcaLines = () => linesOf(second.output()).filter((line) => /\borca\b/.test(line));
  endedTwice.clear();
  await pollHealth(second, (answer) => {
    watchEnds(answer);
    return endedAt(answer.health.sources.orca) !== null && orcaLines().length >= 1;
  });
  expect((await snapshotOf(second)).sources.orca.ok, "a completed slow call, not a timeout").toBe(
    true,
  );
  expect(orcaLines(), "one line for the first slow pass").toHaveLength(1);
  expect(Math.max(...durationsOf(orcaLines()[0])) >= orcaSleepSeconds * 1000).toBe(true);
  for (const name of ["ark", "usage", "plannotator", "evidence"])
    expect(
      linesOf(second.output()).filter((line) => new RegExp(`\\b${name}\\b`).test(line)),
      `a normal ${name} pass wrote a line`,
    ).toEqual([]);

  const firstEnd = Math.max(...(endedTwice.get("orca") ?? [0]));
  await pollHealth(
    second,
    (answer) => endedAt(answer.health.sources.orca)! > firstEnd && orcaLines().length >= 2,
  );
  const slowLines = orcaLines();
  expect(slowLines, "one line for each slow pass").toHaveLength(2);
  for (const line of slowLines)
    expect(Math.max(...durationsOf(line)) >= orcaSleepSeconds * 1000, line).toBe(true);
}, 90_000);

// ---------------------------------------------------------------- ARK-T702

/** The output of `ark <arguments>` started with the given home: its exit code, text and the time it took. */
type CommandOutput = { code: number; out: string; err: string; milliseconds: number };

async function runArk(home: string, arkArguments: string[]): Promise<CommandOutput> {
  const started = performance.now();
  const child = Bun.spawn(["bun", join(root, "cli", "ark.ts"), ...arkArguments], {
    env: { ...process.env, ARK_HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  processes.push(child);
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, out, err, milliseconds: performance.now() - started };
}

/** `ark chief state` and `ark services status` at the same time. */
const bothCommands = (home: string): Promise<[CommandOutput, CommandOutput]> =>
  Promise.all([
    runArk(home, ["chief", "state", "--project", project]),
    runArk(home, ["services", "status", "--project", project]),
  ]);

const hubLinesOf = (text: string) => linesOf(text).filter((line) => /^Hub\b/.test(line));
const shapeOf = (line: string) => line.replace(/\d+(?:\.\d+)?/g, "N");
/** A Hub line of a live hub: an answer time, then a loop lag, no word stalled. */
const isLiveLine = (line: string) => !/stalled/i.test(line) && durationsOf(line).length >= 2;
const isStalledLine = (line: string) =>
  /stalled/i.test(line) && !/answered/i.test(line) && !/lag/i.test(line);
/** The loop lag a live Hub line reports, in ms (the second duration of the line). */
const lagOfLine = (line: string) => durationsOf(line)[1];
/**
 * Both commands run between two reads of the health route. The route's lag is the largest of a 60 s
 * window, so it can only hold or grow in between: the lag a command prints lies between the reads.
 */
async function commandsBetweenReads(hub: Hub, home: string) {
  const before = (await health(hub)).health.lag_ms!;
  const outputs = await bothCommands(home);
  const after = (await health(hub)).health.lag_ms!;
  return { before, after, outputs };
}

test("ARK-T702 ark chief state and ark services status print a Hub line with the answer time and lag, say stalled after 5 s, and read a missing or dead hub as no hub, not as stalled", async () => {
  const fake = stage();
  const home = fake.home;
  const workspace = tempGitRepo();
  writeProject(project, {
    workspace,
    ticket_source: "local",
    suites: [{ name: "unit", level: "unit", repo: ".", command: "true {report}", parser: "bun" }],
    roles: {
      implementer: { harness: "claude", model: "claude-sonnet" },
      validator: { harness: "codex", model: "gpt-codex" },
      reviewer: { harness: "codex", model: "gpt-codex" },
      chief: { harness: "claude", model: "claude-opus" },
    },
    concurrency: 3,
    gates: { plan: "auto", strategy: "auto" },
  });
  fake.set(
    "orca.runs",
    JSON.stringify({
      result: { runs: [{ id: "run_chief", objective: `Master Chief: ${project} tickets` }] },
    }),
  );
  const launchctl = join(fake.state, "launchctl");
  writeFileSync(launchctl, "#!/bin/sh\nexit 113\n");
  chmodSync(launchctl, 0o755);
  process.env.HOME = mkdtempSync(join(tmpdir(), "ark-stall-home-"));
  process.env.ARK_LAUNCHCTL = launchctl;
  const lockFiles = (directory: string) =>
    readdirSync(directory).filter((name) => /^hub-[0-9a-f]+\.lock$/.test(name));

  // Step 1: no hub, no lock file: nothing is stalled and nothing is answered.
  expect(lockFiles(home)).toEqual([]);
  const noHubOutputs = async (label: string) => {
    for (const output of await bothCommands(home)) {
      expect(output.code, `${label}: ${output.err}`).toBe(0);
      expect(output.out, label).toMatch(/not installed/);
      expect(
        hubLinesOf(output.out).filter(isStalledLine),
        `${label}: a missing hub is not stalled`,
      ).toEqual([]);
      expect(hubLinesOf(output.out).filter(isLiveLine), `${label}: no hub answered`).toEqual([]);
    }
  };
  await noHubOutputs("no hub");

  // Step 3 (set up first, so step 2 can reuse its lock): a live hub and a page.
  const hub = await startHub({ interval: 2000 });
  openPage(hub);
  const [lockName] = lockFiles(home);
  expect(lockName, "the hub made a lock file in its home").toBeDefined();
  await pollHealth(hub, (answer) => typeof answer.health.lag_ms === "number", 2000);
  const { before, after, outputs: live } = await commandsBetweenReads(hub, home);
  for (const output of live) {
    expect(output.code, output.err).toBe(0);
    const lines = hubLinesOf(output.out);
    expect(lines, "one Hub line").toHaveLength(1);
    expect(isLiveLine(lines[0]), lines[0]).toBe(true);
    expect(durationsOf(lines[0])[0] <= answerLimitMilliseconds, lines[0]).toBe(true);
    expect(
      lagOfLine(lines[0]) >= before && lagOfLine(lines[0]) <= after,
      `${lines[0]}: the route read ${before} ms before and ${after} ms after`,
    ).toBe(true);
  }
  expect(shapeOf(hubLinesOf(live[0].out)[0])).toBe(shapeOf(hubLinesOf(live[1].out)[0]));
  const rowsOf = (text: string) => linesOf(text).filter((line) => !/^Hub\b/.test(line));
  const servicesOf = (text: string) =>
    text.split(/^## /m).find((part) => part.startsWith("Services"))!;
  expect(rowsOf(servicesOf(live[0].out)).slice(1).join("\n").trim()).toBe(
    rowsOf(live[1].out).join("\n").trim(),
  );

  // Step 4: a hub that answers 1.5 s after the request arrived is slow, not stalled.
  const proxyHome = mkdtempSync(join(tmpdir(), "ark-stall-proxy-home-"));
  const arrived = join(fake.state, "proxy.arrived");
  const proxy = Bun.spawn(
    ["bun", join(fixtures, "delay-proxy.ts"), String(hub.port()), "1.5", arrived],
    { stdout: "pipe", stderr: "ignore" },
  );
  processes.push(proxy);
  let proxyOutput = "";
  for await (const chunk of proxy.stdout) {
    proxyOutput += new TextDecoder().decode(chunk);
    if (/proxy on \d+/.test(proxyOutput)) break;
  }
  const proxyPort = Number(/proxy on (\d+)/.exec(proxyOutput)![1]);
  mkdirSync(join(proxyHome, "projects", project), { recursive: true });
  cpSync(
    join(home, "projects", project, "ark.yml"),
    join(proxyHome, "projects", project, "ark.yml"),
  );
  writeFileSync(join(proxyHome, lockName), JSON.stringify({ pid: hub.pid, port: proxyPort }));
  const slowOutput = await runArk(proxyHome, ["services", "status", "--project", project]);
  expect(slowOutput.code, slowOutput.err).toBe(0);
  expect(existsSync(arrived), "the request reached the proxy").toBe(true);
  const slowLines = hubLinesOf(slowOutput.out);
  expect(slowLines, "one Hub line").toHaveLength(1);
  expect(isLiveLine(slowLines[0]), slowLines[0]).toBe(true);
  expect(durationsOf(slowLines[0])[0] >= 1000, slowLines[0]).toBe(true);

  // Step 5: a frozen hub is stalled after 5 s, in both commands, and both commands finish.
  process.kill(hub.pid, "SIGSTOP");
  while (
    !spawnSync("ps", ["-o", "stat=", "-p", String(hub.pid)])
      .stdout.toString()
      .startsWith("T")
  ) {
    // The signal is delivered; the process state is the event.
  }
  const stalled = await bothCommands(home);
  for (const output of stalled) {
    expect(output.code, output.err).toBe(0);
    expect(output.milliseconds >= stallLimitMilliseconds, "the command waited its limit").toBe(
      true,
    );
    const lines = hubLinesOf(output.out);
    expect(lines, "one Hub line").toHaveLength(1);
    expect(isStalledLine(lines[0]), lines[0]).toBe(true);
    expect(output.out, "the services rows are printed").toMatch(/^sweep\s+not installed$/m);
  }
  expect(stalled[0].out, "the other sections of chief state are printed").toMatch(/^## Config/m);

  // Step 6: the hub runs again and answers again.
  process.kill(hub.pid, "SIGCONT");
  // The hub's timer saw the freeze: the route reports a lag of about the stall, and both commands print it.
  const recovered = await pollHealth(
    hub,
    (answer) => (answer.health.lag_ms ?? 0) >= stallLimitMilliseconds - 1000,
    2000,
  );
  const frozenLag = recovered.health.lag_ms!;
  const afterFreeze = await commandsBetweenReads(hub, home);
  expect(afterFreeze.before >= frozenLag).toBe(true);
  for (const output of afterFreeze.outputs) {
    expect(output.code, output.err).toBe(0);
    const lines = hubLinesOf(output.out);
    expect(lines).toHaveLength(1);
    expect(isLiveLine(lines[0]), lines[0]).toBe(true);
    expect(
      lagOfLine(lines[0]) >= frozenLag && lagOfLine(lines[0]) <= afterFreeze.after,
      `${lines[0]}: the route read ${frozenLag} ms after the freeze and ${afterFreeze.after} ms after the commands`,
    ).toBe(true);
  }

  // Step 2: a lock of a dead hub (the hub that ended, its port closed) reads as no hub.
  pages.splice(0).forEach((page) => page.close());
  hub.child.kill("SIGTERM");
  await hub.exited;
  expect(lockFiles(home)).toEqual([lockName]);
  await noHubOutputs("dead lock");

  // Step 7: a hub of another clone of the repo is found.
  const copy = mkdtempSync(join(tmpdir(), "ark-stall-copy-"));
  for (const name of ["hub", "cli", "skills", "package.json"])
    cpSync(join(root, name), join(copy, name), { recursive: true });
  symlinkSync(join(root, "node_modules"), join(copy, "node_modules"));
  const otherHome = mkdtempSync(join(tmpdir(), "ark-stall-other-home-"));
  cpSync(join(home, "projects"), join(otherHome, "projects"), { recursive: true });
  const other = await startHub({
    interval: 2000,
    repository: copy,
    environment: { ARK_HOME: otherHome },
  });
  openPage(other);
  await pollHealth(other, (answer) => typeof answer.health.lag_ms === "number", 2000);
  for (const output of await bothCommands(otherHome)) {
    expect(output.code, output.err).toBe(0);
    const lines = hubLinesOf(output.out);
    expect(lines, "one Hub line").toHaveLength(1);
    expect(
      isLiveLine(lines[0]),
      `the CLI finds a hub its own repo folder did not start: ${lines[0]}`,
    ).toBe(true);
  }
}, 180_000);

// ---------------------------------------------------------------- ARK-T699

const soakMilliseconds = 120_000;
const openRunCount = 40;
const closedRunCount = 210;
const sessionFileCount = 4000;
const filesPerFolder = 16;
const messagesPerFile = 20;
const costPerMessage = 0.25; // exact in binary, so a sum has no rounding
/** 1x1 PNG: the signature is what the image route reads. */
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

type Fixture = {
  openRuns: string[];
  closedRun: string;
  /** The omp session file of the first open run: one tool call `call1` with a result. */
  transcriptFile: string;
  /** The ids of the open runs whose one session file holds only priced messages. */
  pricedRuns: string[];
};

/** 250 runs (40 open) and 4000 session files in the temp home; the cwd of 40 files is inside an open run. */
function largeHome(): Fixture {
  // The project's workspace is a tree of 655 folders (5 x 5 x 5 x 4 below the root): `loadConfig` walks it for repos (ARK-533 profile).
  const workspace = mkdtempSync(join(tmpdir(), "ark-stall-workspace-"));
  const levels = [5, 5, 5, 4];
  const grow = (directory: string, depth: number) => {
    if (depth === levels.length) return;
    for (let number = 0; number < levels[depth]; number++) {
      const child = join(directory, `d${number}`);
      mkdirSync(child);
      grow(child, depth + 1);
    }
  };
  grow(workspace, 0);
  writeProject(project, {
    workspace,
    ticket_source: "local",
    suites: [{ name: "unit", level: "unit", repo: ".", command: "true {report}", parser: "bun" }],
    roles: {
      implementer: { harness: "claude", model: "claude-sonnet" },
      validator: { harness: "codex", model: "gpt-codex" },
      reviewer: { harness: "codex", model: "gpt-codex" },
      chief: { harness: "claude", model: "claude-opus" },
    },
  });
  const openRuns: string[] = [];
  for (let number = 0; number < openRunCount; number++) {
    const run = `${today()}-ARK-${1000 + number}-1`;
    writeRun({
      project,
      run,
      ticket: { id: `ARK-${1000 + number}`, title: `Open run ${number}` },
      phase: "building",
    });
    openRuns.push(run);
  }
  const closedRuns: string[] = [];
  for (let number = 0; number < closedRunCount; number++) {
    const run = `${today()}-ARK-${2000 + number}-1`;
    writeRun({
      project,
      run,
      ticket: { id: `ARK-${2000 + number}`, title: `Closed run ${number}` },
      phase: "closed",
      metricsCostUsd: 1,
    });
    closedRuns.push(run);
  }
  const sessions = process.env.ARK_OMP_SESSIONS!;
  const started = new Date(Date.now() - 3_000_000);
  const messages = Array.from({ length: messagesPerFile }, (_, index) => ({
    time: new Date(started.getTime() + index * 1000),
    costUsd: costPerMessage,
  }));
  const spacing = sessionFileCount / openRunCount;
  let transcriptFile = "";
  for (let index = 0; index < sessionFileCount; index++) {
    const folder = join(sessions, `folder-${Math.floor(index / filesPerFolder)}`);
    if (index % filesPerFolder === 0) mkdirSync(folder, { recursive: true });
    const owner = index % spacing === 0 ? openRuns[index / spacing] : undefined;
    const cwd = owner
      ? join(runDirectoryOf(project, owner), "workspace")
      : join(tmpdir(), "ark-stall-elsewhere", `folder-${Math.floor(index / filesPerFolder)}`);
    const file = join(folder, `session-${index}.jsonl`);
    writeFileSync(
      file,
      owner === openRuns[0]
        ? transcriptText("omp", {
            cwd,
            start: started,
            tag: "stall",
            extra: [{ kind: "call", id: "call1", args: { command: "ls" }, result: "ok\nsecond" }],
          })
        : ompSessionText(cwd, messages, started),
    );
    if (owner === openRuns[0]) transcriptFile = file;
  }
  const directory = runDirectoryOf(project, openRuns[0]);
  mkdirSync(join(directory, "results", "evidence", "ARK-T1", "head"), { recursive: true });
  writeFileSync(join(directory, "results", "evidence", "ARK-T1", "head", "shot.png"), png);
  writeBacklogTicket({
    project,
    id: "ARK-840",
    title: "Readable",
    status: "ready",
    problem: "Why it hurts",
    change: "What changes",
    criteria: [{ id: "ARK-840-AC1", text: "It works", verifiedBy: ["ARK-T1"] }],
  });
  return {
    openRuns,
    closedRun: closedRuns[0],
    transcriptFile,
    pricedRuns: openRuns.slice(1),
  };
}

/** One inbox message to an open run, so the conversation routes have a message with a body. */
const inboxMessage = (run: string) => ({
  id: "msg_1",
  type: "status",
  from_handle: "term_w1",
  to_handle: `run:orca-${run}`,
  subject: "subject of msg_1",
  body: "BODY msg_1",
  thread_id: null,
  run_id: `orca-${run}`,
  payload: null,
  created_at: new Date(Date.now() - 600_000).toISOString(),
  delivered_at: null,
});

type Probe = {
  label: string;
  count: number;
  answered: number;
  slowest: number;
  /** The number of the request (from 1) that was the slowest, to tell a first read from a steady one. */
  slowestRequest: number;
  /** Statuses that are right before the first read of the data this route depends on. */
  pending: number[];
  settled: boolean;
  wrong: string[];
};

test("ARK-T699 With a page connected, default reader intervals and 250 runs plus 4000 session files, every route answers within 1 s at every probe for 120 s and the loop never lags over 200 ms", async () => {
  const fake = stage();
  const fixture = largeHome();
  const [openRun] = fixture.openRuns;
  // Every open run has a run lead that Orca lists with no harness, so each compose reads `roles.chief` of the project for it.
  fake.set(
    "orca.runs",
    JSON.stringify({
      result: {
        runs: [
          ...fixture.openRuns.map((run, number) => ({
            id: `orca-${run}`,
            objective: `Ark run ${run}`,
            coordinator_handle: `term-${number}`,
          })),
          { id: "orca-chief-p", objective: `Master Chief: ${project} tickets` },
        ],
      },
    }),
  );
  fake.set(
    "orca.terminals",
    JSON.stringify({
      result: {
        terminals: fixture.openRuns.map((_, number) => ({
          handle: `term-${number}`,
          connected: true,
        })),
      },
    }),
  );
  fake.set("orca.inbox", JSON.stringify({ result: { messages: [inboxMessage(openRun)] } }));
  const hub = await startHub(); // the default intervals: 2 s to 60 s
  const baseUrl = hub.baseUrl();
  const page = openPage(hub);
  // Request 1 is cold: a direct run URL asks for its run at once, before any snapshot. The hub answers a route
  // it cannot serve yet with 503 `loading` within 1 s; that is right only until the first snapshot is published.

  const probes = new Map<string, Probe>();
  const probe = async (
    label: string,
    path: string,
    options: { pending?: number[]; method?: string; body?: string } = {},
  ): Promise<string> => {
    const record =
      probes.get(label) ??
      ({
        label,
        count: 0,
        answered: 0,
        slowest: 0,
        slowestRequest: 0,
        pending: options.pending ?? [],
        settled: false,
        wrong: [],
      } satisfies Probe);
    probes.set(label, record);
    const coldAtStart = !page.seen();
    const started = performance.now();
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers:
        options.method === "POST" ? { origin: baseUrl, "content-type": "application/json" } : {},
      body: options.body,
    });
    const text = await response.text();
    record.count += 1;
    const took = performance.now() - started;
    if (took > record.slowest) record.slowestRequest = record.count;
    record.slowest = Math.max(record.slowest, took);
    if (response.status === 200) {
      record.answered += 1;
      record.settled = true;
    } else if (response.status === 503 && text.startsWith("loading") && coldAtStart) {
      // The cold hub: no snapshot had been published when the request left.
    } else if (!(record.pending.includes(response.status) && !record.settled)) {
      record.wrong.push(`${response.status} ${text.slice(0, 80)}`);
    }
    return text;
  };

  const dataRoutes = { pending: [404] };
  const conversationRoutes = { pending: [503] };
  let asset: string | undefined;
  let messageId: string | undefined;
  let largestLag = 0;
  type HealthProbe = { at: number; lag_ms: number | null; sources: Record<string, PassHealth> };
  const healthProbes: HealthProbe[] = [];
  const hubLines: { at: number; text: string }[] = [];
  let outputRead = 0;
  const firstEnds = new Map<string, number>();
  const lastEnds = new Map<string, number>();
  const run = encodeURIComponent(openRun);
  const base = `/api/run/${run}`;
  const plannedProbes = [
    "GET /",
    "GET /assets/*",
    "GET /api/snapshot",
    "GET /api/resources/history",
    "GET /api/companions",
    "GET /api/health",
    "GET /api/conversation",
    "GET /api/conversation/message/*",
    "GET /api/run/<open>",
    "GET /api/run/<closed>",
    "GET /api/run/<open>/conversation",
    "GET /api/run/<open>/transcript",
    "GET /api/run/<open>/transcript/result",
    "GET /api/run/<open>/file",
    "GET /api/run/<open>/evidence",
    "GET /api/run/<open>/image",
    "GET /api/ticket/<project>/<ticket>",
    "GET /api/ticket/<project>/<ticket>/cases",
    "POST /api/open-in-orca",
  ];
  const soakStartEpoch = Date.now();
  const soakStart = performance.now();
  const deadline = soakStart + soakMilliseconds;
  while (performance.now() < deadline) {
    const index = await probe("GET /", "/");
    asset ??= /\/assets\/[^"'\s)]+/.exec(index)?.[0];
    if (asset) await probe("GET /assets/*", asset);
    await probe("GET /api/snapshot", "/api/snapshot");
    await probe("GET /api/resources/history", "/api/resources/history");
    await probe("GET /api/companions", "/api/companions");
    const healthText = await probe("GET /api/health", "/api/health");
    const probeAt = Math.round(performance.now() - soakStart);
    let answer: Health | undefined;
    try {
      answer = JSON.parse(healthText) as Health;
    } catch {
      // The probe already recorded the status.
    }
    healthProbes.push({
      at: probeAt,
      lag_ms: answer?.lag_ms ?? null,
      sources: answer?.sources ?? {},
    });
    largestLag = Math.max(largestLag, answer?.lag_ms ?? 0);
    // The hub output since the previous probe, whole lines only, each stamped with this probe's time.
    const output = hub.output();
    const wholeEnd = output.lastIndexOf("\n") + 1;
    if (wholeEnd > outputRead) {
      for (const text of output.slice(outputRead, wholeEnd).split("\n"))
        if (text.length > 0) hubLines.push({ at: probeAt, text });
      outputRead = wholeEnd;
    }
    for (const [name, sourcePass] of Object.entries(answer?.sources ?? {})) {
      const ended = endedAt(sourcePass);
      if (ended === null) continue;
      if (!firstEnds.has(name)) firstEnds.set(name, ended);
      lastEnds.set(name, ended);
    }
    const since = encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString());
    const until = encodeURIComponent(new Date(Date.now() + 60_000).toISOString());
    const conversation = await probe(
      "GET /api/conversation",
      `/api/conversation?since=${since}&until=${until}`,
      conversationRoutes,
    );
    try {
      const reply = JSON.parse(conversation) as {
        runs?: { messages?: { id: string }[] }[];
        other?: { messages?: { id: string }[] };
      };
      messageId ??= [
        ...(reply.runs ?? []).flatMap((entry) => entry.messages ?? []),
        ...(reply.other?.messages ?? []),
      ][0]?.id;
    } catch {
      // Not read yet: 503 text.
    }
    if (messageId)
      await probe("GET /api/conversation/message/*", `/api/conversation/message/${messageId}`);
    await probe("GET /api/run/<open>", base);
    await probe("GET /api/run/<closed>", `/api/run/${encodeURIComponent(fixture.closedRun)}`);
    await probe("GET /api/run/<open>/conversation", `${base}/conversation`, conversationRoutes);
    const file = encodeURIComponent(fixture.transcriptFile);
    await probe(
      "GET /api/run/<open>/transcript",
      `${base}/transcript?file=${file}&cursor=0`,
      dataRoutes,
    );
    await probe(
      "GET /api/run/<open>/transcript/result",
      `${base}/transcript/result?file=${file}&call=call1`,
      dataRoutes,
    );
    await probe("GET /api/run/<open>/file", `${base}/file?path=ticket.md`);
    await probe("GET /api/run/<open>/evidence", `${base}/evidence`);
    await probe(
      "GET /api/run/<open>/image",
      `${base}/image?path=${encodeURIComponent("results/evidence/ARK-T1/head/shot.png")}`,
    );
    await probe("GET /api/ticket/<project>/<ticket>", `/api/ticket/${project}/ARK-840`, dataRoutes);
    await probe(
      "GET /api/ticket/<project>/<ticket>/cases",
      `/api/ticket/${project}/ARK-840/cases`,
      dataRoutes,
    );
    await probe("POST /api/open-in-orca", "/api/open-in-orca", {
      method: "POST",
      body: JSON.stringify({ terminal: "term-0" }),
      pending: [400],
    });
  }

  const results = [...probes.values()];
  // Every planned probe was built: a fixture that cannot supply a message id or an asset fails here, by name.
  expect(
    plannedProbes.filter((label) => !probes.has(label)),
    "planned probes never built",
  ).toEqual([]);
  // Every route answered, within 1 s at every probe, with the status of a valid request.
  expect(
    results.filter((entry) => entry.answered === 0).map((entry) => entry.label),
    "routes that never answered 200",
  ).toEqual([]);
  expect(
    results
      .filter((entry) => entry.wrong.length > 0)
      .map((entry) => `${entry.label}: ${entry.wrong[0]}`),
    "routes with a wrong status",
  ).toEqual([]);
  expect(
    results
      .filter((entry) => entry.slowest > answerLimitMilliseconds)
      .map(
        (entry) =>
          `${entry.label}: ${Math.round(entry.slowest)} ms at request ${entry.slowestRequest} of ${entry.count}`,
      ),
    "routes slower than 1 s",
  ).toEqual([]);
  // The window of the largest lag, built on every run from every probe the soak kept: the message is the
  // failure text of the lag assert, so a failing run names the work that ran in the window (ARK-602/AC1).
  // Loaded here because the helper is test support of this file and ARK-T730 only. The specifier is a variable
  // so that the typecheck does not need the module to exist when the tests are written first.
  const helperPath = "./hub-stall-window";
  const { windowMessage } = (await import(helperPath)) as {
    windowMessage: (
      probes: HealthProbe[],
      lines: { at: number; text: string }[],
      startEpoch: number,
    ) => string;
  };
  const lagMessage = windowMessage(healthProbes, hubLines, soakStartEpoch);
  const soakElapsed = performance.now() - soakStart;
  expect(healthProbes.length, "health probes kept").toBe(probes.get("GET /api/health")!.count);
  expect(
    healthProbes.every((entry, index) => index === 0 || entry.at >= healthProbes[index - 1]!.at),
    "probe times never decrease",
  ).toBe(true);
  const largestLagProbe = healthProbes.find((entry) => (entry.lag_ms ?? 0) === largestLag);
  expect(largestLagProbe, "a probe holds the largest lag").toBeDefined();
  expect(
    largestLagProbe!.at >= 0 && largestLagProbe!.at <= soakElapsed,
    "largest lag probe time",
  ).toBe(true);
  if (largestLag > 0) expect(lagMessage).toContain(String(largestLag));
  else expect(lagMessage).toMatch(/no lag/i);
  // No pass held the loop for more than 200 ms, as the hub reports it.
  expect(largestLag <= lagLimitMilliseconds, lagMessage).toBe(true);
  // Speed was not bought by stopping the readers: every reader ended a pass and then another one.
  for (const sourceName of Object.keys(sourceAffects)) {
    expect(lastEnds.has(sourceName), `${sourceName} ended no pass`).toBe(true);
    expect(
      lastEnds.get(sourceName)! > firstEnds.get(sourceName)!,
      `${sourceName} ended one pass in 120 s`,
    ).toBe(true);
  }
  // Nor by dropping data: a cost is the fixture's or unknown, never a smaller number.
  const snapshot = await snapshotOf(hub);
  if (snapshot.runs !== "unknown")
    for (const name of fixture.pricedRuns) {
      const cost = snapshot.runs.find((view) => view.run === name)?.cost_usd;
      expect(
        cost === null || (cost ?? 0) >= messagesPerFile * costPerMessage,
        `${name} cost ${cost}`,
      ).toBe(true);
    }
  hub.child.kill("SIGTERM");
  await hub.exited;
}, 150_000);

// ---------------------------------------------------------------- ARK-T734 and ARK-T735

/** Open runs and workers for each run of ARK-T734: at this size the unfixed `readOrca` pass adds over 150 ms to the control's lag. */
const largeRunCount = 100;
/** The rows of `run-list`: this host's Orca lists 273 runs, of which 4 are open Ark runs. */
const largeListRows = 273;
const largeWorkerCount = 20;
/** The `--limit 200` of the inbox read of `readOrca`. */
const largeInboxCount = 200;

const stepRoles = ["implementer", "validator", "reviewer"];
const chiefOrcaRun = {
  id: "orca-chief-p",
  objective: `Master Chief: ${project} tickets`,
  coordinator_handle: "term-chief",
};
const emptyWorkers = JSON.stringify({ result: { workers: [] } });

type ShownAgent = {
  role: string;
  step: string | null;
  title: string;
  terminal: string | null;
  presence: string;
};
type Shown = {
  agents: ShownAgent[];
  waiting: { step: string | null; reason: string; since: string }[];
};

/**
 * The answers of the fake `orca` for open runs `runs`, with the agents and waits that `readOrca` must make of them,
 * written out here from the fixture alone. Each open run has an Orca run, a connected run lead and `workers` workers
 * (every third one released, every other terminal connected). The inbox holds `messages` unread messages, each from
 * a worker to the run lead of one run, in turn. With `edges`, the last run has no Orca run and the one before it has
 * no worker. With `perRun`, each run has its own workers and tasks (else every run shares one list).
 */
function orcaHome(options: {
  runs: string[];
  workers: number;
  messages: number;
  perRun?: boolean;
  edges?: boolean;
  /** Rows of `run-list`: closed runs' Orca runs pad the list to this many, as the real list holds every run ever started. */
  listRows?: number;
}) {
  const { runs, workers, messages, perRun = false, edges = false, listRows = 0 } = options;
  const runsWithWorkers = edges ? runs.slice(0, -2) : runs;
  const orcaRunOf = (run: string) => `orca-${run}`;
  // The name of run `runIndex`'s workers: the same for every run unless `perRun`.
  const ownerOf = (runIndex: number) => (perRun ? runIndex : 0);
  const owners = perRun ? runsWithWorkers.map((_, runIndex) => runIndex) : [0];
  const indexes = Array.from({ length: workers }, (_, index) => index);
  const released = (worker: number) => worker % 3 === 2;
  const titleOf = (owner: number, worker: number) =>
    `s${owner}-${worker} (${stepRoles[worker % 3]}, .)`;
  const workerRows = (owner: number) =>
    indexes.map((worker) => ({
      dispatchId: `d-${owner}-${worker}`,
      terminal: `w-${owner}-${worker}`,
      agentTerminalHandle: `w-${owner}-${worker}`,
      taskId: `t-${owner}-${worker}`,
      state: released(worker) ? "released" : "running",
      projection: {
        provider: { model: "claude-sonnet" },
        liveness: { verdict: released(worker) ? "dead" : "live" },
      },
    }));
  const terminals = [
    { handle: "term-chief", connected: true, agentIdentity: "omp" },
    ...runs.map((_, runIndex) => ({
      handle: `lead-${runIndex}`,
      connected: true,
      agentIdentity: "omp",
    })),
    ...owners.flatMap((owner) =>
      indexes
        .filter((worker) => worker % 2 === 0)
        .map((worker) => ({
          handle: `w-${owner}-${worker}`,
          connected: true,
          agentIdentity: "omp",
        })),
    ),
  ];
  const tasks = owners.flatMap((owner) =>
    indexes.map((worker) => ({ id: `t-${owner}-${worker}`, title: titleOf(owner, worker) })),
  );
  // Message `number` goes to the run lead of run `(number + 1) % runsWithWorkers.length`, from one of that run's workers.
  const messageRows = Array.from({ length: messages }, (_, number) => {
    const runIndex = (number + 1) % runsWithWorkers.length;
    const worker = (number * 7) % workers;
    const owner = ownerOf(runIndex);
    return {
      runIndex,
      worker,
      owner,
      row: {
        id: `m-${number}`,
        type: number % 2 === 0 ? "question" : "escalation",
        from_handle: number % 2 === 0 ? `dispatch:d-${owner}-${worker}` : `w-${owner}-${worker}`,
        to_handle: `run:${orcaRunOf(runs[runIndex]!)}`,
        subject: `subject ${number}`,
        body: "",
        read: 0,
        created_at: new Date(Date.UTC(2026, 10, 20) + number * 1000).toISOString(),
      },
    };
  });
  const orcaRuns = (edges ? runs.slice(0, -1) : runs).map((run, runIndex) => ({
    id: orcaRunOf(run),
    objective: `Ark run ${run}`,
    coordinator_handle: `lead-${runIndex}`,
  }));
  const closedRuns = Array.from(
    { length: Math.max(0, listRows - orcaRuns.length - 1) },
    (_, number) => ({
      id: `orca-closed-${number}`,
      objective: `Ark run closed-${number}`,
      coordinator_handle: `lead-closed-${number}`,
    }),
  );
  return {
    chiefId: chiefOrcaRun.id,
    orcaRunOf,
    terminals: JSON.stringify({ result: { terminals } }),
    inbox: JSON.stringify({ result: { messages: messageRows.map((message) => message.row) } }),
    runList: JSON.stringify({ result: { runs: [...orcaRuns, ...closedRuns, chiefOrcaRun] } }),
    chiefOnlyRunList: JSON.stringify({ result: { runs: [chiefOrcaRun] } }),
    tasks,
    /** The files that answer for Master Chief and for the run with no worker: empty lists. */
    light: {
      [`orca.workers.${chiefOrcaRun.id}`]: emptyWorkers,
      ...(edges ? { [`orca.workers.${orcaRunOf(runs.at(-2)!)}`]: emptyWorkers } : {}),
    } as Record<string, string>,
    /** The files that carry the load: the workers of the runs, and the tasks. */
    load: {
      ...(perRun
        ? Object.fromEntries(
            runsWithWorkers.map((run, runIndex) => [
              `orca.workers.${orcaRunOf(run)}`,
              JSON.stringify({ result: { workers: workerRows(runIndex) } }),
            ]),
          )
        : { "orca.workers": JSON.stringify({ result: { workers: workerRows(0) } }) }),
      "orca.tasks": JSON.stringify({ result: { tasks } }),
    } as Record<string, string>,
    /** What the snapshot shows for run `runIndex`, by the rules of `agentsOf` and `readOrca`. */
    expected(runIndex: number): Shown {
      if (edges && runIndex === runs.length - 1) return { agents: [], waiting: [] };
      const lead: ShownAgent[] = [
        {
          role: "Master Chief",
          step: null,
          title: chiefOrcaRun.objective,
          terminal: "term-chief",
          presence: "live",
        },
        {
          role: "run lead",
          step: null,
          title: `Ark run ${runs[runIndex]}`,
          terminal: `lead-${runIndex}`,
          presence: "live",
        },
      ];
      if (runIndex >= runsWithWorkers.length) return { agents: lead, waiting: [] };
      const owner = ownerOf(runIndex);
      return {
        agents: [
          ...lead,
          ...indexes.map((worker) => ({
            role: stepRoles[worker % 3]!,
            step: `s${owner}-${worker}`,
            title: titleOf(owner, worker),
            terminal: `w-${owner}-${worker}`,
            presence: released(worker) ? "ended" : worker % 2 === 0 ? "live" : "running",
          })),
        ],
        waiting: messageRows
          .filter((message) => message.runIndex === runIndex && !released(message.worker))
          .map((message) => ({
            step: `s${message.owner}-${message.worker}`,
            reason: `${message.row.type === "question" ? "asked the run lead" : "blocked"}: ${message.row.subject}`,
            since: message.row.created_at,
          })),
      };
    },
  };
}

/** A state file of the fake `orca`, written to a temporary name and renamed into place so that a read never sees half a file. */
function place(fake: Stage, file: string, text: string): void {
  fake.set(`${file}.next`, text);
  renameSync(join(fake.state, `${file}.next`), join(fake.state, file));
}

/** The run as the page shows it: the fields ARK-T734 and ARK-T735 compare. */
function shownOf(snapshot: Snapshot, run: string): Shown {
  const view =
    snapshot.runs === "unknown" ? undefined : snapshot.runs.find((entry) => entry.run === run);
  if (!view || view.agents === "unknown") throw new Error(`the snapshot has no agents for ${run}`);
  return {
    agents: view.agents.map(({ role, step, title, terminal, presence }) => ({
      role,
      step,
      title,
      terminal,
      presence,
    })),
    waiting: view.waiting,
  };
}

/** What the large orca pass may add to the largest lag of the control phase on the same hub (ARK-606/AC1). */
const orcaLagAddedLimitMilliseconds = 150;

test("ARK-T734 On a hub whose fake orca answers one pass with many open runs, many workers each and a full inbox, the largest health lag of the large pass and of the compose and publish after it is at most 150 ms over the largest lag of a control phase on the same hub, and the snapshot holds every agent and wait the fixture names", async () => {
  const fake = stage();
  const runs = Array.from({ length: largeRunCount }, (_, number) => {
    const run = `${today()}-ARK-${3000 + number}-1`;
    writeRun({
      project,
      run,
      ticket: { id: `ARK-${3000 + number}`, title: `Large ${number}` },
      phase: "building",
    });
    return run;
  });
  const home = orcaHome({
    runs,
    workers: largeWorkerCount,
    messages: largeInboxCount,
    edges: true,
    listRows: largeListRows,
  });

  // Step 1: the control. Only Master Chief's Orca run, so the pass makes its four calls and parses one inbox.
  fake.set("orca.terminals", home.terminals);
  fake.set("orca.inbox", home.inbox);
  for (const [file, text] of Object.entries(home.light)) fake.set(file, text);
  fake.set("orca.runs", home.chiefOnlyRunList);
  const hub = await startHub({ interval: 2000 });
  const page = openPage(hub);
  const prober = healthProber(hub, { caseId: "ARK-T734", sources: ["orca"] });

  // Steps 2 and 3: two passes with no orca load; their largest lag is what the home and the host cost alone.
  await prober.untilPasses(2);
  const controlLag = prober.largestLag();
  const loadFrom = prober.probeCount();

  // Step 4: the load enters; the full run list is renamed last, so a pass that reads it finds the workers in place.
  for (const [file, text] of Object.entries(home.load)) place(fake, file, text);
  place(fake, "orca.runs", home.runList);
  let first: Snapshot | undefined;
  while (!first) {
    await prober.probe();
    const latest = page.latest();
    if (latest && Array.isArray(latest.runs)) {
      const view = latest.runs.find((entry) => entry.run === runs[0]);
      if (view && view.agents !== "unknown" && view.agents.length > 0) first = latest;
    }
  }
  await prober.untilPasses(2);
  await prober.probe(); // the sample of the publish that follows the last pass end

  // Step 5: the first large push and the last snapshot hold what the fixture names, in order.
  const last = await snapshotOf(hub);
  for (const [label, snapshot] of [
    ["first", first],
    ["last", last],
  ] as const)
    for (const [runIndex, run] of runs.entries())
      expect(shownOf(snapshot, run), `${label} snapshot, ${run}`).toEqual(home.expected(runIndex));
  expect(last.sources.orca.ok, "sources.orca.ok in the last snapshot").toBe(true);

  // Step 6: the large pass adds at most the limit to the control's lag (the health lag reads the last 60 s).
  const largeLag = prober.largestLag(loadFrom);
  expect(
    largeLag <= controlLag + orcaLagAddedLimitMilliseconds,
    `control lag ${controlLag} ms, large pass lag ${largeLag} ms, added ${largeLag - controlLag} ms, limit ${orcaLagAddedLimitMilliseconds} ms: ${prober.message()}`,
  ).toBe(true);
  hub.child.kill("SIGTERM");
  await hub.exited;
}, 90_000);

test("ARK-T735 When the fake orca fails run-list, inbox, or worker-list or task-list of one open run, the orca pass returns no value, the source reads not ok, and the snapshot keeps the last agents and waits of every run; when only Master Chief's worker-list fails, the pass stays ok and loses only the run lead it alone listed", async () => {
  const fake = stage();
  const runs = threeRuns();
  const home = orcaHome({ runs, workers: 2, messages: 1, perRun: true });
  // Run 2: its lead terminal is not connected in `terminal list`; Master Chief's worker-list lists the lead as a live worker.
  const lead = "lead-1";
  const terminals = JSON.parse(home.terminals).result.terminals as { handle: string }[];
  fake.set(
    "orca.terminals",
    JSON.stringify({
      result: { terminals: terminals.filter((terminal) => terminal.handle !== lead) },
    }),
  );
  fake.set("orca.inbox", home.inbox);
  fake.set("orca.runs", home.runList);
  for (const [file, text] of Object.entries({ ...home.light, ...home.load })) fake.set(file, text);
  fake.set(
    `orca.workers.${home.chiefId}`,
    JSON.stringify({
      result: {
        workers: [
          {
            dispatchId: "d-lead",
            terminal: lead,
            state: "running",
            projection: { liveness: { verdict: "live" } },
          },
        ],
      },
    }),
  );
  const hub = await startHub({ interval: 2000 });
  openPage(hub);
  const prober = healthProber(hub, { caseId: "ARK-T735", sources: ["orca"] });
  const read = async (): Promise<{ ok: boolean; shown: Shown[] }> => {
    await prober.untilPasses(2);
    const answer = await prober.probe();
    expect(answer.sources.orca?.last_ms, "a failed pass is still a pass").not.toBeNull();
    expect(answer.sources.orca?.ended_at).not.toBeNull();
    const snapshot = await snapshotOf(hub);
    return { ok: snapshot.sources.orca.ok, shown: runs.map((run) => shownOf(snapshot, run)) };
  };

  // Step 1: the good answer. Run 2 holds a run lead listed only by Master Chief, and its question.
  const good = await read();
  expect(good.ok).toBe(true);
  expect(good.shown[1]!.agents.find((agent) => agent.role === "run lead")?.presence).toBe(
    "running",
  );
  expect(good.shown[1]!.waiting.length).toBe(1);

  // Steps 2 to 5: one failing call; the page keeps the last answer.
  for (const line of [
    `worker-list ${home.orcaRunOf(runs[1]!)}`,
    `task-list ${home.orcaRunOf(runs[1]!)}`,
    "run-list",
    "inbox",
  ]) {
    fake.set("orca.fail", `${line}\n`);
    const failed = await read();
    expect(failed.ok, `${line}: sources.orca.ok`).toBe(false);
    expect(failed.shown, `${line}: the last agents and waits`).toEqual(good.shown);
  }

  // Step 6: Master Chief's worker-list fails; the pass stays ok and run 2 loses only the lead nothing else lists.
  fake.set("orca.fail", `worker-list ${home.chiefId}\n`);
  const chiefDown = await read();
  expect(chiefDown.ok).toBe(true);
  expect(chiefDown.shown).toEqual(
    good.shown.map((entry, index) =>
      index === 1
        ? { ...entry, agents: entry.agents.filter((agent) => agent.role !== "run lead") }
        : entry,
    ),
  );

  // Step 7: the call works again with changed data: the lead is back and one title shows its note.
  fake.remove("orca.fail");
  const changed = home.tasks.map((task) =>
    task.id === "t-2-1" ? { ...task, title: "s2-1 retry (validator, .)" } : task,
  );
  fake.set("orca.tasks", JSON.stringify({ result: { tasks: changed } }));
  const recovered = await read();
  expect(recovered.ok).toBe(true);
  expect(recovered.shown).toEqual(
    good.shown.map((entry, index) =>
      index === 2
        ? {
            ...entry,
            agents: entry.agents.map((agent) =>
              agent.step === "s2-1" ? { ...agent, title: "s2-1 retry (validator, .)" } : agent,
            ),
          }
        : entry,
    ),
  );
  hub.child.kill("SIGTERM");
  await hub.exited;

  // Steps 8 and 9: worker-list answers no result, so orcaPages throws inside the orca worker.
  // The throw must become a null pass (source not ok) and the hub must keep serving.
  const manyRuns = Array.from({ length: 150 }, (_, number) => {
    const run = `${today()}-ARK-${4000 + number}-1`;
    writeRun({
      project,
      run,
      ticket: { id: `ARK-${4000 + number}`, title: `Many ${number}` },
      phase: "building",
    });
    return run;
  });
  const many = orcaHome({ runs: manyRuns, workers: 1, messages: 1, perRun: true });
  fake.set("orca.terminals", many.terminals);
  fake.set("orca.inbox", many.inbox);
  for (const [file, text] of Object.entries({ ...many.light, ...many.load })) fake.set(file, text);
  fake.set("orca.runs", many.runList);
  fake.set("orca.null", manyRuns.map((run) => `worker-list ${many.orcaRunOf(run)}\n`).join(""));
  const noResultHub = await startHub({ interval: 2000 });
  openPage(noResultHub);
  await healthProber(noResultHub, { caseId: "ARK-T735", sources: ["orca"] }).untilPasses(2);
  expect(
    (await snapshotOf(noResultHub)).sources.orca.ok,
    "worker-list with no result: sources.orca.ok",
  ).toBe(false);
  noResultHub.child.kill("SIGTERM");
  await noResultHub.exited;
}, 60_000);
