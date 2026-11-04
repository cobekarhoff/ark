import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { reactSkill, requiredUiSkills } from "../cli/ui-skills.ts";
import { ark, tempArkHome, tempGitRepo, writeProject, writeTicket } from "./helpers.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

let runDirectory: string;
let runId: string;

beforeEach(() => {
  tempArkHome();
  const projectDirectory = writeProject("demo", {
    workspace: tempGitRepo(),
    ticket_source: "local",
    suites: [{ name: "cli", level: "integration", repo: ".", command: "true", parser: "bun" }],
    roles: {
      implementer: { harness: "omp", model: "pi/task" },
      validator: { harness: "omp", model: "pi/validate" },
      reviewer: { harness: "omp", model: "pi/validate" },
      evaluator: { harness: "omp", model: "pi/validate" },
    },
  });
  expect(
    ark("run", "start", writeTicket("demo", "ARK-901", [{ id: "ARK-901-AC1", text: "first" }]))
      .code,
  ).toBe(0);
  runId = readdirSync(join(projectDirectory, "runs"))[0];
  runDirectory = join(projectDirectory, "runs", runId);
});

const record = (surfaces: string[]) => {
  writeFileSync(
    join(runDirectory, "evaluation.md"),
    `## Blockers\n\n## Risks\n\n## Surfaces\n${surfaces.map((surface) => `\n- ${surface}`).join("")}\n`,
  );
  expect(ark("evaluation", "record", runId).code).toBe(0);
};

describe("ui-skills", () => {
  test.each(["web_ui", "cli_output", "document"])(
    "ARK-279-AC1 surface %s prints the 3 required skills and the React line",
    (surface) => {
      record([surface]);
      const result = ark("ui-skills", runId, "--project", "demo");
      expect(result.code).toBe(0);
      expect(result.out.trimEnd().split("\n")).toEqual([
        ...requiredUiSkills,
        `${reactSkill} (only when the change touches React code)`,
      ]);
    },
  );

  test("ARK-279-AC1 surface none prints none", () => {
    record(["none"]);
    const result = ark("ui-skills", runId, "--project", "demo");
    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe("none");
  });

  test("ARK-279-AC1 a run with no evaluation exits 1", () => {
    const result = ark("ui-skills", runId, "--project", "demo");
    expect(result.code).toBe(1);
    expect(result.err).toContain("no recorded evaluation");
  });
});

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

test("ARK-279-AC2 skill names live only in cli/ui-skills.ts", () => {
  const root = join(import.meta.dir, "..");
  const names = ["web-design-guidelines", "emil-design-eng", "vercel-react-best-practices"];
  const sources = [...files(join(root, "cli")), ...files(join(root, "skills/ark/playbooks"))];
  expect(sources.length).toBeGreaterThan(10);
  const holders = sources
    .filter((file) => names.some((name) => readFileSync(file, "utf8").includes(name)))
    .map((file) => relative(root, file));
  expect(holders).toEqual(["cli/ui-skills.ts"]);
  const own = readFileSync(join(root, "cli/ui-skills.ts"), "utf8");
  for (const name of names) expect(own).toContain(name);
});

test("ARK-279-AC9 docs/reference/cli.md lists ui-skills, Skills: and skills and matches the generator", () => {
  const path = join(import.meta.dir, "..", "docs/reference/cli.md");
  const before = readFileSync(path, "utf8");
  expect(before).toContain("### ui-skills");
  expect(before).toContain("ark ui-skills <run>");
  expect(before).toContain("`Skills:`");
  expect(before).toContain("| `skills`");
  Bun.spawnSync(["bun", join(import.meta.dir, "..", "scripts/cli-reference.ts")]);
  expect(readFileSync(path, "utf8")).toBe(before);
});
