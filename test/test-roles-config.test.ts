import { expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../cli/config.ts";
import { ark, tempArkHome, tempGitRepo, writeProject } from "./helpers.ts";

setDefaultTimeout(30_000);

const bootstrapPath = join(import.meta.dir, "..", "skills/ark/playbooks/bootstrap.md");

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

test("ARK-T17 the default roles block of bootstrap.md is a valid config on two vendors", () => {
  tempArkHome();
  const section = readFileSync(bootstrapPath, "utf8").split(/^## 3\./m)[0] as string;
  const block = [...section.matchAll(/```yaml\n(roles:\n[\s\S]*?)```/g)]
    .map((match) => match[1] as string)
    .find((text) => !text.includes("<harness>"));
  expect(block).toBeDefined();
  const { roles: extracted } = Bun.YAML.parse(block as string) as {
    roles: Record<string, unknown>;
  };
  writeProject("bootstrap-default", projectConfigFor(extracted));

  expect(ark("status", "--project", "bootstrap-default").code).toBe(0);
  const roles = loadConfig("bootstrap-default").roles;
  for (const name of [
    "implementer",
    "validator",
    "reviewer",
    "evaluator",
    "designer",
    "chief",
  ] as const) {
    expect(roles[name]?.harness).toBeTruthy();
  }
  const vendorOf = (role?: { harness: string; model: string }): string => {
    expect(role?.harness && role.model).toBeTruthy();
    if (role?.harness === "claude") return "anthropic";
    if (role?.harness === "codex") return "openai";
    return (role?.model ?? "").split("/")[0] as string;
  };
  const reviewerVendor = vendorOf(roles.test_reviewer);
  expect(reviewerVendor).not.toBe(vendorOf(roles.implementer));
  expect(reviewerVendor).not.toBe(vendorOf(roles.test_writer));
});
