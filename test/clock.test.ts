import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { now } from "../cli/clock.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

const original = process.env.ARK_NOW;
afterEach(() => {
  if (original === undefined) delete process.env.ARK_NOW;
  else process.env.ARK_NOW = original;
});

test("ARK_NOW freezes the clock to an ISO instant", () => {
  process.env.ARK_NOW = "2026-11-02T00:00:00Z";
  expect(now()).toBe(Date.parse("2026-11-02T00:00:00Z"));
});

test("without ARK_NOW the clock is real time", () => {
  delete process.env.ARK_NOW;
  expect(Math.abs(now() - Date.now())).toBeLessThan(1000);
});

test("an ARK_NOW that is not an instant throws", () => {
  process.env.ARK_NOW = "yesterday";
  expect(() => now()).toThrow("ARK_NOW must be an ISO instant");
});
