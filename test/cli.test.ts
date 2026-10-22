import { describe, expect, test } from "bun:test";
import { accessSync, constants } from "node:fs";
import pkg from "../package.json";

const ark = (...args: string[]) =>
  Bun.spawnSync(["bun", "cli/ark.ts", ...args], { cwd: `${import.meta.dir}/..` });

describe("ARK-102-AC1", () => {
  test("package.json has bin.ark pointing to an executable file and an omp key", () => {
    expect(pkg.bin.ark).toBe("./cli/ark.ts");
    accessSync(`${import.meta.dir}/../${pkg.bin.ark}`, constants.X_OK);
    expect(pkg).toHaveProperty("omp");
  });
});

describe("ARK-102-AC2", () => {
  test("--version prints the package version", () => {
    const r = ark("--version");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().trim()).toBe(pkg.version);
  });

  test("--help exits 0", () => {
    expect(ark("--help").exitCode).toBe(0);
  });

  test("unknown command exits 2", () => {
    const r = ark("nope");
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("unknown command");
  });
});
