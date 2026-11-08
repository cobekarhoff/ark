import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ArkError } from "./errors.ts";
import { projectDirectory } from "./paths.ts";
import { discoverRepos } from "./workspace.ts";

const ticketSources = ["local", "github", "jira"];
const testCaseSources = ["local"];
const levels = ["unit", "integration", "e2e"];
const parserNames = ["bun", "pytest", "behave"];
export const gateNames = ["criteria", "strategy", "plan", "escalation"] as const;
const roleNames = ["implementer", "validator", "reviewer"] as const;

type Role = (typeof roleNames)[number];
type RoleConfig = { harness: string; model: string };

export type PrWriting = {
  reviewers: string[];
  /** Lowest lint tier, 0 to 3. */
  tier_floor: number;
  sensitive_paths: string[];
  one_way_paths: string[];
  agent_authored: boolean;
  title_prefix?: string;
};

export type ProjectConfig = {
  workspace: string;
  ticket_source: "local" | "github" | "jira";
  merge_requests: "open" | "none";
  /** Where test case entries live. Only `local` (`test/cases/` of each repo) exists. */
  test_case_source: "local";
  compose?: string;
  setup?: string;
  suites: {
    name: string;
    level: "unit" | "integration" | "e2e";
    repo: string;
    command: string;
    parser: string;
    /** Glob of the repo's test files that `base_command` runs at the base (own-commit files only). */
    base_files?: string;
    /** The command for a list of files at the base: `{files}` is the shell-quoted list, `{report}` as in `command`. */
    base_command?: string;
    /** Repo paths the suite covers: a folder ends with `/`, else a file. A quick run skips the suite when the diff touches none. */
    paths?: string[];
  }[];
  /** Commands `ark test` runs in the repo's worktree before the suites. They must not write files. */
  checks: { name: string; repo: string; command: string }[];
  roles: Record<Role, RoleConfig> & {
    evaluator?: RoleConfig;
    designer?: RoleConfig;
    chief?: RoleConfig;
    test_writer?: RoleConfig;
    test_reviewer?: RoleConfig;
  };
  /** Base and target branch per repo, keyed by repo path exactly as `ark worktree create` names it (`.` or `repos/a`). */
  repos?: Record<string, { base: string }>;
  concurrency: number;
  /** The `pr_writing:` block with defaults filled in. */
  pr_writing: PrWriting;
  round_budget: number;
  /** Each gate is answered by the human or by Ark. A missing key is human. */
  gates: Record<(typeof gateNames)[number], "human" | "auto">;
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

/** The project's merge_requests mode. A missing ark.yml counts as open; an invalid one throws. */
export function mergeRequestsMode(project: string): ProjectConfig["merge_requests"] {
  if (!existsSync(join(projectDirectory(project), "ark.yml"))) return "open";
  return loadConfig(project).merge_requests;
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
  const mergeRequests = fields.merge_requests === undefined ? "open" : fields.merge_requests;
  if (mergeRequests !== "open" && mergeRequests !== "none")
    fail("merge_requests must be one of open, none");
  const mergeRequestsMode = mergeRequests as ProjectConfig["merge_requests"];
  const testCaseSource = fields.test_case_source ?? "local";
  if (!testCaseSources.includes(testCaseSource as string))
    fail(
      `test_case_source ${JSON.stringify(testCaseSource)} is not supported: use one of ${testCaseSources.join(", ")}`,
    );
  if (fields.compose !== undefined) text(fields, "compose", "compose");
  if (fields.setup !== undefined) text(fields, "setup", "setup");

  if (!Array.isArray(fields.suites) || fields.suites.length === 0)
    fail("suites is required and needs at least one suite");
  const names = new Set<string>();
  const suites = (fields.suites as unknown[]).map((entry, i) => {
    const suite = asObject(entry, `suites[${i}]`);
    const name = text(suite, "name", `suites[${i}].name`);
    if (names.has(name)) fail(`suites[${i}].name duplicates another suite: ${name}`);
    names.add(name);
    const baseFiles =
      suite.base_files === undefined
        ? undefined
        : text(suite, "base_files", `suites[${i}].base_files`);
    const baseCommand =
      suite.base_command === undefined
        ? undefined
        : text(suite, "base_command", `suites[${i}].base_command`);
    if ((baseFiles === undefined) !== (baseCommand === undefined))
      fail(`suites[${i}] needs base_files and base_command together`);
    if (baseCommand !== undefined && !baseCommand.includes("{files}"))
      fail(`suites[${i}].base_command must contain {files}`);
    const paths = suite.paths;
    if (
      paths !== undefined &&
      (!Array.isArray(paths) ||
        paths.length === 0 ||
        paths.some((entry) => typeof entry !== "string" || entry.trim() === ""))
    )
      fail(`suites[${i}].paths must be a non-empty list of non-empty strings`);
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
      ...(baseFiles !== undefined ? { base_files: baseFiles, base_command: baseCommand } : {}),
      ...(paths !== undefined ? { paths: paths as string[] } : {}),
    };
  });

  if (fields.checks !== undefined && !Array.isArray(fields.checks))
    fail("checks must be a list of { name, repo, command }");
  const workspaceRepos = discoverRepos(workspace);
  const checkNames = new Set<string>();
  const checks = ((fields.checks as unknown[] | undefined) ?? []).map((entry, i) => {
    const check = asObject(entry, `checks[${i}]`);
    const name = text(check, "name", `checks[${i}].name`);
    if (checkNames.has(name)) fail(`checks[${i}].name duplicates another check: ${name}`);
    checkNames.add(name);
    const repo = text(check, "repo", `checks[${i}].repo`);
    if (!workspaceRepos.includes(repo))
      fail(
        `checks[${i}].repo is not a repo of the workspace: ${repo} (use ${workspaceRepos.join(", ")})`,
      );
    return {
      name,
      repo,
      command: text(check, "command", `checks[${i}].command`),
    };
  });

  const rolesField = asObject(fields.roles ?? fail("roles is required"), "roles");
  const roles = {} as ProjectConfig["roles"];
  // The optional roles: ark evaluation record, ark strategy record, the chief playbook and the run lead playbook name them when missing.
  const optionalRoles = ["evaluator", "designer", "chief", "test_writer", "test_reviewer"] as const;
  for (const role of [...roleNames, ...optionalRoles]) {
    if ((optionalRoles as readonly string[]).includes(role) && rolesField[role] === undefined)
      continue;
    const entry = asObject(rolesField[role] ?? fail(`roles.${role} is required`), `roles.${role}`);
    roles[role] = {
      harness: text(entry, "harness", `roles.${role}.harness`),
      model: text(entry, "model", `roles.${role}.model`),
    };
  }

  const gatesField = asObject(fields.gates ?? {}, "gates");
  for (const key of Object.keys(gatesField))
    if (!(gateNames as readonly string[]).includes(key))
      fail(`gates.${key} is not a gate: use ${gateNames.join(", ")}`);
  const gates = {} as ProjectConfig["gates"];
  for (const name of gateNames) {
    const value = gatesField[name] ?? "human";
    if (value !== "human" && value !== "auto") fail(`gates.${name} must be one of human, auto`);
    gates[name] = value as "human" | "auto";
  }

  let repos: ProjectConfig["repos"];
  if (fields.repos !== undefined) {
    const reposField = asObject(fields.repos, "repos");
    repos = {};
    for (const key of Object.keys(reposField))
      repos[key] = {
        base: text(asObject(reposField[key], `repos.${key}`), "base", `repos.${key}.base`),
      };
  }

  const prWritingField = asObject(fields.pr_writing ?? {}, "pr_writing");
  const stringList = (key: string): string[] => {
    const value = prWritingField[key] ?? [];
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
      fail(`pr_writing.${key} must be a list of strings`);
    return value as string[];
  };
  const tierFloor = prWritingField.tier_floor ?? 0;
  if (!Number.isInteger(tierFloor) || (tierFloor as number) < 0 || (tierFloor as number) > 3)
    fail("pr_writing.tier_floor must be an integer from 0 to 3");
  const agentAuthored = prWritingField.agent_authored ?? true;
  if (typeof agentAuthored !== "boolean") fail("pr_writing.agent_authored must be true or false");
  if (prWritingField.title_prefix !== undefined)
    text(prWritingField, "title_prefix", "pr_writing.title_prefix");
  const prWriting: PrWriting = {
    reviewers: stringList("reviewers"),
    tier_floor: tierFloor as number,
    sensitive_paths: stringList("sensitive_paths"),
    one_way_paths: stringList("one_way_paths"),
    agent_authored: agentAuthored as boolean,
    ...(prWritingField.title_prefix === undefined
      ? {}
      : { title_prefix: prWritingField.title_prefix as string }),
  };

  const config: ProjectConfig = {
    workspace,
    ticket_source: ticketSource,
    merge_requests: mergeRequestsMode,
    test_case_source: "local",
    suites,
    checks,
    roles,
    concurrency: integer(fields, "concurrency", 1, 2),
    round_budget: integer(fields, "round_budget", 0, 2),
    pr_writing: prWriting,
    gates,
  };
  if (repos !== undefined) config.repos = repos;
  if (fields.compose !== undefined) config.compose = fields.compose as string;
  if (fields.setup !== undefined) config.setup = fields.setup as string;
  return config;
}
