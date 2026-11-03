import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ark, tempArkHome, tempGitRepo, writeProject } from "./helpers.ts";

const repositoryRoot = join(import.meta.dir, "..");

function projectConfigFor(workspace: string): Record<string, unknown> {
  return {
    workspace,
    ticket_source: "local",
    suites: [
      {
        name: "cli",
        level: "integration",
        repo: ".",
        command: "bun test",
        parser: "bun",
      },
    ],
    roles: {
      implementer: { harness: "omp", model: "pi/task" },
      validator: { harness: "omp", model: "pi/validate" },
      reviewer: { harness: "omp", model: "pi/validate" },
    },
  };
}

test("ARK-177-AC5 loads old and chief-role configs and bootstrap defines roles.chief", () => {
  tempArkHome();
  const configWithChief = projectConfigFor(tempGitRepo());
  configWithChief.roles = {
    ...(configWithChief.roles as object),
    chief: { harness: "omp", model: "pi/task" },
  };
  writeProject("with-chief", configWithChief);
  writeProject("old-config", projectConfigFor(tempGitRepo()));

  expect(ark("status", "--project", "with-chief").code).toBe(0);
  expect(ark("status", "--project", "old-config").code).toBe(0);
  const bootstrapPlaybook = readFileSync(
    join(repositoryRoot, "skills/ark/playbooks/bootstrap.md"),
    "utf8",
  );
  const roleSection = bootstrapPlaybook.split("## 8. Write `ark.yml`")[1]?.split("\n## ")[0];
  expect(roleSection).toBeDefined();
  expect(roleSection).toMatch(/chief:\s*\{\s*harness:/);
  expect(roleSection).toMatch(/chief:\s*\{\s*harness:[^}]*model:/);

  const invalidConfig = {
    ...configWithChief,
    roles: { ...(configWithChief.roles as object), chief: { harness: "omp" } },
  };
  writeProject("missing-chief-model", invalidConfig);
  const refused = ark("status", "--project", "missing-chief-model");
  expect(refused.code).toBe(1);
  expect(refused.out + refused.err).toContain("roles.chief.model");
});
