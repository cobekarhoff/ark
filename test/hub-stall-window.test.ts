// ARK-602/AC1, ARK-T730: the window of the largest loop lag and the message that ARK-T699 fails with.
// The helper `test/hub-stall-window.ts` is loaded inside each test, so an example fails alone while the
// module is missing and the rest of the file loads. Pure data: no hub, no clock, no timer.
import { expect, setDefaultTimeout, test } from "bun:test";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(60_000);

type SourcePass = { last_ms: number | null; ended_at: string | null; slow: boolean };
type Probe = { at: number; lag_ms: number | null; sources: Record<string, SourcePass> };
type HubLine = { at: number; text: string };
type WindowMessage = (probes: Probe[], lines: HubLine[], startEpoch: number) => string;

const startEpoch = 1_800_000_000_000;
const iso = (milliseconds: number): string => new Date(startEpoch + milliseconds).toISOString();
const pass = (endedMilliseconds: number, lastMilliseconds: number): SourcePass => ({
  last_ms: lastMilliseconds,
  ended_at: iso(endedMilliseconds),
  slow: false,
});
const noPass: SourcePass = { last_ms: null, ended_at: null, slow: false };
const probe = (
  at: number,
  lag: number | null,
  sources: Record<string, SourcePass> = {},
): Probe => ({
  at,
  lag_ms: lag,
  sources,
});

async function messageOf(probes: Probe[], lines: HubLine[] = []): Promise<string> {
  // The specifier is a variable so that the typecheck does not need the module while the tests come first.
  const helperPath = "./hub-stall-window";
  const module = (await import(helperPath)) as { windowMessage: WindowMessage };
  return module.windowMessage(probes, lines, startEpoch);
}

/** The lines of the message that name a source: one source for each line. */
const linesNaming = (message: string, name: string): string[] =>
  message.split("\n").filter((line) => line.includes(name));

test("ARK-T730 The window runs from the probe before the first probe that reported the largest lag, and names the sources, the pass times and the hub lines in it", async () => {
  const message = await messageOf(
    [
      probe(0, 20),
      probe(5000, 20),
      probe(10_000, 240, { usage: pass(7000, 180), github: pass(2000, 90) }),
      probe(15_000, 240, {
        usage: pass(7000, 180),
        github: pass(2000, 90),
        claude: pass(12_000, 3),
      }),
    ],
    [
      { at: 8000, text: "WINDOWLINE-inside" },
      { at: 13_000, text: "WINDOWLINE-outside" },
    ],
  );
  expect(message).toContain("240");
  expect(message).toContain("10000");
  const usage = linesNaming(message, "usage");
  expect(usage, message).toHaveLength(1);
  expect(usage[0]).toContain("180");
  expect(usage[0]).toContain("7000");
  expect(message, "github ran 1910 to 2000, outside the window").not.toContain("github");
  expect(message, "claude ran 11997 to 12000, outside the window").not.toContain("claude");
  expect(message).toContain("WINDOWLINE-inside");
  expect(message).not.toContain("WINDOWLINE-outside");
  expect(message, "a source and a hub line were found").not.toMatch(/no source|no hub line/i);
});

test("ARK-T730 A source that passed twice is named for its pass in the window, not for the earlier one", async () => {
  const message = await messageOf([
    probe(0, 0),
    probe(5000, 0, { usage: pass(4000, 180), github: pass(4000, 90) }),
    probe(10_000, 252, { usage: pass(9000, 60), github: pass(4000, 90) }),
  ]);
  const usage = linesNaming(message, "usage");
  expect(usage, message).toHaveLength(1);
  expect(usage[0]).toContain("60");
  expect(usage[0]).toContain("9000");
  expect(message, "the earlier usage pass ran 3820 to 4000").not.toContain("180");
  expect(message, "github ran 3910 to 4000").not.toContain("github");
});

test("ARK-T730 A lag that the hub reports again 60 s later does not move the window", async () => {
  const message = await messageOf([
    probe(0, 10),
    probe(5000, 10),
    probe(10_000, 226, { usage: pass(7000, 50) }),
    probe(70_000, 226, { usage: pass(7000, 50), github: pass(65_000, 50) }),
  ]);
  expect(message).toContain("226");
  expect(message).toContain("10000");
  expect(message).not.toContain("70000");
  expect(linesNaming(message, "usage"), message).toHaveLength(1);
  expect(message, "github ended at 65000, in the window of the repeat").not.toContain("github");
});

test("ARK-T730 A lag that no source and no hub line explains still prints both sections, and a pass that ended before the soak is not named", async () => {
  const message = await messageOf([
    probe(0, 10),
    probe(5000, 244, { zzidle: noPass, zzearly: pass(-1000, 40) }),
  ]);
  expect(message).toContain("244");
  expect(message).toContain("5000");
  expect(message).toMatch(/no source/i);
  expect(message).toMatch(/no hub line/i);
  expect(message).not.toContain("zzidle");
  expect(message).not.toContain("zzearly");
});

test("ARK-T730 With no probe before the largest lag the window starts at 0, and a pass ending at the window start is named", async () => {
  const message = await messageOf([probe(0, 300, { usage: pass(0, 40) })]);
  expect(message).toContain("300");
  expect(linesNaming(message, "usage"), message).toHaveLength(1);
});

test("ARK-T730 Of two spikes of the same value the first one wins", async () => {
  const message = await messageOf([
    probe(0, 10),
    probe(5000, 300, { usage: pass(3000, 50) }),
    probe(10_000, 20, { usage: pass(3000, 50) }),
    probe(15_000, 300, { usage: pass(3000, 50), github: pass(12_000, 50) }),
    probe(20_000, 10, { usage: pass(3000, 50), github: pass(12_000, 50) }),
  ]);
  expect(message).toContain("5000");
  expect(linesNaming(message, "usage"), message).toHaveLength(1);
  expect(message, "github ended in the window of the second spike").not.toContain("github");
});

test("ARK-T730 When no probe has a lag the message says there was no lag", async () => {
  for (const lag of [null, 0]) {
    const message = await messageOf([probe(0, lag), probe(5000, lag)]);
    expect(message).toMatch(/no lag/i);
  }
});

test("ARK-T730 A pass that ran in the window and ended after it is named", async () => {
  const message = await messageOf([
    probe(0, 20),
    probe(5000, 20),
    probe(10_000, 240),
    probe(15_000, 240, { batch: pass(12_000, 5000), claude: pass(12_000, 3) }),
  ]);
  const batch = linesNaming(message, "batch");
  expect(batch, message).toHaveLength(1);
  expect(batch[0]).toContain("5000");
  expect(batch[0]).toContain("12000");
  expect(message, "claude ran 11997 to 12000").not.toContain("claude");
});
