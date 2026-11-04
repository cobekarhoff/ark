import { expect, setDefaultTimeout, test } from "bun:test";
import { execResult, failureReason } from "../cli/exec";

setDefaultTimeout(30_000);

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
