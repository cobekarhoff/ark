import { expect, setDefaultTimeout, test } from "bun:test";
import { hostLevels, readHost, type HostReaders } from "../cli/host.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

// ARK-T289: the readers of `readHost` are faked at their boundary, so no value comes from the real host.
const healthy: HostReaders = {
  memory: async () => ({ freeMemoryPercent: 50, swapUsedGigabytes: 1, swapTotalGigabytes: 4 }),
  pressureLevel: () => 1,
  loadAverages: () => [1, 1, 1],
  cores: () => 10,
  cpuPercent: () => 12.5,
  freeGigabytesOf: () => 100,
};

const levelsOf = async (overrides: Partial<HostReaders>) =>
  hostLevels(await readHost({ ...healthy, ...overrides }));

const swapOf = (gigabytes: number): Partial<HostReaders> => ({
  memory: async () => ({
    freeMemoryPercent: 50,
    swapUsedGigabytes: gigabytes,
    swapTotalGigabytes: 16,
  }),
});
/** The disk level reads `/`; the volume of ARK_HOME is a different reading and stays healthy. */
const rootDiskOf = (gigabytes: number): Partial<HostReaders> => ({
  freeGigabytesOf: (path) => (path === "/" ? gigabytes : 100),
});
const loadOf = (value: number): Partial<HostReaders> => ({
  loadAverages: () => [value, value, value],
});

test("ARK-T289 each host signal gets its level at and around each threshold", async () => {
  const table: [string, Partial<HostReaders>, "pressure" | "load" | "disk" | "swap", string][] = [
    ["pressure 1", { pressureLevel: () => 1 }, "pressure", "normal"],
    ["pressure 2", { pressureLevel: () => 2 }, "pressure", "amber"],
    ["pressure 4", { pressureLevel: () => 4 }, "pressure", "red"],
    ["load 9.99", loadOf(9.99), "load", "normal"],
    ["load 10", loadOf(10), "load", "normal"],
    ["load 10.01", loadOf(10.01), "load", "amber"],
    ["load 12", loadOf(12), "load", "amber"],
    ["load 12.01", loadOf(12.01), "load", "red"],
    ["disk 30.01", rootDiskOf(30.01), "disk", "normal"],
    ["disk 30", rootDiskOf(30), "disk", "normal"],
    ["disk 29.99", rootDiskOf(29.99), "disk", "amber"],
    ["disk 15", rootDiskOf(15), "disk", "amber"],
    ["disk 14.99", rootDiskOf(14.99), "disk", "red"],
    ["swap 2", swapOf(2), "swap", "normal"],
    ["swap 2.01", swapOf(2.01), "swap", "amber"],
    ["swap 6", swapOf(6), "swap", "amber"],
    ["swap 6.01", swapOf(6.01), "swap", "red"],
  ];
  const found = await Promise.all(
    table.map(async ([name, overrides, signal]) => [name, (await levelsOf(overrides))[signal]]),
  );
  expect(found).toEqual(table.map(([name, , , level]) => [name, level]));
});

test("ARK-T289 a signal that cannot be read is unchecked and the others keep their levels", async () => {
  const broken: [string, Partial<HostReaders>, "pressure" | "load" | "disk" | "swap" | "cpu"][] = [
    [
      "pressure throws",
      {
        pressureLevel: () => {
          throw new Error("sysctl failed");
        },
      },
      "pressure",
    ],
    ["pressure unparseable", { pressureLevel: () => 3 }, "pressure"],
    ["pressure missing", { pressureLevel: () => null }, "pressure"],
    [
      "memory throws",
      {
        memory: async () => {
          throw new Error("vm.swapusage failed");
        },
      },
      "swap",
    ],
    [
      "memory unparseable",
      {
        memory: async () => ({
          freeMemoryPercent: null,
          swapUsedGigabytes: null,
          swapTotalGigabytes: null,
        }),
      },
      "swap",
    ],
    [
      "load throws",
      {
        loadAverages: () => {
          throw new Error("no loadavg");
        },
      },
      "load",
    ],
    [
      "root disk throws",
      {
        freeGigabytesOf: (path) => {
          if (path === "/") throw new Error("statfs failed");
          return 100;
        },
      },
      "disk",
    ],
    ["cpu missing", { cpuPercent: () => null }, "cpu"],
  ];
  for (const [name, overrides, signal] of broken) {
    const levels = await levelsOf(overrides);
    expect(levels[signal], name).toBe("unchecked");
    for (const other of ["pressure", "load", "disk", "swap"] as const)
      if (other !== signal) expect(levels[other], `${name}: ${other}`).toBe("normal");
  }
});

test("ARK-T289 with every reader failing the reading is unchecked everywhere and readHost does not throw", async () => {
  const fail = () => {
    throw new Error("unreadable");
  };
  const reading = await readHost({
    memory: fail,
    pressureLevel: fail,
    loadAverages: fail,
    cores: fail,
    cpuPercent: fail,
    freeGigabytesOf: fail,
  });
  expect(hostLevels(reading)).toEqual({
    cpu: "unchecked",
    pressure: "unchecked",
    swap: "unchecked",
    disk: "unchecked",
    load: "unchecked",
  });
  expect(reading.cores).toBeNull();
});
