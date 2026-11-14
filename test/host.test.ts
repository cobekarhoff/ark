import { expect, setDefaultTimeout, test } from "bun:test";
import { holdReasons, type HostReading } from "../cli/host.ts";

setDefaultTimeout(30_000);

const limits = { minimumFreePercent: 20, maximumSwapGigabytes: 8, cores: 8 };

const healthyHost: HostReading = {
  freeMemoryPercent: 50,
  swapUsedGigabytes: 1,
  swapTotalGigabytes: 4,
  pressureLevel: 1,
  loadOne: 2,
  load: 2.5,
  loadFifteen: 2,
  cores: 8,
  cpuPercent: 10,
  freeDiskGigabytes: 100,
  freeRootGigabytes: 100,
};

const reasonsFor = (overrides: Partial<HostReading>) =>
  holdReasons({ ...healthyHost, ...overrides }, limits);

test("ARK-T188 holds nothing on a healthy host", () => {
  expect(holdReasons(healthyHost, limits)).toEqual([]);
});

test("ARK-T188 holds on free disk below 10 GB and not at 10 GB", () => {
  expect(reasonsFor({ freeDiskGigabytes: 9 })).toEqual(["free disk 9 GB is below the 10 GB floor"]);
  expect(reasonsFor({ freeDiskGigabytes: 10 })).toEqual([]);
});

test("ARK-T188 lists reasons in the order memory, swap, CPU, disk", () => {
  const reasons = reasonsFor({
    freeMemoryPercent: 19,
    swapUsedGigabytes: 8.1,
    cpuPercent: 95,
    freeDiskGigabytes: 9,
  });
  expect(reasons).toEqual([
    "free 19% is below the 20% floor",
    "swap 8.1 GB is above the 8 GB ceiling",
    "CPU 95.0% is above the 90% busy limit",
    "free disk 9 GB is below the 10 GB floor",
  ]);
});
