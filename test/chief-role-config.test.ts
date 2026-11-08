import { expect, setDefaultTimeout, test } from "bun:test";
import { ark, tempArkHome, tempGitRepo, writeProject } from "./helpers.ts";

// ARK-292: bun resets the default timeout per file, so each file sets it.
setDefaultTimeout(30_000);

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

test("ARK-T79 loads old and chief-role configs", () => {
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

  const invalidConfig = {
    ...configWithChief,
    roles: { ...(configWithChief.roles as object), chief: { harness: "omp" } },
  };
  writeProject("missing-chief-model", invalidConfig);
  const refused = ark("status", "--project", "missing-chief-model");
  expect(refused.code).toBe(1);
  expect(refused.out + refused.err).toContain("roles.chief.model");
});
