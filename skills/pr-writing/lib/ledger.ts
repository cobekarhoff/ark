/**
 * The ledger: every fact the MR title, body and lint need, gathered once.
 * `buildLedger({ runFolder })` reads an Ark run folder; `buildLedger({ directory })` reads git and the host.
 * A host probe that fails is recorded as `unknown`, never `none`: `none` means the host answered and found nothing.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { evidenceFile, frontmatter, parseCriteria } from "../../../cli/ticket.ts";
import { loadConfig, type PrWriting } from "../../../cli/config.ts";
import { ArkError } from "../../../cli/errors.ts";
import { deriveState, readEvents, type ArkEvent } from "../../../cli/events.ts";
import type { CriterionStatus } from "../../../cli/lifecycle.ts";
import { projectDirectory } from "../../../cli/paths.ts";
import { loadPlan, repoGraph } from "../../../cli/plan.ts";
import { hashBody } from "./lint.ts";

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
  /** Last 20 lines of the head `command.log`. Absent in a ledger saved before ARK-399, and when the file is missing. */
  log?: string[];
};

export type RepoLedger = {
  repo: string;
  branch: string;
  base: string;
  baseSha: string;
  /** The ref the diff was read against (`origin/<base>` or `<base>`), so the lint does not probe it again. */
  baseRef?: string;
  head: string;
  /** `git diff --shortstat` text, or `unknown` when the base cannot be read. */
  shortstat: string;
  commits: { sha: string; subject: string; message: string }[];
  files: { path: string; status: string }[];
  /** `Depends on #N` or `Depends on !N` lines for the upstream repos whose MR is open. */
  dependsOn: string[];
  /** Worktree (or repo root) directory. A ledger written before per-repo fields lacks these four; readers fall back to the run-level values. */
  path: string;
  host: Host;
  tokenOwner: string;
  template: { path: string; text: string } | null;
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
  /** Text of `results/evidence/<AC id>.md` for each AC with no test case. Absent in an old ledger. */
  acEvidence?: { id: string; text: string }[];
  /** Findings no later review closed with `No findings.` or a `send back` decision. */
  findings: Finding[];
  hasReviewerStep: boolean;
  /** Each `checks` entry of `ark.yml` with the outcome of the last `test.completed`; `not run` when that event has a `checks` list without it, `unknown` when the event has no `checks` list (an old run). */
  checks: { name: string; state: "passed" | "failed" | "not run" | "unknown" }[];
  /** Test files the last `test.completed` lists as flaky: they failed once and passed on retry. */
  flaky: { suite: string; file: string }[];
  /** Test counts of the last `test.completed`; `null` when it has none (an old run) or there is no such event. A quick run has no `baseSkipped` and no `deleted`. */
  tests: {
    passed: number;
    skipped: number;
    baseSkipped?: number;
    deleted?: { file?: string; name: string }[];
  } | null;
  /** The block of the latest findings file; `null` when the file has none, or there is no file. */
  reviewer: ReviewerBlock | null;
  mergeOrder: string[];
  repos: RepoLedger[];
  /** Gates the human answered. A gate answered `by: auto` is not listed. */
  humanGates: string[];
  template: { path: string; text: string } | null;
  risk: RiskScore;
  prWriting: PrWriting;
  run: {
    id: string;
    directory: string;
    project: string;
    /** Time of the first event and of the last `test.completed` (else the last event): opening or refreshing an MR must not change it. */
    startedAt: string;
    endedAt: string;
    rounds: number;
  } | null;
};

export type LedgerSource =
  | { runFolder: string; prWriting?: PrWriting; dryRun?: boolean; heads?: Record<string, string> }
  | { directory: string; base?: string; prWriting?: PrWriting; dryRun?: boolean };

const defaultPrWriting: PrWriting = {
  reviewers: [],
  tier_floor: 0,
  sensitive_paths: [],
  one_way_paths: [],
  agent_authored: true,
};

/** Set while a `--dry-run` ledger is built: each `gh`/`glab` call the build makes is printed. */
let printHostCalls = false;

function capture(command: string[], cwd: string): string | null {
  if (printHostCalls && (command[0] === "gh" || command[0] === "glab"))
    console.log(`dry-run: ${command.join(" ")}`);
  try {
    const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
    return result.exitCode === 0 ? result.stdout.toString().trim() : null;
  } catch {
    return null; // the program is not installed
  }
}

export function hostOf(remoteUrl: string | null): Host {
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

export function tokenOwner(host: Host, cwd: string): string {
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
  for (const match of file.text.matchAll(/^###\s+(P[0-3])(?:-\d+)?\b:?\s*(.*)$/gm))
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

/** `round-N.md` is the run lead's send-back file, not a review: each finding in it is the fix decision for the review finding with the same title. */
const roundFile = /^round-\d+\.md$/;

function openFindings(files: FindingsFile[]): Finding[] {
  const decided = new Set(
    files
      .filter((file) => roundFile.test(file.name))
      .flatMap((file) => parseFindings(file).map((finding) => finding.title.toLowerCase())),
  );
  const openByGroup = new Map<string, Finding[]>();
  for (const file of files.filter((entry) => !roundFile.test(entry.name))) {
    if (/^\s*No findings\.\s*$/m.test(file.text)) {
      openByGroup.set(file.group, []);
      continue;
    }
    const kept = parseFindings(file).filter((finding) => !sentBack(file, finding));
    openByGroup.set(file.group, [...(openByGroup.get(file.group) ?? []), ...kept]);
  }
  return [...openByGroup.values()]
    .flat()
    .filter((finding) => !decided.has(finding.title.toLowerCase()));
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

export function findTemplate(root: string): Ledger["template"] {
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

/** The host, token owner and template of the repo at `directory`. */
function repoIdentity(
  directory: string,
  remote?: string | null,
): Pick<RepoLedger, "path" | "host" | "tokenOwner" | "template"> {
  const host = hostOf(
    remote === undefined ? capture(["git", "remote", "get-url", "origin"], directory) : remote,
  );
  return {
    path: directory,
    host,
    tokenOwner: tokenOwner(host, directory),
    template: findTemplate(directory),
  };
}

function repoLedger(
  repo: string,
  directory: string,
  branch: string,
  base: string,
  dependsOn: string[],
  knownHead?: string,
): Omit<RepoLedger, keyof ReturnType<typeof repoIdentity>> {
  const remoteBase = capture(
    ["git", "rev-parse", "--verify", "--quiet", `origin/${base}`],
    directory,
  );
  const baseRef = remoteBase ? `origin/${base}` : base;
  const head = knownHead ?? capture(["git", "rev-parse", "HEAD"], directory) ?? "unknown";
  const baseSha = capture(["git", "merge-base", baseRef, "HEAD"], directory);
  if (baseSha === null)
    return {
      repo,
      branch,
      base,
      baseSha: "unknown",
      baseRef,
      head,
      shortstat: "unknown",
      commits: [],
      files: [],
      dependsOn,
    };
  const commits = (
    capture(["git", "log", "--format=%H%x1f%B%x1e", `${baseSha}..HEAD`], directory) ?? ""
  )
    .split("\x1e")
    .map((record) => record.trim())
    .filter((record) => record !== "")
    .map((record) => {
      const [sha, message] = record.split("\x1f");
      return { sha, subject: message.split("\n")[0], message: message.trim() };
    });
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
    baseRef,
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
  const repo = { ...repoLedger(".", root, branch, chosen, []), ...repoIdentity(root) };
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
    checks: [],
    flaky: [],
    tests: null,
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

const logTail = (file: string): string[] | undefined =>
  existsSync(file) ? readFileSync(file, "utf8").trimEnd().split("\n").slice(-20) : undefined;

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
        log: logTail(join(root, entry.name, "head", "command.log")),
        screenshots: ["base", "head"].flatMap((side) =>
          listScreenshots(
            join(root, entry.name, side, "screenshots"),
            `results/evidence/${entry.name}/${side}/screenshots`,
          ),
        ),
      };
    });
}

function runLedger(source: {
  runFolder: string;
  prWriting?: PrWriting;
  heads?: Record<string, string>;
}): Ledger {
  const directory = source.runFolder;
  const events: ArkEvent[] = readEvents(directory);
  const state = deriveState(events);
  const ticketFile = join(directory, "ticket.md");
  const ticket = existsSync(ticketFile)
    ? frontmatter(readFileSync(ticketFile, "utf8"))
    : { fields: undefined, body: "" };
  const fields = ticket.fields ?? {};
  const body = ticket.body;
  const criteria = parseCriteria(fields, ticketFile);
  const texts = new Map(
    ((fields.acceptance_criteria ?? []) as { id: string; text: string }[]).map((entry, i) => [
      criteria[i]?.id,
      entry.text,
    ]),
  );
  const hasConfig = existsSync(join(projectDirectory(state.project), "ark.yml"));
  const config = hasConfig ? loadConfig(state.project) : null;
  const prWriting = source.prWriting ?? config?.pr_writing ?? defaultPrWriting;
  const lastTest = events.filter((event) => event.type === "test.completed").at(-1);
  const recordedList = lastTest?.data.checks as { name: string; passed: boolean }[] | undefined;
  const recordedChecks = recordedList ?? [];
  const checks = (config?.checks ?? []).map((check) => {
    const recorded = recordedChecks.find((entry) => entry.name === check.name);
    return {
      name: check.name,
      state:
        recorded === undefined
          ? recordedList === undefined
            ? ("unknown" as const)
            : ("not run" as const)
          : recorded.passed
            ? ("passed" as const)
            : ("failed" as const),
    };
  });

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
  // Only the reviewer steps' own findings carry the risk block: validator and live-check reports never count.
  const latest = findingsFiles
    .filter((file) => !roundFile.test(file.name) && reviewerSteps.includes(file.group))
    .at(-1);
  const reviewer = latest ? parseReviewerBlock(latest.text) : null;

  const { order, upstream } = plan
    ? repoGraph(plan)
    : { order: [], upstream: new Map<string, Set<string>>() };
  const worktrees = state.worktrees;
  const remotes = new Map<string, string | null>();
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
      // The recorded base is a commit: a file that `ark worktree sync` merged in from the target is not ours, so diff
      // against the target branch (configured base, else origin's HEAD), and keep the commit only as the last resort.
      const configured = config?.repos?.[worktree.repo]?.base;
      const symbolic = capture(
        ["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        worktree.path,
      );
      const targetBranch = configured ?? (symbolic ? symbolic.replace(/^origin\//, "") : null);
      const remote = existsSync(worktree.path)
        ? capture(["git", "remote", "get-url", "origin"], worktree.path)
        : null;
      remotes.set(worktree.path, remote);
      return existsSync(worktree.path)
        ? {
            ...repoLedger(
              worktree.repo,
              worktree.path,
              worktree.branch,
              targetBranch ?? worktree.base ?? "main",
              dependsOn,
              source.heads?.[worktree.repo],
            ),
            ...repoIdentity(worktree.path, remote),
          }
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
            path: worktree.path,
            host: "unknown",
            tokenOwner: "unknown",
            template: null,
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
  const firstRemote = existsSync(worktrees[0]?.path ?? "")
    ? (remotes.get(worktrees[0].path) ?? null)
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
    acEvidence: criteria.flatMap(({ id, verified_by }) => {
      const file = evidenceFile(directory, id);
      return verified_by.length === 0 && existsSync(file)
        ? [{ id, text: readFileSync(file, "utf8").trim() }]
        : [];
    }),
    findings: openFindings(findingsFiles),
    hasReviewerStep: (plan?.steps ?? []).some((step) => step.role === "reviewer"),
    checks,
    flaky: lastTest?.data.flaky ?? [],
    tests:
      typeof lastTest?.data.passed_count === "number"
        ? {
            passed: lastTest.data.passed_count,
            skipped: lastTest.data.skipped ?? 0,
            ...(typeof lastTest.data.base_skipped === "number"
              ? { baseSkipped: lastTest.data.base_skipped }
              : {}),
            ...(Array.isArray(lastTest.data.deleted) ? { deleted: lastTest.data.deleted } : {}),
          }
        : null,
    reviewer,
    mergeOrder: order,
    repos,
    humanGates: [...new Set(gateNames)],
    template:
      worktrees[0] && existsSync(worktrees[0].path) ? findTemplate(worktrees[0].path) : null,
    risk: scoreRisk(files, ledgerCriteria, planWithWhere, reviewer, prWriting),
    prWriting,
    run: {
      id: state.run,
      directory,
      project: state.project,
      startedAt: events[0]?.time ?? "",
      endedAt: lastTest?.time ?? events.at(-1)?.time ?? "",
      rounds: state.round,
    },
  };
}

export function buildLedger(source: LedgerSource): Ledger {
  printHostCalls = source.dryRun === true;
  try {
    return "runFolder" in source ? runLedger(source) : gitLedger(source);
  } finally {
    printHostCalls = false;
  }
}

// --- standalone config -------------------------------------------------------------------------

/**
 * The standalone pr-writing config: `.pr-writing.toml` at the repo root, then `PR_WRITING_<KEY>` environment
 * variables on top. Keys: reviewers, tier_floor, sensitive_paths, agent_authored, title_prefix, checks.
 * The `ark.yml` block is read by `cli/config.ts` and keeps its own validation; `one_way_paths` lives only there.
 * A list is comma separated in the environment, a boolean is `true` or `false`, `tier_floor` is an integer 0 to 3.
 */
export const configKeys = [
  "reviewers",
  "tier_floor",
  "sensitive_paths",
  "agent_authored",
  "title_prefix",
  "checks",
] as const;
type Key = (typeof configKeys)[number];

/** `checks` holds shell commands, run by `runChecks`. */
export type StandaloneConfig = PrWriting & { checks: string[] };

/** The file has a key outside `configKeys`. Scripts print `key` in their JSON error. */
export class UnknownConfigKey extends ArkError {
  constructor(readonly key: string) {
    super(`unknown key "${key}" in .pr-writing.toml; valid keys: ${configKeys.join(", ")}`);
  }
}

const defaults: StandaloneConfig = {
  reviewers: [],
  tier_floor: 0,
  sensitive_paths: [],
  one_way_paths: [],
  agent_authored: true,
  checks: [],
};

const parsers: Record<Key, (raw: string, source: string) => unknown> = {
  reviewers: (raw) => list(raw),
  sensitive_paths: (raw) => list(raw),
  checks: (raw) => list(raw),
  title_prefix: (raw) => raw,
  agent_authored: (raw, source) => {
    if (raw !== "true" && raw !== "false") throw new ArkError(`${source} must be true or false`);
    return raw === "true";
  },
  tier_floor: (raw, source) => {
    if (!/^[0-3]$/.test(raw)) throw new ArkError(`${source} must be an integer from 0 to 3`);
    return Number(raw);
  },
};

const list = (raw: string) =>
  raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");

function checkFileValue(key: Key, value: unknown) {
  const source = `.pr-writing.toml ${key}`;
  const ok =
    key === "tier_floor"
      ? Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 3
      : key === "agent_authored"
        ? typeof value === "boolean"
        : key === "title_prefix"
          ? typeof value === "string"
          : Array.isArray(value) && value.every((item) => typeof item === "string");
  if (!ok)
    throw new ArkError(
      `${source} must be ${
        key === "tier_floor"
          ? "an integer from 0 to 3"
          : key === "agent_authored"
            ? "true or false"
            : key === "title_prefix"
              ? "a string"
              : "a list of strings"
      }`,
    );
}

/** The effective config of the repo at `root`: defaults, then the file, then `PR_WRITING_<KEY>`. */
export function loadStandaloneConfig(
  root: string,
  env: Record<string, string | undefined> = process.env,
): StandaloneConfig {
  const config: Record<string, unknown> = { ...defaults };
  const file = join(root, ".pr-writing.toml");
  if (existsSync(file)) {
    let parsed: Record<string, unknown>;
    try {
      parsed = Bun.TOML.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch (error) {
      throw new ArkError(`.pr-writing.toml is not valid TOML: ${(error as Error).message}`);
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (!(configKeys as readonly string[]).includes(key)) throw new UnknownConfigKey(key);
      checkFileValue(key as Key, value);
      config[key] = value;
    }
  }
  for (const key of configKeys) {
    const name = `PR_WRITING_${key.toUpperCase()}`;
    const raw = env[name];
    if (raw !== undefined) config[key] = parsers[key](raw, name);
  }
  return config as StandaloneConfig;
}

// --- persisted ledger --------------------------------------------------------------------------

/**
 * The persisted ledger, the one place STALE01 reads between `gather`, `lint_body` and `post_mr`:
 * `<repo root>/.pr-writing/ledger.json`, written by `writeLedgerFile`.
 *
 * Format (one JSON object):
 *   { "version": 1,
 *     "ledger": <Ledger>,            // `buildLedger` output at gather time; its repos[].head is the head STALE01 compares
 *     "bodyHash": <string | null> }  // `hashBody` of the generated body when `lint_body` last passed it, else null
 * STALE01 fails when the current head differs from a ledger head, or the body hash differs from the body posted.
 */
export type LedgerFile = { version: 1; ledger: Ledger; bodyHash: string | null };

export const ledgerPath = (root: string) => join(root, ".pr-writing", "ledger.json");

export function writeLedgerFile(root: string, ledger: Ledger): void {
  const path = ledgerPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const file: LedgerFile = { version: 1, ledger, bodyHash: null };
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}

export function readLedgerFile(root: string): LedgerFile {
  const path = ledgerPath(root);
  if (!existsSync(path)) throw new ArkError(`no ${path}: run gather.ts first`);
  const file = JSON.parse(readFileSync(path, "utf8")) as LedgerFile;
  if (file.version !== 1) throw new ArkError(`${path} has an unknown version, expected 1`);
  return file;
}

/** Records the hash of the body that passed lint, so a later edit makes STALE01 fail. */
export function recordBodyHash(root: string, body: string): void {
  const file = readLedgerFile(root);
  writeFileSync(
    ledgerPath(root),
    `${JSON.stringify({ ...file, bodyHash: hashBody(body) }, null, 2)}\n`,
  );
}

// --- review checks -----------------------------------------------------------------------------

/**
 * The review checks runner: runs each configured shell command in `directory` and records the outcome.
 * It changes no file itself. A tool that is not installed is `not_run` with a null exit code, never a failure.
 */
export type CheckRecord = {
  command: string;
  /** `null` when the command could not start. */
  exit_code: number | null;
  status: "pass" | "fail" | "not_run";
  /** The last `tailLines` lines of stdout and stderr together. */
  output_tail: string;
};

export const tailLines = 50;

const tail = (text: string) => text.replace(/\n$/, "").split("\n").slice(-tailLines).join("\n");

export function runChecks(commands: string[], directory: string): CheckRecord[] {
  return commands.map((command) => {
    const result = Bun.spawnSync(["sh", "-c", command], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = result.stdout.toString() + result.stderr.toString();
    // `sh` answers 127 when the command is not found and 126 when it cannot be run.
    if (result.exitCode === 127 || result.exitCode === 126)
      return { command, exit_code: null, status: "not_run", output_tail: tail(output) };
    return {
      command,
      exit_code: result.exitCode,
      status: result.exitCode === 0 ? "pass" : "fail",
      output_tail: tail(output),
    };
  });
}
