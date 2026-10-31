import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ArkError } from "./errors.ts";
import { projectDirectory } from "./paths.ts";

const ticketSources = ["local", "github", "jira"];
const levels = ["unit", "integration", "e2e"];
const parserNames = ["bun", "pytest", "behave"];
const roleNames = ["implementer", "validator", "reviewer"] as const;

type Role = (typeof roleNames)[number];

export type ProjectConfig = {
  workspace: string;
  ticket_source: "local" | "github" | "jira";
  compose?: string;
  suites: {
    name: string;
    level: "unit" | "integration" | "e2e";
    repo: string;
    command: string;
    parser: string;
  }[];
  roles: Record<Role, { harness: string; model: string }>;
  concurrency: number;
  round_budget: number;
};

type Fields = Record<string, unknown>;

export function loadConfig(project: string): ProjectConfig {
  const file = join(projectDirectory(project), "ark.yml");
  if (!existsSync(file)) throw new ArkError(`project ${project} has no ark.yml: expected ${file}`);
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ArkError(`${file}: not valid YAML: ${(err as Error).message}`);
  }
  return validateConfig(raw, file);
}

export function validateConfig(raw: unknown, path: string): ProjectConfig {
  const fail = (message: string): never => {
    throw new ArkError(`${path}: ${message}`);
  };
  const asObject = (value: unknown, field: string): Fields => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail(`${field} must be a mapping`);
    return value as Fields;
  };
  const text = (fields: Fields, key: string, field: string): string => {
    const value = fields[key];
    if (typeof value !== "string" || value.trim() === "")
      fail(`${field} is required and must be a non-empty string`);
    return value as string;
  };
  const oneOf = (fields: Fields, key: string, field: string, allowed: string[]): string => {
    const value = text(fields, key, field);
    if (!allowed.includes(value)) fail(`${field} must be one of ${allowed.join(", ")}`);
    return value;
  };
  const integer = (fields: Fields, key: string, minimum: number, fallback: number): number => {
    const value = fields[key] ?? fallback;
    if (!Number.isInteger(value) || (value as number) < minimum)
      fail(`${key} must be an integer >= ${minimum}`);
    return value as number;
  };

  const fields = asObject(raw, "ark.yml");

  const workspace = text(fields, "workspace", "workspace");
  if (!existsSync(workspace) || !statSync(workspace).isDirectory())
    fail(`workspace is not an existing directory: ${workspace}`);
  const ticketSource = oneOf(
    fields,
    "ticket_source",
    "ticket_source",
    ticketSources,
  ) as ProjectConfig["ticket_source"];
  if (fields.compose !== undefined) text(fields, "compose", "compose");

  if (!Array.isArray(fields.suites) || fields.suites.length === 0)
    fail("suites is required and needs at least one suite");
  const names = new Set<string>();
  const suites = (fields.suites as unknown[]).map((entry, i) => {
    const suite = asObject(entry, `suites[${i}]`);
    const name = text(suite, "name", `suites[${i}].name`);
    if (names.has(name)) fail(`suites[${i}].name duplicates another suite: ${name}`);
    names.add(name);
    return {
      name,
      level: oneOf(
        suite,
        "level",
        `suites[${i}].level`,
        levels,
      ) as ProjectConfig["suites"][number]["level"],
      repo: text(suite, "repo", `suites[${i}].repo`),
      command: text(suite, "command", `suites[${i}].command`),
      parser: oneOf(suite, "parser", `suites[${i}].parser`, parserNames),
    };
  });

  const rolesField = asObject(fields.roles ?? fail("roles is required"), "roles");
  const roles = {} as ProjectConfig["roles"];
  for (const role of roleNames) {
    const entry = asObject(rolesField[role] ?? fail(`roles.${role} is required`), `roles.${role}`);
    roles[role] = {
      harness: text(entry, "harness", `roles.${role}.harness`),
      model: text(entry, "model", `roles.${role}.model`),
    };
  }

  const config: ProjectConfig = {
    workspace,
    ticket_source: ticketSource,
    suites,
    roles,
    concurrency: integer(fields, "concurrency", 1, 2),
    round_budget: integer(fields, "round_budget", 0, 2),
  };
  if (fields.compose !== undefined) config.compose = fields.compose as string;
  return config;
}
