import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArkError } from "./errors.ts";
import { canonicalCriterion } from "./criterion-id.ts";
import { appendEvent, deriveState, readEvents, type ArkEvent, type RunState } from "./events.ts";
import { loadConfig, mergeRequestsMode } from "./config.ts";
import { findRun } from "./paths.ts";
import { loadPlan, repoGraph, type Plan, type PlanRepoEdge } from "./plan.ts";
import {
  evidenceFile,
  evidenceProblem,
  frontmatter,
  hasTestCriterion,
  manualCriteria,
  runCriteria,
} from "./ticket.ts";
import { manualStatus } from "./lifecycle.ts";
import { discoverRepos, repoBase } from "./workspace.ts";
import { buildBody } from "../skills/pr-writing/lib/body.ts";
import {
  buildLedger,
  findTemplate,
  type Ledger,
  tokenOwner,
} from "../skills/pr-writing/lib/ledger.ts";
import { lintBody } from "../skills/pr-writing/lib/lint.ts";
import { buildTitle, postMergeRequest } from "../skills/pr-writing/lib/post.ts";

type Worktree = { repo: string; path: string; branch: string; base: string };
type OpenedMergeRequest = { repo: string; url: string; number: number };
type Host = "github" | "gitlab";

function spawn(command: string[], cwd: string) {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

function run(command: string[], cwd: string): string {
  const result = spawn(command, cwd);
  if (!result.ok)
    throw new ArkError(
      `\`${command.slice(0, 3).join(" ")}\` failed in ${cwd}: ${result.stderr || result.stdout}`,
    );
  return result.stdout;
}

function detectHost(remoteUrl: string): Host {
  const lowered = remoteUrl.toLowerCase();
  if (lowered.includes("github.com")) return "github";
  if (lowered.includes("gitlab")) return "gitlab";
  throw new ArkError(`cannot tell GitHub from GitLab for remote ${remoteUrl}`);
}

function criterionTexts(runDirectory: string): Map<string, Criterion> {
  const fields = (frontmatter(readFileSync(join(runDirectory, "ticket.md"), "utf8")).fields ??
    {}) as {
    id?: string;
    acceptance_criteria?: { id: string; text: string }[];
  };
  const manual = new Set(manualCriteria(runDirectory));
  return new Map(
    (fields.acceptance_criteria ?? []).map(({ id: written, text }) => {
      const id = canonicalCriterion(written, fields.id);
      return [id, { id, text, manual: manual.has(id) }];
    }),
  );
}

type Criterion = { id: string; text: string; manual: boolean };

/**
 * The strings of an AC that the check counts. A span in backticks must sit on one line and be non-blank.
 * `required` passes when a tracked file at head holds it or it names a tracked file or folder at head; `removed` (the span had a `not:` prefix, now cut) must be in none.
 * Not counted: any string of a manual AC; a string with a placeholder (`<` then `>`, or a lone `<`), a `*`, `...`
 * or a `:<digits>` or `:<digits>-<digits>` suffix; a string that holds the id of its own AC (`-` or `_`).
 */
export function requiredLiterals(criterion: Criterion): { required: string[]; removed: string[] } {
  const required = new Set<string>();
  const removed = new Set<string>();
  if (criterion.manual) return { required: [], removed: [] };
  const flat = (value: string) => value.replaceAll("-", "_").replaceAll("/", "_");
  const id = flat(criterion.id);
  for (const [, span] of criterion.text.matchAll(/`([^`\n]+)`/g)) {
    if (span.trim() === "") continue;
    const isRemoved = span.startsWith("not:");
    const literal = isRemoved ? span.slice(4) : span;
    if (
      literal.trim() === "" ||
      literal.includes("<") ||
      literal.includes("*") ||
      literal.includes("...") ||
      /:\d+(-\d+)?$/.test(literal) ||
      flat(literal).includes(id)
    )
      continue;
    (isRemoved ? removed : required).add(literal);
  }
  return { required: [...required], removed: [...removed] };
}

/**
 * Required AC strings that no tracked file at HEAD of any repo of the run holds, and removed ones that some file
 * still holds. A touched repo is searched in its run worktree, an untouched one at its workspace checkout, which
 * the mirror links to.
 */
function absentLiterals(
  criteria: Map<string, Criterion>,
  repoPaths: string[],
): {
  absent: { criterion: string; literal: string }[];
  present: { criterion: string; literal: string }[];
} {
  // A path string is present when it names a tracked file or folder at HEAD. A lone `/` strips to "" (the root
  // tree), so an empty path never counts.
  const found = (literal: string) => {
    const treePath = literal.replace(/\/$/, "");
    return repoPaths.some(
      (repoPath) =>
        spawn(["git", "grep", "-F", "-q", "-e", literal, "HEAD"], repoPath).ok ||
        (treePath !== "" && spawn(["git", "cat-file", "-e", `HEAD:${treePath}`], repoPath).ok),
    );
  };
  const absent: { criterion: string; literal: string }[] = [];
  const present: { criterion: string; literal: string }[] = [];
  for (const [criterion, value] of criteria) {
    const { required, removed } = requiredLiterals(value);
    for (const literal of required) if (!found(literal)) absent.push({ criterion, literal });
    for (const literal of removed) if (found(literal)) present.push({ criterion, literal });
  }
  return { absent, present };
}

/** Result files a perf run must leave: missing or empty ones. */
function emptyResultFiles(directory: string): string[] {
  return ["results/baseline.md", "results/compare.md"].filter((file) => {
    const path = join(directory, file);
    return !existsSync(path) || statSync(path).size === 0;
  });
}

/** The configured `repos.<repo>.base`, else the branch origin's HEAD names, else the worktree's base commit. */
function defaultBranch(worktree: Worktree, base: string | undefined): string {
  if (base !== undefined) return base;
  const result = spawn(
    ["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    worktree.path,
  );
  return result.ok ? result.stdout.replace(/^origin\//, "") : worktree.base;
}

// GitLab merge request dependencies need a paid tier. A failure is fine:
// the `Depends on !N` line in the description still carries the dependency.
function blockOnGitLab(
  downstream: OpenedMergeRequest,
  upstream: OpenedMergeRequest,
  downstreamPath: string,
  upstreamPath: string,
) {
  const lookup = spawn(
    ["glab", "api", `projects/:fullpath/merge_requests/${upstream.number}`],
    upstreamPath,
  );
  if (!lookup.ok) return;
  try {
    const upstreamId = JSON.parse(lookup.stdout).id;
    spawn(
      [
        "glab",
        "api",
        "--method",
        "POST",
        `projects/:fullpath/merge_requests/${downstream.number}/blocks?blocking_merge_request_id=${upstreamId}`,
      ],
      downstreamPath,
    );
  } catch {
    // unreadable response: skip the native dependency
  }
}

export type StaleHead = { repo: string; tested: string | undefined; current: string };

/** Repos whose worktree head differs from the head the last test.completed event recorded. */
export function staleHeads(events: ArkEvent[]): StaleHead[] {
  const lastTest = events.filter((event) => event.type === "test.completed").at(-1);
  if (lastTest === undefined) return [];
  const stale: StaleHead[] = [];
  for (const event of events) {
    if (event.type !== "worktree.created" || !existsSync(event.data.path)) continue;
    const current = run(["git", "rev-parse", "HEAD"], event.data.path);
    const tested: string | undefined = lastTest.data.heads?.[event.data.repo];
    if (tested !== current) stale.push({ repo: event.data.repo, tested, current });
  }
  return stale;
}

function worktreeMap(events: ArkEvent[]): Map<string, Worktree> {
  const worktrees = new Map<string, Worktree>();
  for (const event of events)
    if (event.type === "worktree.created") worktrees.set(event.data.repo, event.data as Worktree);
  return worktrees;
}

/** Local id `AC<k>` of a criterion, as the evidence refusals and files name it. */
const localId = (criterionId: string): string => criterionId.split("/").pop()!;

/**
 * The evidence refusals: a non-test AC needs a well-formed `results/evidence/<AC id>.md`; each case in the
 * `verified_by` of a `test` AC needs `base/` and `head/` folders, and the head SHA must be the current head of the repo that ran the case.
 * One line for each missing or bad item, so the refusal names every AC.
 */
function evidenceProblems(directory: string, events: ArkEvent[], lastTest: ArkEvent): string[] {
  const lines: string[] = [];
  const criteria = runCriteria(directory);
  for (const { id, method } of criteria) {
    if (method === "test") continue;
    const file = evidenceFile(directory, id);
    if (!existsSync(file)) {
      lines.push(`evidence missing: ${localId(id)} (${method})`);
      continue;
    }
    const problem = evidenceProblem(method, readFileSync(file, "utf8"));
    if (problem !== undefined) lines.push(`evidence malformed: ${localId(id)}: ${problem}`);
  }
  // Each result.json names the repo that ran its case: its SHA must be that repo's current head.
  const heads = new Map<string, string>(
    Object.entries((lastTest.data.heads ?? {}) as Record<string, string>),
  );
  for (const event of events)
    if (event.type === "worktree.created" && existsSync(event.data.path))
      heads.set(event.data.repo, run(["git", "rev-parse", "HEAD"], event.data.path));
  for (const { id, method, verified_by } of criteria) {
    if (method !== "test") continue;
    for (const testCase of verified_by) {
      const folder = join(directory, "results", "evidence", testCase);
      const missing = (["base", "head"] as const).filter(
        (side) => !existsSync(join(folder, side, "result.json")),
      );
      for (const side of missing)
        lines.push(`test evidence missing: ${localId(id)} ${testCase} (${side})`);
      if (missing.includes("head")) continue;
      let result: { sha?: unknown; repo?: unknown } = {};
      try {
        result = JSON.parse(readFileSync(join(folder, "head", "result.json"), "utf8"));
      } catch {
        // unreadable result.json: no SHA matches a head, so the case is stale
      }
      const head = typeof result.repo === "string" ? heads.get(result.repo) : undefined;
      if (typeof result.sha !== "string" || head === undefined || result.sha !== head)
        lines.push(`test evidence stale: ${localId(id)} ${testCase}`);
    }
  }
  return lines;
}

/**
 * The refusals shared by `ark merge-request open` and `ark run close <run> handed_off`: the test result, the
 * manual and non-manual ACs, the head of every repo, the AC strings, and the `perf` and `refactor` rules.
 */
export function assertShippable(
  runId: string,
  project: string,
  directory: string,
  events: ArkEvent[],
  state: RunState,
): void {
  const lastTest = events.filter((event) => event.type === "test.completed").at(-1);
  if (lastTest === undefined) throw new ArkError("no test result yet: run `ark test` first");
  const unproven = manualCriteria(directory).filter(
    (id) => manualStatus(state.gates[`manual:${id}`]) !== "manual ok",
  );
  if (unproven.length > 0)
    throw new ArkError(
      unproven.length === 1
        ? `manual criterion without ok: ${unproven.join(", ")}`
        : `manual criteria without ok: ${unproven.join(", ")}`,
    );
  const manual = new Set(manualCriteria(directory));
  // An old log names an AC `<ticket>-AC<k>` here: read it as `<ticket>/AC<k>`.
  const tested: Record<string, string> = Object.fromEntries(
    Object.entries((lastTest.data.criteria ?? {}) as Record<string, string>).map(([id, status]) => [
      canonicalCriterion(id, state.ticket.id),
      status,
    ]),
  );
  const notPassing = state.criteria.filter(({ id }) => !manual.has(id) && tested[id] !== "passing");
  if (notPassing.length > 0)
    throw new ArkError(
      `criteria not passing in the last test run: ${notPassing.map(({ id }) => `${id} (${tested[id] ?? "missing"})`).join(", ")}`,
    );
  if (!lastTest.data.passed)
    throw new ArkError("the last test run did not pass: fix the failures and run `ark test` again");
  const [first] = staleHeads(events);
  if (first !== undefined) {
    throw new ArkError(
      `repo ${first.repo} changed since the last test run (tested ${first.tested?.slice(0, 8) ?? "nothing"}, now ${first.current.slice(0, 8)}): run ark test ${runId} again`,
    );
  }

  const worktrees = worktreeMap(events);
  const repoPaths = discoverRepos(loadConfig(project).workspace).map(
    (repo) => worktrees.get(repo)?.path ?? join(loadConfig(project).workspace, repo),
  );
  const { absent, present } = absentLiterals(criterionTexts(directory), repoPaths);
  const list = (items: typeof absent) =>
    items.map(({ criterion, literal }) => `${criterion} \`${literal}\``).join("; ");
  if (absent.length > 0)
    throw new ArkError(`AC string in no tracked file at head: ${list(absent)}`);
  if (present.length > 0)
    throw new ArkError(`AC string still in a tracked file at head: ${list(present)}`);
  if (state.kind === "perf") {
    const bad = emptyResultFiles(directory);
    if (bad.length > 0)
      throw new ArkError(`perf run: missing or empty result file: ${bad.join(", ")}`);
  }
  if (state.kind === "refactor" && state.base_passed !== true && hasTestCriterion(directory))
    throw new ArkError(
      `refactor run: the suites ${state.base_passed === false ? "fail" : "were not run"} at the base commit: run ark test ${runId}`,
    );

  const evidence = evidenceProblems(directory, events, lastTest);
  if (evidence.length > 0)
    throw new ArkError(`refused: evidence is not complete\n${evidence.join("\n")}`);
}

/**
 * Pushes each repo, then opens its MR, or, for a repo that has one open, rewrites the generated part of its body
 * from the ledger of the run now. A repo whose MR is merged, closed or of unknown state is left alone.
 */
export function mergeRequestOpen(
  runId: string,
  inProject?: string,
  options: { summary?: string } = {},
): void {
  const { project, directory } = findRun(runId, inProject);
  if (mergeRequestsMode(project) === "none")
    throw new ArkError(
      `project ${project} has merge_requests: none: close the run with ark run close ${runId} handed_off`,
    );
  const projectConfig = loadConfig(project);
  const events = readEvents(directory);
  const state = deriveState(events);
  if (!["building", "escalation", "merge_requests_open"].includes(state.phase)) {
    throw new ArkError(`cannot open merge requests while the run is in phase ${state.phase}`);
  }

  assertShippable(runId, project, directory, events, state);

  const ledger = buildLedger({ runFolder: directory });
  const worktrees = worktreeMap(events);
  const plan = loadPlan(directory);
  const { order: graphOrder, upstream } = repoGraph(plan);
  const repos = [
    ...graphOrder,
    ...[...worktrees.keys()].filter((repo) => !graphOrder.includes(repo)),
  ];
  const opened = new Map<string, OpenedMergeRequest>();
  for (const event of events)
    if (event.type === "merge_request.opened")
      opened.set(event.data.repo, event.data as OpenedMergeRequest);
  const ahead = (worktree: Worktree) =>
    Number(run(["git", "rev-list", "--count", `${worktree.base}..HEAD`], worktree.path));
  const needsMergeRequest = (repo: string) => {
    const worktree = worktrees.get(repo);
    return worktree !== undefined && !opened.has(repo) && ahead(worktree) > 0;
  };
  // The title of the MRs this call creates, before any push: a title the rule refuses must not leave a pushed
  // branch. An open MR keeps its title, so a refresh needs none.
  const title = repos.some(needsMergeRequest) ? buildTitle(ledger, options.summary) : "";
  const folder = mkdtempSync(join(tmpdir(), "ark-mr-body-"));

  try {
    for (const repo of repos) {
      const worktree = worktrees.get(repo);
      if (worktree === undefined) continue;
      const existing = opened.get(repo);
      if (existing !== undefined) {
        const current = mergeRequestState(existing, worktree.path);
        if (current !== "open") {
          console.log(`${repo}  ${current}  ${existing.url}`);
          continue;
        }
      } else if (!needsMergeRequest(repo)) continue;

      const host = detectHost(run(["git", "remote", "get-url", "origin"], worktree.path));
      const upstreamOpened = [...(upstream.get(repo) ?? [])]
        .sort((left, right) => repos.indexOf(left) - repos.indexOf(right))
        .flatMap((name) => opened.get(name) ?? []);
      const marker = host === "github" ? "#" : "!";
      const dependsOn = upstreamOpened.map((merge) => `Depends on ${marker}${merge.number}`);
      // Evidence and risk are run-wide; host, token owner and template are this repo's own.
      const repoLedger: Ledger = {
        ...ledger,
        host,
        tokenOwner: tokenOwner(host, worktree.path),
        template: findTemplate(worktree.path),
        // A repo with no commits opens no MR, so the merge order leaves it out.
        mergeOrder: graphOrder.filter((name) =>
          ledger.repos.some((entry) => entry.repo === name && entry.commits.length > 0),
        ),
        repos: ledger.repos
          .filter((entry) => entry.repo === repo)
          .map((entry) => ({ ...entry, dependsOn })),
      };
      const bodyFile = join(folder, "body.md");
      const body = buildBody(repoLedger);
      writeFileSync(bodyFile, body);
      // A new MR is linted before the push: a body the lint refuses must not leave a pushed branch behind. A refresh
      // keeps the title of its MR, so `postMergeRequest` does its lint.
      if (existing === undefined) {
        const failed = lintBody({ body, title, ledger: repoLedger }).filter(
          (check) => check.result === "fail",
        );
        if (failed.length > 0)
          throw new ArkError(
            `lint failed for ${repo}, nothing was pushed:\n${failed.map((check) => `${check.id}: ${check.reason}`).join("\n")}`,
          );
      }
      run(["git", "push", "-u", "origin", worktree.branch], worktree.path);
      const posted = postMergeRequest({
        host,
        directory: worktree.path,
        branch: worktree.branch,
        base: defaultBranch(worktree, repoBase(projectConfig, repo)),
        title,
        bodyFile,
        ledger: repoLedger,
        reviewers: ledger.prWriting.reviewers,
      });
      if (posted.note) console.log(`${repo}  ${posted.note}`);
      if (existing !== undefined) {
        console.log(`${repo}  ${posted.action}  ${posted.url}`);
        continue;
      }
      const order = repos.indexOf(repo) + 1;
      const waitsFor = upstreamOpened.map((merge) => merge.number);
      const created = { repo, url: posted.url, number: posted.number, order, waits_for: waitsFor };
      if (host === "gitlab") {
        for (const merge of upstreamOpened)
          blockOnGitLab(created, merge, worktree.path, worktrees.get(merge.repo)!.path);
      }
      appendEvent(directory, "merge_request.opened", created);
      opened.set(repo, created);
      console.log(
        `${order}  ${repo}  ${marker}${created.number}  ${created.url}` +
          (waitsFor.length > 0
            ? `  waits for ${waitsFor.map((number) => marker + number).join(", ")}`
            : ""),
      );
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

type CiState = "passed" | "failed" | "running" | "none" | "unknown";
type FailedCheck = { name: string; url: string };
type MergeRequestComment = {
  author: string;
  path: string | null;
  line: number | null;
  body: string;
  url: string;
  createdAt: string;
};
type MergeRequestReport = {
  repo: string;
  url: string;
  state: string;
  ci: CiState;
  failedChecks: FailedCheck[];
  conflict: boolean | null;
  comments: MergeRequestComment[] | null;
};
type GithubCheck = {
  name?: string;
  context?: string;
  conclusion?: string | null;
  state?: string | null;
  detailsUrl?: string;
  targetUrl?: string;
};

/** Reads one MR from the host in `cwd`. Throws when `gh` or `glab` fails. `status` is `open`, `merged`, `closed` or another host state, lowercase. `forStatus` also asks GitHub for `mergeable`; `forCommit` asks for the merge commit. */
function viewMergeRequest(
  merge: OpenedMergeRequest,
  cwd: string,
  forStatus = false,
  forCommit = false,
) {
  const github = detectHost(merge.url) === "github";
  const output = run(
    github
      ? [
          "gh",
          "pr",
          "view",
          merge.url,
          "--json",
          forCommit
            ? "state,mergeCommit"
            : forStatus
              ? "state,statusCheckRollup,mergeable"
              : "state,statusCheckRollup",
        ]
      : ["glab", "mr", "view", String(merge.number), "--output", "json"],
    cwd,
  );
  const view = JSON.parse(output);
  const raw = String(view.state).toLowerCase();
  // A squash or rebase merge leaves a commit that is not the branch head: GitLab names it in merge_commit_sha or squash_commit_sha.
  const mergeCommit: string | undefined =
    (github ? view.mergeCommit?.oid : view.merge_commit_sha || view.squash_commit_sha) || undefined;
  return { view, status: raw === "opened" ? "open" : raw, github, mergeCommit };
}

/** State of one MR: `merged`, `open`, `closed`, or `unknown` when the host call fails or answers something else. Returns a value and prints nothing; run it before the worktree in `cwd` is removed. */
export function mergeRequestState(
  merge: OpenedMergeRequest,
  cwd: string,
): "merged" | "open" | "closed" | "unknown" {
  try {
    const { status } = viewMergeRequest(merge, cwd);
    return status === "merged" || status === "open" || status === "closed" ? status : "unknown";
  } catch {
    return "unknown";
  }
}

/** Parses one or more concatenated JSON arrays, the output of `gh api --paginate` and `glab api --paginate`, into one list. */
function parseJsonArrays(text: string): unknown[] {
  const items: unknown[] = [];
  let parts = 0;
  let depth = 0;
  let start = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "[" || char === "{") {
      if (depth++ === 0) start = i;
    } else if (char === "]" || char === "}") {
      if (--depth === 0) {
        const part = JSON.parse(text.slice(start, i + 1));
        if (!Array.isArray(part)) throw new ArkError("host answered something other than a list");
        items.push(...part);
        parts++;
      }
    }
  }
  if (parts === 0 || depth !== 0 || inString) throw new ArkError("host answered no JSON list");
  return items;
}

function githubCi(rollup: unknown): { ci: CiState; failedChecks: FailedCheck[] } {
  if (rollup === undefined || (rollup !== null && !Array.isArray(rollup)))
    throw new ArkError("could not read checks");
  const checks = (rollup ?? []) as GithubCheck[];
  const failed = [
    "FAILURE",
    "ERROR",
    "TIMED_OUT",
    "CANCELLED",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
  ];
  const finished = ["SUCCESS", "NEUTRAL", "SKIPPED"];
  const failedChecks = checks
    .filter((check) => failed.includes(check.conclusion || check.state || ""))
    .map((check) => ({
      name: check.name ?? check.context ?? "unnamed check",
      url: check.detailsUrl ?? check.targetUrl ?? "",
    }));
  if (failedChecks.length > 0) return { ci: "failed", failedChecks };
  if (checks.length === 0) return { ci: "none", failedChecks };
  const running = checks.some((check) => !finished.includes(check.conclusion || check.state || ""));
  return { ci: running ? "running" : "passed", failedChecks };
}

function gitlabCi(
  view: {
    head_pipeline?: { id?: number; status?: string };
    pipeline?: { id?: number; status?: string };
  },
  cwd: string,
): { ci: CiState; failedChecks: FailedCheck[] } {
  const pipeline = view.head_pipeline ?? view.pipeline;
  if (!pipeline) return { ci: "none", failedChecks: [] };
  if (!pipeline.id) throw new ArkError("could not read head pipeline");
  const pipelineStatus = String(pipeline.status);
  if (pipelineStatus === "success") return { ci: "passed", failedChecks: [] };
  if (pipelineStatus === "skipped" || pipelineStatus === "manual")
    return { ci: "none", failedChecks: [] };
  if (pipelineStatus !== "failed" && pipelineStatus !== "canceled")
    return { ci: "running", failedChecks: [] };
  let failedJobs: { name: string; web_url?: string }[] = [];
  try {
    failedJobs = parseJsonArrays(
      run(
        ["glab", "api", `projects/:id/pipelines/${pipeline.id}/jobs?scope[]=failed`, "--paginate"],
        cwd,
      ),
    ) as { name: string; web_url?: string }[];
  } catch {
    // pipeline.status already says failed; only the check names are unknown
  }
  return {
    ci: "failed",
    failedChecks: failedJobs.map((job) => ({ name: job.name, url: job.web_url ?? "" })),
  };
}

type RawComment = {
  login: string;
  isBot: boolean;
  path: string | null;
  line: number | null;
  body: string;
  url: string;
  createdAt: string;
};

/** Human comments written after `sinceTime`, oldest first. Throws when the host or the login lookup fails. */
function readComments(
  merge: OpenedMergeRequest,
  github: boolean,
  cwd: string,
  sinceTime: number,
): MergeRequestComment[] {
  let me: string;
  let raw: RawComment[];
  if (github) {
    me = run(["gh", "api", "user", "--jq", ".login"], cwd);
    const [owner, repo] = new URL(merge.url).pathname.split("/").filter(Boolean);
    const fetch = (kind: string) =>
      parseJsonArrays(
        run(
          ["gh", "api", `repos/${owner}/${repo}/${kind}/${merge.number}/comments`, "--paginate"],
          cwd,
        ),
      ) as {
        user: { login: string; type: string };
        path?: string;
        line?: number | null;
        body: string;
        html_url: string;
        created_at: string;
      }[];
    raw = [...fetch("pulls"), ...fetch("issues")].map((comment) => ({
      login: comment.user.login,
      isBot: comment.user.type === "Bot" || comment.user.login.endsWith("[bot]"),
      path: comment.path ?? null,
      line: comment.line ?? null,
      body: comment.body,
      url: comment.html_url,
      createdAt: comment.created_at,
    }));
  } else {
    const user: { username: string } = JSON.parse(run(["glab", "api", "user"], cwd));
    me = user.username;
    raw = (
      parseJsonArrays(
        run(
          [
            "glab",
            "api",
            `projects/:id/merge_requests/${merge.number}/notes?per_page=100`,
            "--paginate",
          ],
          cwd,
        ),
      ) as {
        id: number;
        system: boolean;
        author: { username: string; bot?: boolean };
        position?: { new_path?: string; new_line?: number };
        body: string;
        created_at: string;
      }[]
    )
      .filter((note) => !note.system)
      .map((note) => ({
        login: note.author.username,
        isBot: note.author.bot === true,
        path: note.position?.new_path ?? null,
        line: note.position?.new_line ?? null,
        body: note.body,
        url: `${merge.url}#note_${note.id}`,
        createdAt: note.created_at,
      }));
  }
  if (!me) throw new ArkError("could not read the logged-in user");
  return raw
    .filter(
      (comment) =>
        !comment.isBot && comment.login !== me && Date.parse(comment.createdAt) > sinceTime,
    )
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .map(({ login, isBot: _isBot, ...comment }) => ({ author: login, ...comment }));
}

/** Reads every signal of one MR. A signal the host cannot answer is `unknown` (`null` for conflict and comments); the others still show. */
function reportMergeRequest(
  merge: OpenedMergeRequest,
  cwd: string,
  sinceTime: number | undefined,
): MergeRequestReport {
  const report: MergeRequestReport = {
    repo: merge.repo,
    url: merge.url,
    state: "unknown",
    ci: "unknown",
    failedChecks: [],
    conflict: null,
    comments: sinceTime === undefined ? [] : null,
  };
  let github = detectHost(merge.url) === "github";
  try {
    const viewed = viewMergeRequest(merge, cwd, true);
    github = viewed.github;
    report.state = viewed.status;
    const { view } = viewed;
    try {
      Object.assign(report, github ? githubCi(view.statusCheckRollup) : gitlabCi(view, cwd));
    } catch {
      // ci stays unknown
    }
    if (viewed.status !== "open") report.conflict = false;
    else if (github) {
      if (view.mergeable === "CONFLICTING") report.conflict = true;
      else if (view.mergeable === "MERGEABLE") report.conflict = false;
    } else if (typeof view.has_conflicts === "boolean") report.conflict = view.has_conflicts;
  } catch {
    // state, ci and conflict stay unknown
  }
  if (sinceTime !== undefined) {
    try {
      report.comments = readComments(merge, github, cwd, sinceTime);
    } catch {
      // comments stay unknown
    }
  }
  return report;
}

function plainLines(report: MergeRequestReport): string[] {
  const tokens = [`${report.repo}  ${report.state}  ${report.url}  ci: ${report.ci}`];
  if (report.conflict === true) tokens.push("conflict");
  else if (report.conflict === null) tokens.push("conflict: unknown");
  if (report.failedChecks.length)
    tokens.push(`checks failing: ${report.failedChecks.map((check) => check.name).join(", ")}`);
  const lines = [tokens.join("  ")];
  if (report.comments === null) lines.push("  comments: unknown");
  for (const comment of report.comments ?? []) {
    const text = comment.body.replace(/\s+/g, " ").trim();
    const place =
      comment.path === null
        ? "(general)"
        : comment.line === null
          ? comment.path
          : `${comment.path}:${comment.line}`;
    lines.push(`  @${comment.author}  ${place}  ${text}  ${comment.url}`);
  }
  return lines;
}

/** Prints state, CI, conflict and (with `since`) new human comments for each MR the run opened. `json` prints one JSON array instead. Read-only. A value the host cannot answer prints `unknown`; the command still exits 0. */
export function mergeRequestStatus(
  runId: string,
  inProject?: string,
  options: { since?: string; json?: boolean } = {},
): void {
  const sinceTime = options.since === undefined ? undefined : Date.parse(options.since);
  if (sinceTime !== undefined && Number.isNaN(sinceTime))
    throw new ArkError(`--since ${options.since} is not an ISO 8601 time`);
  const { project, directory } = findRun(runId, inProject);
  if (mergeRequestsMode(project) === "none") {
    console.log("merge requests: none");
    return;
  }
  const state = deriveState(readEvents(directory));
  if (state.merge_requests.length === 0) throw new ArkError(`${runId} has no merge requests`);
  const reports = state.merge_requests.map((merge) => {
    const worktree = state.worktrees.find((candidate) => candidate.repo === merge.repo);
    if (worktree === undefined) throw new ArkError(`no worktree for repo ${merge.repo}`);
    return reportMergeRequest(merge, worktree.path, sinceTime);
  });
  if (options.json) return console.log(JSON.stringify(reports));
  let plan: Plan | undefined;
  try {
    plan = loadPlan(directory, state.ticket.id);
  } catch {
    // no readable plan: no bump lines
  }
  const lines = state.merge_requests.flatMap((merge, index) => [
    ...plainLines(reports[index]),
    ...dependencyLines(merge, state, reports, plan),
  ]);
  console.log(lines.join("\n"));
}

/** `waits for !N (<state>)` for each upstream of `merge`, then one line for each bump step of its repo. */
function dependencyLines(
  merge: OpenedMergeRequest & { waits_for?: number[] },
  state: RunState,
  reports: MergeRequestReport[],
  plan: Plan | undefined,
): string[] {
  const upstreamState = (repo: string) =>
    reports[state.merge_requests.findIndex((candidate) => candidate.repo === repo)]?.state;
  const edges = plan?.repos.find((entry) => entry.repo === merge.repo)?.depends_on ?? [];
  const waits = state.merge_requests
    .filter(
      (candidate) =>
        merge.waits_for?.includes(candidate.number) &&
        edges.some((edge) => edge.repo === candidate.repo),
    )
    .map((upstream) => `  waits for !${upstream.number} (${upstreamState(upstream.repo)})`);
  const bumps = edges
    .filter((edge) => edge.bump)
    .map((edge) => {
      const worktree = state.worktrees.find((candidate) => candidate.repo === merge.repo);
      return `  bump ${edge.bump}  ${edge.kind} ${edge.repo}  pin ${edge.pin}  ${bumpState(edge, worktree?.path, state, upstreamState(edge.repo))}`;
    });
  return [...waits, ...bumps];
}

/** `refreshed to <value>` once recorded; else a submodule shows its pointer, a package waits on its upstream MR. No registry is asked. */
function bumpState(
  edge: PlanRepoEdge,
  downstreamPath: string | undefined,
  state: RunState,
  upstreamMr: string | undefined,
): string {
  const refreshed = state.bump_refreshed[edge.bump];
  if (refreshed !== undefined)
    return `refreshed to ${edge.kind === "submodule" ? refreshed.slice(0, 8) : refreshed}`;
  if (edge.kind === "submodule") {
    const pointer = downstreamPath
      ? spawn(["git", "ls-tree", "HEAD", edge.pin], downstreamPath).stdout.split(/\s+/)[2]
      : undefined;
    return `points at upstream branch ${pointer?.slice(0, 8) || "unknown"}`;
  }
  return upstreamMr === "merged" ? "waits for upstream publish" : "waits for upstream merge";
}

/**
 * Records `bump.refreshed` for a bump step. A submodule edge moves the pointer in the downstream worktree to the
 * merge commit of the upstream MR (or `--to`), commits it and records the commit. Any other edge needs `--to`:
 * the pin edit is an implementer round, and the run lead has checked the value with the project's own tool.
 */
export function bumpRefresh(
  runId: string,
  stepId: string,
  options: { to?: string; project?: string } = {},
): void {
  const { directory } = findRun(runId, options.project);
  const state = deriveState(readEvents(directory));
  const plan = loadPlan(directory, state.ticket.id);
  const found = plan.repos.flatMap((entry) =>
    entry.depends_on.filter((edge) => edge.bump === stepId).map((edge) => ({ entry, edge })),
  )[0];
  if (found === undefined) throw new ArkError(`${stepId} is not a bump step of the plan`);
  const { entry, edge } = found;
  let value = options.to?.trim();
  if (edge.kind !== "submodule") {
    if (!value) throw new ArkError(`${stepId} is a ${edge.kind} bump: --to <value> is required`);
  } else {
    const worktree = state.worktrees.find((candidate) => candidate.repo === entry.repo);
    if (worktree === undefined) throw new ArkError(`no worktree for repo ${entry.repo}`);
    if (!value) {
      const upstreamMr = state.merge_requests.find((candidate) => candidate.repo === edge.repo);
      const upstreamTree = state.worktrees.find((candidate) => candidate.repo === edge.repo);
      if (upstreamMr === undefined || upstreamTree === undefined)
        throw new ArkError(`upstream repo ${edge.repo} has no merge request: pass --to <commit>`);
      const viewed = viewMergeRequest(upstreamMr, upstreamTree.path, false, true);
      if (viewed.status !== "merged")
        throw new ArkError(`upstream MR of ${edge.repo} is ${viewed.status}, not merged`);
      if (!viewed.mergeCommit)
        throw new ArkError(`the host names no merge commit for the upstream MR of ${edge.repo}`);
      value = viewed.mergeCommit;
    }
    const submodule = join(worktree.path, edge.pin);
    run(["git", "fetch", "origin"], submodule);
    run(["git", "checkout", "--detach", value], submodule);
    value = run(["git", "rev-parse", "HEAD"], submodule);
    run(["git", "add", edge.pin], worktree.path);
    // only the gitlink: unrelated staged work stays out; an already-pinned commit makes no commit
    if (!spawn(["git", "diff", "--cached", "--quiet", "--", edge.pin], worktree.path).ok)
      run(
        ["git", "commit", "-m", `Bump ${edge.pin} to ${value.slice(0, 8)}`, "--", edge.pin],
        worktree.path,
      );
  }
  appendEvent(directory, "bump.refreshed", { step: stepId, value });
  console.log(`refreshed ${stepId} to ${edge.kind === "submodule" ? value.slice(0, 8) : value}`);
}
