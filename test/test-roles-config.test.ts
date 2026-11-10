import { expect, setDefaultTimeout, test } from "bun:test";
import { loadConfig } from "../cli/config.ts";
import { ark, tempArkHome, tempGitRepo, withFakeHarnesses, writeProject } from "./helpers.ts";

setDefaultTimeout(30_000);

function projectConfigFor(roles: Record<string, unknown>): Record<string, unknown> {
  return {
    workspace: tempGitRepo(),
    ticket_source: "local",
    suites: [{ name: "cli", level: "integration", repo: ".", command: "bun test", parser: "bun" }],
    roles: {
      implementer: { harness: "omp", model: "pi/task" },
      validator: { harness: "omp", model: "pi/validate" },
      reviewer: { harness: "omp", model: "pi/validate" },
      ...roles,
    },
  };
}

test("ARK-T16 loadConfig reads the optional test_writer and test_reviewer roles", () => {
  withFakeHarnesses(["pi/task", "pi/validate"], () => {
    tempArkHome();
    const writer = { harness: "claude", model: "claude-sonnet" };
    const reviewer = { harness: "codex", model: "gpt-codex" };
    writeProject(
      "with-test-roles",
      projectConfigFor({ test_writer: writer, test_reviewer: reviewer }),
    );
    writeProject("without-test-roles", projectConfigFor({}));
    writeProject("writer-no-model", projectConfigFor({ test_writer: { harness: "claude" } }));

    expect(ark("status", "--project", "with-test-roles").code).toBe(0);
    const without = ark("status", "--project", "without-test-roles");
    expect(without.code).toBe(0);
    expect(without.err).toBe("");
    const refused = ark("status", "--project", "writer-no-model");
    expect(refused.code).not.toBe(0);
    expect(refused.out + refused.err).toContain("roles.test_writer");
    expect(refused.out + refused.err).toContain("model");

    const roles = loadConfig("with-test-roles").roles;
    expect(roles.test_writer).toEqual(writer);
    expect(roles.test_reviewer).toEqual(reviewer);
  });
});
