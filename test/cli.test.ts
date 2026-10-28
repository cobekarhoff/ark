import { describe, expect, test } from "bun:test";
import { accessSync, constants } from "node:fs";
import packageConfig from "../package.json";

const ark = (...argumentsList: string[]) =>
  Bun.spawnSync(["bun", "cli/ark.ts", ...argumentsList], { cwd: `${import.meta.dir}/..` });

describe("ARK-102-AC1", () => {
  test("package.json has bin.ark pointing to an executable file and an omp key", () => {
    expect(packageConfig.bin.ark).toBe("./cli/ark.ts");
    accessSync(`${import.meta.dir}/../${packageConfig.bin.ark}`, constants.X_OK);
    expect(packageConfig).toHaveProperty("omp");
  });
});

describe("ARK-102-AC2", () => {
  test("--version prints the package version", () => {
    const result = ark("--version");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(packageConfig.version);
  });

  test("--help exits 0", () => {
    expect(ark("--help").exitCode).toBe(0);
  });

  test("--help lists full command and gate names", () => {
    const output = ark("--help").stdout.toString();
    for (const command of ["run start", "run replay", "advance", "worktree create", "merge-request open", "acceptance-criteria update", "--criteria", "criteria|plan|evidence|escalation"]) expect(output).toContain(command);
  });

  test("unknown command exits 2", () => {
    const result = ark("nope");
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("unknown command");
  });
});

describe("ARK-119-AC2", () => {
  test("retired command names are rejected rather than kept as aliases", () => {
    for (const command of [["ws", "create"], ["mr"], ["ac", "update"]]) {
      const result = ark(...command, "obsolete-run");
      expect(result.exitCode, command.join(" ")).toBe(2);
      expect(result.stderr.toString()).toContain("unknown command or bad arguments");
    }
  });

  test("the retired test selection flag is rejected", () => {
    const result = ark("test", "obsolete-run", "--acs", "DEMO-1-AC1");
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("unknown command or bad arguments");
  });
});
