import { existsSync, readFileSync, statSync } from "node:fs";
import { cpus } from "node:os";
import { defaultMaximumSwapGigabytes, defaultMinimumFreeMemoryPercent } from "./host.ts";
import { join } from "node:path";
import { ArkError, yamlQuoteHint } from "./errors.ts";
import { projectDirectory } from "./paths.ts";
import { discoverRepos } from "./workspace.ts";

const ticketSources = ["local", "github", "jira"];
const testCaseSources = ["local"];
const levels = ["unit", "integration", "e2e"];
const parserNames = ["bun", "pytest", "behave"];
export const gateNames = ["criteria", "strategy", "plan", "escalation"] as const;
export const HARNESSES = ["claude", "codex", "omp", "pi"] as const;
const roleNames = ["implementer", "validator", "reviewer"] as const;
// The optional roles: ark evaluation record, ark strategy record, the chief playbook and the run lead playbook name them when missing.
const optionalRoleNames = [
  "evaluator",
  "designer",
  "chief",
  "test_writer",
  "test_reviewer",
] as const;

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
  /** Files a command writes. `ark worktree sync` runs the command in each repo worktree when only listed paths conflict. `path` is relative to the repo root. */
  generated?: { path: string; command: string }[];
  /** `accepted`: findings of the security scan that do not block `ark merge-request open`. `id` is a vulnerability id, one of its aliases, or a gitleaks fingerprint. */
  security?: { accepted: { id: string; reason: string }[] };
  suites: {
    name: string;
    level: "unit" | "integration" | "e2e";
    repo: string;
    command: string;
    parser: string;
    /** CPU cores the suite takes from `test_budget_cores`, and the value of `<cores>` in its commands. Omitted: the whole budget. */
    cores?: number;
    /** Glob of the repo's test files that `base_command` runs at the base (own-commit files only). */
    base_files?: string;
    /** The command for a list of files at the base: `{files}` is the shell-quoted list, `{report}` as in `command`. */
    base_command?: string;
    /** Repo paths the suite covers: a folder ends with `/`, else a file. A quick run skips the suite when the diff touches none. */
    paths?: string[];
  }[];
  /** Commands `ark test` runs in the repo's worktree before the suites. They must not write files. */
  checks: { name: string; repo: string; command: string; cores: number }[];
  /** CPU cores that the suites and checks of all `ark test` runs of the host share. Default floor(0.6 x cores). */
  test_budget_cores: number;
  /** `ark test` starts no suite while free memory is below this percent. Inclusive: equal admits. Default 20. */
  test_min_free_memory_percent: number;
  /** `ark test` starts no suite while swap used is above this many GB. Inclusive: equal admits. Default 8. */
  test_max_swap_gb: number;
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
  /** The most extra rounds `gates.escalation: auto` grants in one run. */
  escalation_rounds: number;
  /** Each gate is answered by the human or by Ark. A missing key is human. */
  gates: Record<(typeof gateNames)[number], "human" | "auto">;
};

type Fields = Record<string, unknown>;

/** The keys of a type, written once as a record so that a new field of `T` fails to compile until it is listed here. */
const keysOf = <T>(record: Record<keyof T, true>): string[] => Object.keys(record);

// Known keys per level of ark.yml. `loadConfig` refuses any other key.
const topLevelKeys = keysOf<ProjectConfig>({
  workspace: true,
  ticket_source: true,
  merge_requests: true,
  test_case_source: true,
  compose: true,
  setup: true,
  suites: true,
  checks: true,
  test_budget_cores: true,
  test_min_free_memory_percent: true,
  test_max_swap_gb: true,
  roles: true,
  repos: true,
  concurrency: true,
  pr_writing: true,
  round_budget: true,
  escalation_rounds: true,
  gates: true,
  generated: true,
  security: true,
});
const securityKeys = keysOf<NonNullable<ProjectConfig["security"]>>({ accepted: true });
const acceptedKeys = keysOf<NonNullable<ProjectConfig["security"]>["accepted"][number]>({
  id: true,
  reason: true,
});
const suiteKeys = keysOf<ProjectConfig["suites"][number]>({
  name: true,
  level: true,
  repo: true,
  command: true,
  parser: true,
  cores: true,
  base_files: true,
  base_command: true,
  paths: true,
});
const checkKeys = keysOf<ProjectConfig["checks"][number]>({
  name: true,
  repo: true,
  command: true,
  cores: true,
});
const roleKeys = keysOf<RoleConfig>({ harness: true, model: true });
const repoKeys = keysOf<NonNullable<ProjectConfig["repos"]>[string]>({ base: true });
const prWritingKeys = keysOf<PrWriting>({
  reviewers: true,
  tier_floor: true,
  sensitive_paths: true,
  one_way_paths: true,
  agent_authored: true,
  title_prefix: true,
});

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/** The valid key that `key` most likely mistypes, or undefined when none is near. */
function nearestKey(key: string, validKeys: readonly string[]): string | undefined {
  const limit = Math.max(2, Math.floor(key.length / 3));
  let best: string | undefined;
  let bestDistance = limit + 1;
  for (const valid of validKeys) {
    const distance = editDistance(key, valid);
    if (distance < bestDistance) [best, bestDistance] = [valid, distance];
  }
  return best;
}

export function loadConfig(project: string): ProjectConfig {
  const file = join(projectDirectory(project), "ark.yml");
  if (!existsSync(file)) throw new ArkError(`project ${project} has no ark.yml: expected ${file}`);
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ArkError(`${file}: not valid YAML: ${(err as Error).message} (${yamlQuoteHint})`);
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

  const onlyKeys = (fields: Fields, field: string, validKeys: readonly string[]): void => {
    for (const key of Object.keys(fields)) {
      if (validKeys.includes(key)) continue;
      const nearest = nearestKey(key, validKeys);
      fail(
        `${field === "" ? key : `${field}.${key}`} is not a key; ${
          nearest ? `did you mean ${nearest}?` : `use ${validKeys.join(", ")}`
        }`,
      );
    }
  };

  const fields = asObject(raw, "ark.yml");
  onlyKeys(fields, "", topLevelKeys);

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
  if (fields.generated !== undefined && !Array.isArray(fields.generated))
    fail("generated must be a list of { path, command }");
  const generatedPaths = new Set<string>();
  const generated = ((fields.generated as unknown[] | undefined) ?? []).map((entry, i) => {
    const generatedEntry = asObject(entry, `generated[${i}]`);
    const generatedPath = text(generatedEntry, "path", `generated[${i}].path`);
    if (generatedPaths.has(generatedPath))
      fail(`generated[${i}].path duplicates another entry: ${generatedPath}`);
    generatedPaths.add(generatedPath);
    return {
      path: generatedPath,
      command: text(generatedEntry, "command", `generated[${i}].command`),
    };
  });

  if (!Array.isArray(fields.suites) || fields.suites.length === 0)
    fail("suites is required and needs at least one suite");
  const names = new Set<string>();
  const suites = (fields.suites as unknown[]).map((entry, i) => {
    const suite = asObject(entry, `suites[${i}]`);
    onlyKeys(suite, `suites[${i}]`, suiteKeys);
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
    const command = text(suite, "command", `suites[${i}].command`);
    if (!command.includes("{report}"))
      fail(`suites[${i}].command must write its JUnit report to {report}`);
    return {
      name,
      level: oneOf(
        suite,
        "level",
        `suites[${i}].level`,
        levels,
      ) as ProjectConfig["suites"][number]["level"],
      repo: text(suite, "repo", `suites[${i}].repo`),
      command,
      parser: oneOf(suite, "parser", `suites[${i}].parser`, parserNames),
      ...(suite.cores !== undefined ? { cores: integer(suite, "cores", 1, 1) } : {}),
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
    onlyKeys(check, `checks[${i}]`, checkKeys);
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
      cores: integer(check, "cores", 1, 1),
    };
  });

  const rolesField = asObject(fields.roles ?? fail("roles is required"), "roles");
  onlyKeys(rolesField, "roles", [...roleNames, ...optionalRoleNames]);
  const roles = {} as ProjectConfig["roles"];
  for (const role of [...roleNames, ...optionalRoleNames]) {
    if ((optionalRoleNames as readonly string[]).includes(role) && rolesField[role] === undefined)
      continue;
    const entry = asObject(rolesField[role] ?? fail(`roles.${role} is required`), `roles.${role}`);
    onlyKeys(entry, `roles.${role}`, roleKeys);
    const harness = text(entry, "harness", `roles.${role}.harness`);
    if (!(HARNESSES as readonly string[]).includes(harness))
      fail(`roles.${role}.harness must be claude, codex, omp or pi (got ${harness})`);
    roles[role] = {
      harness,
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
    for (const key of Object.keys(reposField)) {
      const entry = asObject(reposField[key], `repos.${key}`);
      onlyKeys(entry, `repos.${key}`, repoKeys);
      repos[key] = { base: text(entry, "base", `repos.${key}.base`) };
    }
  }

  let security: ProjectConfig["security"];
  if (fields.security !== undefined) {
    const securityField = asObject(fields.security, "security");
    onlyKeys(securityField, "security", securityKeys);
    if (!Array.isArray(securityField.accepted))
      fail("security.accepted must be a list of { id, reason }");
    const acceptedIds = new Set<string>();
    security = {
      accepted: (securityField.accepted as unknown[]).map((entry, i) => {
        const accepted = asObject(entry, `security.accepted[${i}]`);
        onlyKeys(accepted, `security.accepted[${i}]`, acceptedKeys);
        const id = text(accepted, "id", `security.accepted[${i}].id`);
        if (acceptedIds.has(id)) fail(`security.accepted[${i}].id duplicates another entry: ${id}`);
        acceptedIds.add(id);
        return { id, reason: text(accepted, "reason", `security.accepted[${i}].reason`) };
      }),
    };
  }

  const prWritingField = asObject(fields.pr_writing ?? {}, "pr_writing");
  onlyKeys(prWritingField, "pr_writing", prWritingKeys);
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
    test_budget_cores: integer(
      fields,
      "test_budget_cores",
      1,
      Math.max(1, Math.floor(0.6 * cpus().length)),
    ),
    test_min_free_memory_percent: integer(
      fields,
      "test_min_free_memory_percent",
      0,
      defaultMinimumFreeMemoryPercent,
    ),
    test_max_swap_gb: integer(fields, "test_max_swap_gb", 0, defaultMaximumSwapGigabytes),
    concurrency: integer(fields, "concurrency", 1, 2),
    round_budget: integer(fields, "round_budget", 0, 2),
    escalation_rounds: integer(fields, "escalation_rounds", 0, 2),
    pr_writing: prWriting,
    gates,
  };
  if (repos !== undefined) config.repos = repos;
  if (fields.compose !== undefined) config.compose = fields.compose as string;
  if (fields.setup !== undefined) config.setup = fields.setup as string;
  if (fields.generated !== undefined) config.generated = generated;
  if (security !== undefined) config.security = security;
  return config;
}
