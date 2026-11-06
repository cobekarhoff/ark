/**
 * The ledger: every fact the MR title, body and lint need, gathered once.
 * `buildLedger({ runFolder })` reads an Ark run folder; `buildLedger({ directory })` reads git and the host.
 * A host probe that fails is recorded as `unknown`, never `none`: `none` means the host answered and found nothing.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { evidenceFile, frontmatterOf, parseCriteria } from "../../../cli/criteria.ts";
import { loadConfig, type PrWriting } from "../../../cli/config.ts";
import { ArkError } from "../../../cli/errors.ts";
import {
  deriveState,
  readEvents,
  type ArkEvent,
  type CriterionStatus,
} from "../../../cli/events.ts";
import { projectDirectory } from "../../../cli/paths.ts";
import { loadPlan } from "../../../cli/plan.ts";

export type Rating = "good" | "decent" | "poor";
export type Level = "low" | "medium" | "high";
export type Host = "github" | "gitlab" | "unknown";
export type Finding = { rank: "P0" | "P1" | "P2" | "P3"; title: string; file: string };

/** The `## Merge risk` block of a reviewer findings file. Format: `skills/ark/rubrics/reviewer.md`. */
export type ReviewerBlock = {
  ratings: Partial<Record<"Verification" | "Alignment" | "Impact" | "Rollback cost", Rating>>;
  door: "one-way" | "two-way" | null;
  /** The recovery text of a one-way door. */
  recovery: string;
  blastRadius: string;
  /** Reason for each file the reviewer found outside the plan, keyed by path. */
  unplanned: Record<string, string>;
};

export type EvidenceEntry = {
  testCase: string;
  base: string;
  head: string;
  sha: string;
  /** Run folder relative paths, all screenshots of both sides. */
  screenshots: string[];
};

export type RepoLedger = {
  repo: string;
  branch: string;
  base: string;
  baseSha: string;
  head: string;
  /** `git diff --shortstat` text, or `unknown` when the base cannot be read. */
  shortstat: string;
  commits: { sha: string; subject: string }[];
  files: { path: string; status: string }[];
  /** `Depends on #N` or `Depends on !N` lines for the upstream repos whose MR is open. */
  dependsOn: string[];
};

export type RiskScore = {
  verification: number;
  alignment: number;
  impact: number;
  rollback: number;
  mean: number;
  script: Level;
  reviewer: Level | null;
  /** The higher of script and reviewer. */
  level: Level;
  door: "one-way" | "two-way";
  sensitiveHits: string[];
  oneWayHits: string[];
  deleted: string[];
  /** Files in the diff that no plan `where:` lists, outside `test/` and `docs/`, each with its reason. */
  unplanned: { file: string; reason: string }[];
};

export type Ledger = {
  source: "run" | "git";
  host: Host;
  /** Login of the host token owner, or `unknown`. */
  tokenOwner: string;
  /** Git source only: what each base probe answered (a name, `none` or `unknown`) and which one won. */
  baseProbe: {
    mergeRequestTarget: string;
    originHead: string;
    hostDefault: string;
    chosen: string;
  } | null;
  ticket: {
    id: string;
    title: string;
    summary: string | null;
    kind: string;
    problem: string;
    change: string;
    criteria: { id: string; text: string; method: string; verified_by: string[] }[];
  } | null;
  /** Ticket ids found in the branch name and the commit subjects (git source). */
  trackerRefs: string[];
  plan: { why: string; risks: string[]; interfaces: { name: string; callers: string[] }[] } | null;
  criteria: { id: string; status: CriterionStatus; evidenced: boolean }[];
  /** `null` when the run folder has no `results/evidence/`. */
  evidence: EvidenceEntry[] | null;
  /** Findings no later review closed with `No findings.` or a `send back` decision. */
  findings: Finding[];
  hasReviewerStep: boolean;
  /** The block of the latest findings file; `null` when the file has none, or there is no file. */
  reviewer: ReviewerBlock | null;
  mergeOrder: string[];
  repos: RepoLedger[];
  /** Gates the human answered. A gate answered `by: auto` is not listed. */
  humanGates: string[];
  template: { path: string; text: string } | null;
  risk: RiskScore;
  prWriting: PrWriting;
  run: { id: string; directory: string; project: string } | null;
};

export type LedgerSource =
  | { runFolder: string; prWriting?: PrWriting }
  | { directory: string; base?: string; prWriting?: PrWriting };

const defaultPrWriting: PrWriting = {
  reviewers: [],
  tier_floor: 0,
  sensitive_paths: [],
  one_way_paths: [],
  agent_authored: true,
};

function capture(command: string[], cwd: string): string | null {
  try {
    const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
    return result.exitCode === 0 ? result.stdout.toString().trim() : null;
  } catch {
    return null; // the program is not installed
  }
}

function hostOf(remoteUrl: string | null): Host {
  const lowered = (remoteUrl ?? "").toLowerCase();
  if (lowered.includes("github.com")) return "github";
  if (lowered.includes("gitlab")) return "gitlab";
  return "unknown";
}

function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function tokenOwner(host: Host, cwd: string): string {
  if (host === "unknown") return "unknown";
  const answer =
    host === "github"
      ? capture(["gh", "api", "user", "--jq", ".login"], cwd)
      : (parseJson(capture(["glab", "api", "user"], cwd)) as { username?: string } | undefined)
          ?.username;
  return answer || "unknown";
}

// --- findings ---------------------------------------------------------------------------------

type FindingsFile = { name: string; group: string; sequence: number; text: string };

function readFindingsFiles(directory: string, reviewerSteps: string[]): FindingsFile[] {
  const folder = join(directory, "findings");
  if (!existsSync(folder)) return [];
  const rank = (group: string) => {
    const index = reviewerSteps.indexOf(group);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return readdirSync(folder)
    .filter((name) => name.endsWith(".md"))
    .map((name) => {
      const stem = name.slice(0, -3);
      const numbered = stem.match(/^(.*)-(\d+)$/);
      return {
        name,
        group: numbered ? numbered[1] : stem,
        sequence: numbered ? Number(numbered[2]) : 0,
        text: readFileSync(join(folder, name), "utf8"),
      };
    })
    .sort(
      (a, b) =>
        rank(a.group) - rank(b.group) || a.group.localeCompare(b.group) || a.sequence - b.sequence,
    );
}

function parseFindings(file: FindingsFile): Finding[] {
  const findings: Finding[] = [];
  for (const match of file.text.matchAll(/^###\s+(P[0-3])\b:?\s*(.*)$/gm))
    findings.push({ rank: match[1] as Finding["rank"], title: match[2].trim(), file: file.name });
  return findings;
}

/** A `## Run lead decision` line such as `- P1 <title>: send back, <reason>`: the first of `leave` and `send back` decides. */
function sentBack(file: FindingsFile, finding: Finding): boolean {
  const section = file.text.split(/^## Run lead decision\s*$/m)[1];
  if (section === undefined) return false;
  const title = finding.title.toLowerCase();
  for (const line of section.split("\n")) {
    const text = line.replace(/^\s*[-*]\s*/, "").replaceAll("*", "");
    if (!text.startsWith(finding.rank) || !text.toLowerCase().includes(title)) continue;
    const decision = text
      .slice(text.toLowerCase().indexOf(title) + title.length)
      .match(/send back|leave/i);
    if (decision) return decision[0].toLowerCase() === "send back";
  }
  return false;
}

function openFindings(files: FindingsFile[]): Finding[] {
  const openByGroup = new Map<string, Finding[]>();
  for (const file of files) {
    if (/^\s*No findings\.\s*$/m.test(file.text)) {
      openByGroup.set(file.group, []);
      continue;
    }
    const kept = parseFindings(file).filter((finding) => !sentBack(file, finding));
    openByGroup.set(file.group, [...(openByGroup.get(file.group) ?? []), ...kept]);
  }
  return [...openByGroup.values()].flat();
}

const ratings: Rating[] = ["good", "decent", "poor"];

export function parseReviewerBlock(text: string): ReviewerBlock | null {
  const start = text.search(/^## Merge risk\s*$/m);
  if (start === -1) return null;
  const rest = text.slice(start).split("\n").slice(1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  const block: ReviewerBlock = {
    ratings: {},
    door: null,
    recovery: "",
    blastRadius: "",
    unplanned: {},
  };
  for (const line of end === -1 ? rest : rest.slice(0, end)) {
    const item = line.match(/^\s*[-*]\s+([^:]+):\s*(.*)$/);
    if (!item) continue;
    const [, name, value] = item;
    const key = name.trim();
    if (
      key === "Verification" ||
      key === "Alignment" ||
      key === "Impact" ||
      key === "Rollback cost"
    ) {
      const rating = ratings.find((candidate) => value.trim().startsWith(candidate));
      if (rating) block.ratings[key] = rating;
    } else if (key === "Door") {
      block.door = value.trim().startsWith("one-way")
        ? "one-way"
        : value.trim().startsWith("two-way")
          ? "two-way"
          : null;
      block.recovery = value.match(/recovery:\s*(.*?)\)?\s*$/)?.[1] ?? "";
    } else if (key === "Blast radius") block.blastRadius = value.trim();
    else if (key === "Not in plan") {
      const [path, ...reason] = value.split(/\s+[—–-]\s+/);
      if (path.trim()) block.unplanned[path.trim().replaceAll("`", "")] = reason.join(" — ").trim();
    }
  }
  return block;
}

// --- risk -------------------------------------------------------------------------------------

const ratingScore: Record<Rating, number> = { good: 1, decent: 2, poor: 3 };

/** Weights of Warp's merge-risk skill without error detection: Verification 2, Impact 2, Rollback cost 1.5, Alignment 1. */
function weightedMean(verification: number, impact: number, rollback: number, alignment: number) {
  return (2 * verification + 2 * impact + 1.5 * rollback + alignment) / 6.5;
}

export function levelOf(mean: number): Level {
  return mean < 1.5 ? "low" : mean < 2.25 ? "medium" : "high";
}

const levelOrder: Level[] = ["low", "medium", "high"];

function pathMatches(pattern: string, path: string): boolean {
  const bare = pattern.replace(/\/+$/, "");
  return path === bare || path.startsWith(`${bare}/`) || new Bun.Glob(pattern).match(path);
}

/** Splits `a/{b,c}.ts, d.ts (note)` at the commas outside braces. */
function whereEntries(where: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of where) {
    if (character === "{") depth++;
    if (character === "}") depth--;
    if (character === "," && depth === 0) {
      entries.push(current);
      current = "";
    } else current += character;
  }
  entries.push(current);
  return entries
    .map((entry) => entry.replace(/\s*\(.*\)\s*$/, "").trim())
    .filter((entry) => entry !== "" && entry !== ".");
}

function scoreRisk(
  files: { path: string; status: string }[],
  criteria: Ledger["criteria"],
  plan: (Ledger["plan"] & { where: string[] }) | null,
  reviewer: ReviewerBlock | null,
  prWriting: PrWriting,
): RiskScore {
  const paths = files.map((file) => file.path);
  const hits = (patterns: string[]) =>
    paths.filter((path) => patterns.some((pattern) => pathMatches(pattern, path)));
  const sensitiveHits = hits(prWriting.sensitive_paths);
  const oneWayHits = hits(prWriting.one_way_paths);
  const deleted = files.filter((file) => file.status === "D").map((file) => file.path);
  const unplannedFiles =
    plan === null
      ? []
      : paths.filter(
          (path) =>
            !path.startsWith("test/") &&
            !path.startsWith("docs/") &&
            !plan.where.some((pattern) => pathMatches(pattern, path)),
        );

  const passing = (status: CriterionStatus) => status === "passing" || status === "manual ok";
  const verification = criteria.some((criterion) => !passing(criterion.status))
    ? 3
    : criteria.length === 0 || criteria.some((criterion) => !criterion.evidenced)
      ? 2
      : 1;
  const alignment = unplannedFiles.length === 0 ? 1 : unplannedFiles.length < 3 ? 2 : 3;
  const hasCallers = (plan?.interfaces ?? []).some((entry) => entry.callers.length > 0);
  const impact = 1 + (sensitiveHits.length > 0 ? 1 : 0) + (hasCallers ? 1 : 0);
  const rollback = 1 + (oneWayHits.length > 0 ? 1 : 0) + (deleted.length > 0 ? 1 : 0);
  const mean = weightedMean(verification, impact, rollback, alignment);
  const script = levelOf(mean);

  const rated = reviewer && Object.values(reviewer.ratings).length === 4 ? reviewer.ratings : null;
  const reviewerLevel = rated
    ? levelOf(
        weightedMean(
          ratingScore[rated.Verification!],
          ratingScore[rated.Impact!],
          ratingScore[rated["Rollback cost"]!],
          ratingScore[rated.Alignment!],
        ),
      )
    : null;
  const level =
    reviewerLevel !== null && levelOrder.indexOf(reviewerLevel) > levelOrder.indexOf(script)
      ? reviewerLevel
      : script;
  return {
    verification,
    alignment,
    impact,
    rollback,
    mean,
    script,
    reviewer: reviewerLevel,
    level,
    door: oneWayHits.length > 0 ? "one-way" : "two-way",
    sensitiveHits,
    oneWayHits,
    deleted,
    unplanned: unplannedFiles.map((file) => ({
      file,
      reason:
        Object.entries(reviewer?.unplanned ?? {}).find(
          ([path, reason]) => reason !== "" && (path === file || file.endsWith(`/${path}`)),
        )?.[1] ?? "no reason given",
    })),
  };
}

// --- git --------------------------------------------------------------------------------------

const templateCandidates = [
  ".gitlab/merge_request_templates/Default.md",
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  ".claude/rules/gitlab-mr-template.md",
];

function findTemplate(root: string): Ledger["template"] {
  const folder = join(root, ".gitlab", "merge_request_templates");
  const gitlab = existsSync(folder)
    ? readdirSync(folder)
        .filter((name) => name.endsWith(".md"))
        .sort()
        .map((name) => `.gitlab/merge_request_templates/${name}`)
    : [];
  const path = [...templateCandidates.slice(0, 1), ...gitlab, ...templateCandidates.slice(1)].find(
    (candidate) => existsSync(join(root, candidate)),
  );
  return path ? { path, text: readFileSync(join(root, path), "utf8") } : null;
}

function repoLedger(
  repo: string,
  directory: string,
  branch: string,
  base: string,
  dependsOn: string[],
): RepoLedger {
  const remoteBase = capture(
    ["git", "rev-parse", "--verify", "--quiet", `origin/${base}`],
    directory,
  );
  const baseRef = remoteBase ? `origin/${base}` : base;
  const head = capture(["git", "rev-parse", "HEAD"], directory) ?? "unknown";
  const baseSha = capture(["git", "merge-base", baseRef, "HEAD"], directory);
  if (baseSha === null)
    return {
      repo,
      branch,
      base,
      baseSha: "unknown",
      head,
      shortstat: "unknown",
      commits: [],
      files: [],
      dependsOn,
    };
  const commits = (
    capture(["git", "log", "--format=%H%x09%s", `${baseSha}..HEAD`], directory) ?? ""
  )
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => ({ sha: line.split("\t")[0], subject: line.split("\t").slice(1).join("\t") }));
  const files = (capture(["git", "diff", "--name-status", `${baseRef}...HEAD`], directory) ?? "")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [status, ...paths] = line.split("\t");
      return { path: paths.at(-1)!, status: status[0] };
    });
  return {
    repo,
    branch,
    base,
    baseSha,
    head,
    shortstat: capture(["git", "diff", "--shortstat", `${baseRef}...HEAD`], directory) ?? "unknown",
    commits,
    files: repo === "." ? files : files.map((file) => ({ ...file, path: `${repo}/${file.path}` })),
    dependsOn,
  };
}

function probeBase(directory: string, host: Host, branch: string) {
  let mergeRequestTarget = "unknown";
  let hostDefault = "unknown";
  if (host === "github" && branch !== "") {
    const listed = parseJson(
      capture(
        [
          "gh",
          "pr",
          "list",
          "--head",
          branch,
          "--state",
          "open",
          "--json",
          "baseRefName",
          "--limit",
          "1",
        ],
        directory,
      ),
    ) as { baseRefName?: string }[] | undefined;
    if (Array.isArray(listed)) mergeRequestTarget = listed[0]?.baseRefName || "none";
    const name = capture(
      ["gh", "repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
      directory,
    );
    if (name !== null) hostDefault = name || "none";
  } else if (host === "gitlab" && branch !== "") {
    const listed = parseJson(
      capture(["glab", "mr", "list", "--source-branch", branch, "--output", "json"], directory),
    ) as { target_branch?: string }[] | undefined;
    if (Array.isArray(listed)) mergeRequestTarget = listed[0]?.target_branch || "none";
    const project = parseJson(capture(["glab", "api", "projects/:id"], directory)) as
      | { default_branch?: string }
      | undefined;
    if (project !== undefined) hostDefault = project.default_branch || "none";
  }
  const symbolic = capture(
    ["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    directory,
  );
  return {
    mergeRequestTarget,
    originHead: symbolic ? symbolic.replace(/^origin\//, "") : "none",
    hostDefault,
  };
}

function gitLedger(source: { directory: string; base?: string; prWriting?: PrWriting }): Ledger {
  const root = capture(["git", "rev-parse", "--show-toplevel"], source.directory);
  if (root === null) throw new ArkError(`${source.directory} is not a git repository`);
  const host = hostOf(capture(["git", "remote", "get-url", "origin"], root));
  const branch = capture(["git", "symbolic-ref", "--short", "HEAD"], root) ?? "";
  const probes = probeBase(root, host, branch);
  const chosen = [
    source.base,
    probes.mergeRequestTarget,
    probes.originHead,
    probes.hostDefault,
  ].find((candidate) => candidate !== undefined && candidate !== "none" && candidate !== "unknown");
  if (chosen === undefined)
    throw new ArkError(
      `cannot tell the base branch (open MR target ${probes.mergeRequestTarget}, origin/HEAD ${probes.originHead}, host default branch ${probes.hostDefault}): pass --base <branch>`,
    );
  const repo = repoLedger(".", root, branch, chosen, []);
  const prWriting = source.prWriting ?? defaultPrWriting;
  const risk = scoreRisk(repo.files, [], null, null, prWriting);
  return {
    source: "git",
    host,
    tokenOwner: tokenOwner(host, root),
    baseProbe: { ...probes, chosen },
    ticket: null,
    trackerRefs: [
      ...new Set(
        [branch, ...repo.commits.map((commit) => commit.subject)].flatMap(
          (text) => text.match(/\b[A-Z][A-Z0-9]*-\d+\b/g) ?? [],
        ),
      ),
    ],
    plan: null,
    criteria: [],
    evidence: null,
    findings: [],
    hasReviewerStep: false,
    reviewer: null,
    mergeOrder: ["."],
    repos: [repo],
    humanGates: [],
    template: findTemplate(root),
    risk,
    prWriting,
    run: null,
  };
}

// --- run folder -------------------------------------------------------------------------------

function section(body: string, heading: string): string {
  const start = body.search(new RegExp(`^## ${heading}\\s*$`, "m"));
  if (start === -1) return "";
  const rest = body.slice(start).split("\n").slice(1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

function listScreenshots(folder: string, relative: string): string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listScreenshots(join(folder, entry.name), `${relative}/${entry.name}`)
      : /\.(png|jpe?g|webp|gif)$/i.test(entry.name)
        ? [`${relative}/${entry.name}`]
        : [],
  );
}

function readEvidence(directory: string): EvidenceEntry[] | null {
  const root = join(directory, "results", "evidence");
  if (!existsSync(root)) return null;
  const sideResult = (testCase: string, side: string): { status: string; sha: string } => {
    const file = join(root, testCase, side, "result.json");
    const parsed = existsSync(file) ? parseJson(readFileSync(file, "utf8")) : undefined;
    const { status, sha } = (parsed ?? {}) as { status?: string; sha?: string };
    return { status: status ?? "missing", sha: sha ?? "" };
  };
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const base = sideResult(entry.name, "base");
      const head = sideResult(entry.name, "head");
      return {
        testCase: entry.name,
        base: base.status,
        head: head.status,
        sha: head.sha,
        screenshots: ["base", "head"].flatMap((side) =>
          listScreenshots(
            join(root, entry.name, side, "screenshots"),
            `results/evidence/${entry.name}/${side}/screenshots`,
          ),
        ),
      };
    });
}

/** Repos in merge order: a repo comes after the repos whose steps its steps need. */
function orderRepos(steps: { id: string; repo: string; needs: string[] }[]) {
  const repoOfStep = new Map(steps.map((step) => [step.id, step.repo]));
  const upstream = new Map<string, Set<string>>();
  for (const step of steps) {
    const dependencies = upstream.get(step.repo) ?? new Set<string>();
    for (const needed of step.needs) {
      const neededRepo = repoOfStep.get(needed);
      if (neededRepo !== undefined && neededRepo !== step.repo) dependencies.add(neededRepo);
    }
    upstream.set(step.repo, dependencies);
  }
  const order: string[] = [];
  const pending = [...upstream.keys()];
  while (pending.length > 0) {
    const next = pending.findIndex((repo) =>
      [...upstream.get(repo)!].every((name) => order.includes(name)),
    );
    if (next === -1)
      throw new ArkError(`the plan has a dependency cycle between repos: ${pending.join(", ")}`);
    order.push(...pending.splice(next, 1));
  }
  return { order, upstream };
}

function runLedger(source: { runFolder: string; prWriting?: PrWriting }): Ledger {
  const directory = source.runFolder;
  const events: ArkEvent[] = readEvents(directory);
  const state = deriveState(events);
  const ticketFile = join(directory, "ticket.md");
  const fields = existsSync(ticketFile) ? frontmatterOf(ticketFile) : {};
  const body = existsSync(ticketFile)
    ? readFileSync(ticketFile, "utf8").replace(/^---[\s\S]*?\n---\r?\n/, "")
    : "";
  const criteria = parseCriteria(fields, ticketFile);
  const texts = new Map(
    ((fields.acceptance_criteria ?? []) as { id: string; text: string }[]).map((entry, i) => [
      criteria[i]?.id,
      entry.text,
    ]),
  );
  const prWriting =
    source.prWriting ??
    (existsSync(join(projectDirectory(state.project), "ark.yml"))
      ? loadConfig(state.project).pr_writing
      : defaultPrWriting);

  const planFile = join(directory, "plan.yml");
  const plan = existsSync(planFile) ? loadPlan(directory, state.ticket.id) : null;
  const evidence = readEvidence(directory);
  const evidenced = (id: string) => {
    const entry = criteria.find((criterion) => criterion.id === id)!;
    return entry.verified_by.length > 0
      ? entry.verified_by.every((testCase) =>
          evidence?.some((item) => item.testCase === testCase && item.head !== "missing"),
        )
      : existsSync(evidenceFile(directory, id));
  };

  const reviewerSteps = [
    ...new Set(
      events
        .filter(
          (event) =>
            event.type === "step.started" && event.data.role === "reviewer" && !event.data.merge,
        )
        .map((event) => event.data.step as string),
    ),
  ];
  const findingsFiles = readFindingsFiles(directory, reviewerSteps);
  const latest = findingsFiles.at(-1);
  const reviewer = latest ? parseReviewerBlock(latest.text) : null;

  const { order, upstream } = orderRepos(plan?.steps ?? []);
  const worktrees = state.worktrees;
  const repos = [
    ...order,
    ...worktrees.map((worktree) => worktree.repo).filter((repo) => !order.includes(repo)),
  ]
    .map((repo) => worktrees.find((worktree) => worktree.repo === repo))
    .filter((worktree) => worktree !== undefined)
    .map((worktree) => {
      const dependsOn = [...(upstream.get(worktree.repo) ?? [])].flatMap((name) =>
        state.merge_requests
          .filter((merge) => merge.repo === name)
          .map(
            (merge) => `Depends on ${hostOf(merge.url) === "github" ? "#" : "!"}${merge.number}`,
          ),
      );
      return existsSync(worktree.path)
        ? repoLedger(
            worktree.repo,
            worktree.path,
            worktree.branch,
            worktree.base ?? "main",
            dependsOn,
          )
        : ({
            repo: worktree.repo,
            branch: worktree.branch,
            base: worktree.base ?? "unknown",
            baseSha: "unknown",
            head: "unknown",
            shortstat: "unknown",
            commits: [],
            files: [],
            dependsOn,
          } satisfies RepoLedger);
    });

  const ledgerCriteria = state.criteria.map(({ id, status }) => ({
    id,
    status,
    evidenced: evidenced(id),
  }));
  const files = repos.flatMap((repo) => repo.files);
  const planWithWhere = plan
    ? {
        why: plan.summary.why,
        risks: state.evaluation?.risks ?? [],
        interfaces: plan.design.interfaces,
        where: plan.summary.changes.flatMap((change) => whereEntries(change.where)),
      }
    : null;
  const firstRemote =
    repos[0] && existsSync(worktrees[0]?.path ?? "")
      ? capture(["git", "remote", "get-url", "origin"], worktrees[0].path)
      : null;
  const host = hostOf(firstRemote);
  const gateNames = events
    .filter((event) => event.type === "gate.answered" && event.data.by !== "auto")
    .map((event) =>
      event.data.gate === "manual" ? `manual:${event.data.criterion}` : (event.data.gate as string),
    );

  return {
    source: "run",
    host,
    tokenOwner: tokenOwner(
      host,
      worktrees[0]?.path && existsSync(worktrees[0].path) ? worktrees[0].path : directory,
    ),
    baseProbe: null,
    ticket: {
      id: state.ticket.id,
      title: state.ticket.title,
      summary: typeof fields.summary === "string" ? fields.summary : null,
      kind: state.kind,
      problem: section(body, "Problem"),
      change: section(body, "Change"),
      criteria: criteria.map((criterion) => ({
        id: criterion.id,
        text: texts.get(criterion.id) ?? "",
        method: criterion.method,
        verified_by: criterion.verified_by,
      })),
    },
    trackerRefs: [state.ticket.id],
    plan: planWithWhere && {
      why: planWithWhere.why,
      risks: planWithWhere.risks,
      interfaces: planWithWhere.interfaces,
    },
    criteria: ledgerCriteria,
    evidence,
    findings: openFindings(findingsFiles),
    hasReviewerStep: (plan?.steps ?? []).some((step) => step.role === "reviewer"),
    reviewer,
    mergeOrder: order,
    repos,
    humanGates: [...new Set(gateNames)],
    template:
      worktrees[0] && existsSync(worktrees[0].path) ? findTemplate(worktrees[0].path) : null,
    risk: scoreRisk(files, ledgerCriteria, planWithWhere, reviewer, prWriting),
    prWriting,
    run: { id: state.run, directory, project: state.project },
  };
}

export function buildLedger(source: LedgerSource): Ledger {
  return "runFolder" in source ? runLedger(source) : gitLedger(source);
}
