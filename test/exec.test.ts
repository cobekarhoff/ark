import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { exec, execJson, execResult, failureReason } from "../cli/exec";
import { orcaRead } from "../cli/orca";
import { writeFakeCommand } from "./helpers";

setDefaultTimeout(30_000);

const originalPath = process.env.PATH;
const originalReaderLimit = process.env.ARK_READER_TIMEOUT_MS;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalReaderLimit === undefined) delete process.env.ARK_READER_TIMEOUT_MS;
  else process.env.ARK_READER_TIMEOUT_MS = originalReaderLimit;
});

/** Sets (or deletes) the variable, then starts `call` at once, so a default argument reads that value; resolves with the result and the seconds it took. */
function startedWith<Result>(limit: string | undefined, call: () => Promise<Result>) {
  if (limit === undefined) delete process.env.ARK_READER_TIMEOUT_MS;
  else process.env.ARK_READER_TIMEOUT_MS = limit;
  const start = performance.now();
  return call().then((result) => ({ result, seconds: (performance.now() - start) / 1000 }));
}

const sleepThen = (seconds: number, output: string) => [
  "/bin/sh",
  "-c",
  `sleep ${seconds}; echo '${output}'`,
];

test("ARK-T686 the readers take their limit from ARK_READER_TIMEOUT_MS at each call, and an unset or invalid value keeps 2 s", async () => {
  // `orca orchestration probe <seconds> --json` answers after <seconds>.
  writeFakeCommand("orca", `sleep "$3"\necho '{"result":{"ok":true}}'`);
  const invalid = ["", "abc", "0", "-5", "NaN", "Infinity", "2147483648"];
  // `exec` was imported before any value was set. No call is awaited before the next starts, so the case takes about 2.5 s.
  const raised = [
    startedWith("30000", () => exec(sleepThen(2.5, "done"))),
    startedWith("30000", () => execJson(sleepThen(2.5, '{"ok":true}'))),
    startedWith("30000", () => execResult(sleepThen(2.5, "done"))),
    startedWith("30000", () => orcaRead(["probe", "2.5"])),
  ] as const;
  const unset = [
    startedWith(undefined, () => exec(sleepThen(6, "done"))),
    startedWith(undefined, () => execJson(sleepThen(6, '{"ok":true}'))),
    startedWith(undefined, () => execResult(sleepThen(6, "done"))),
    startedWith(undefined, () => orcaRead(["probe", "6"])),
  ] as const;
  const one = [
    startedWith("1000", () => exec(sleepThen(6, "done"))),
    startedWith("1000", () => execResult(sleepThen(6, "done"))),
    startedWith("1000", () => orcaRead(["probe", "6"])),
  ] as const;
  const junk = invalid.map((value) => startedWith(value, () => exec(sleepThen(6, "done"))));
  const explicit = startedWith("30000", () => exec(sleepThen(2.5, "done"), 300));

  const [raisedExec, raisedJson, raisedResult, raisedOrca] = await Promise.all(raised);
  expect(raisedExec.result).toBe("done\n");
  expect(raisedJson.result).toEqual({ ok: true });
  expect(raisedResult.result).toMatchObject({ code: 0, stdout: "done\n", timedOut: false });
  expect(raisedOrca.result).toEqual({ ok: true, value: { ok: true } });

  const [unsetExec, unsetJson, unsetResult, unsetOrca] = await Promise.all(unset);
  expect(unsetExec.result).toBeNull();
  expect(unsetJson.result).toBeNull();
  expect(unsetResult.result.timedOut).toBe(true);
  expect(unsetOrca.result).toEqual({ ok: false, reason: "timed out after 2 s" });

  const [oneExec, oneResult, oneOrca] = await Promise.all(one);
  expect(oneExec.result).toBeNull();
  expect(oneResult.result.timedOut).toBe(true);
  expect(oneOrca.result).toEqual({ ok: false, reason: "timed out after 1 s" });

  const junkRows = await Promise.all(junk);
  expect(junkRows.map((row) => row.result)).toEqual(invalid.map(() => null));

  const explicitRow = await explicit;
  expect(explicitRow.result).toBeNull();

  // A limit cuts after about its length: not at once (1 ms) and not at the end of the 6 s command.
  for (const row of [unsetExec, unsetJson, unsetResult, unsetOrca, ...junkRows])
    expect(row.seconds).toBeWithin(1.9, 5);
  for (const row of [oneExec, oneResult, oneOrca]) expect(row.seconds).toBeWithin(0.9, 2);
  expect(explicitRow.seconds).toBeLessThan(1.5);
});

test("a command killed by another signal keeps its stderr reason and is not a timeout", async () => {
  const result = await execResult(
    ["/bin/sh", "-c", "echo connection-lost >&2; kill -TERM $$"],
    10_000,
  );
  expect(result.timedOut).toBe(false);
  expect(failureReason(result, 10_000)).toBe("connection-lost");
});

test("a command that outlives the deadline is a timeout", async () => {
  const result = await execResult(["/bin/sh", "-c", "sleep 30"], 200);
  expect(result.timedOut).toBe(true);
});
