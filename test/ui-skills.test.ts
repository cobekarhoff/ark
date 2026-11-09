import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reactSkill, requiredUiSkills, uiSkillsFor } from "../cli/ui-skills.ts";
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

describe("ARK-T40 ARK-328/AC1 ark ui-skills prints the 3 UI skills only when the surfaces include web_ui", () => {
  const printed = [...requiredUiSkills, `${reactSkill} (only when the change touches React code)`];

  test.each([
    ["web_ui", ["web_ui"]],
    ["document + web_ui", ["document", "web_ui"]],
  ])("ARK-T40 ARK-328/AC1 %s prints the 3 skills and the React line", (_name, surfaces) => {
    record(surfaces);
    const result = ark("ui-skills", runId, "--project", "demo");
    expect(result.code).toBe(0);
    expect(result.out.trimEnd().split("\n")).toEqual(printed);
    expect(uiSkillsFor(surfaces)).toEqual(requiredUiSkills);
  });

  test.each(["cli_output", "document", "none"])(
    "ARK-T40 ARK-328/AC1 %s alone prints none",
    (surface) => {
      record([surface]);
      const result = ark("ui-skills", runId, "--project", "demo");
      expect(result.code).toBe(0);
      expect(result.out.trim()).toBe("none");
      expect(uiSkillsFor([surface])).toEqual([]);
    },
  );
});
