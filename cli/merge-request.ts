import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ArkError } from "./errors";
import { manualCriteria } from "./criteria.ts";
import { appendEvent, deriveState, readEvents, type ArkEvent } from "./events";
import { mergeRequestsMode } from "./config.ts";
import { findRun } from "./paths";
import { loadPlan } from "./plan";
import { uiSkillsFor } from "./ui-skills";

type PlanStep = { id: string; repo: string; needs: string[]; criteria: string[] };
type PlanSteps = { steps: PlanStep[] };
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

// For each repo, the other repos whose steps it needs.
function upstreamRepos(plan: PlanSteps): Map<string, Set<string>> {
  const repoOfStep = new Map(plan.steps.map((step) => [step.id, step.repo]));
  const upstream = new Map<string, Set<string>>();
  for (const step of plan.steps) {
    const dependencies = upstream.get(step.repo) ?? new Set<string>();
    for (const needed of step.needs) {
      const neededRepo = repoOfStep.get(needed);
      if (neededRepo !== undefined && neededRepo !== step.repo) dependencies.add(neededRepo);
    }
    upstream.set(step.repo, dependencies);
  }
  return upstream;
}

export function mergeOrder(plan: PlanSteps): string[] {
  const upstream = upstreamRepos(plan);
  const repos = [...upstream.keys()]; // first appearance in the plan file
  const ordered: string[] = [];
  while (ordered.length < repos.length) {
    const next = repos.find(
      (repo) =>
        !ordered.includes(repo) &&
        [...upstream.get(repo)!].every((dependency) => ordered.includes(dependency)),
    );
    if (next === undefined) {
      const remaining = repos.filter((repo) => !ordered.includes(repo));
      throw new ArkError(`the plan has a dependency cycle between repos: ${remaining.join(", ")}`);
    }
    ordered.push(next);
  }
  return ordered;
}

function detectHost(remoteUrl: string): Host {
  const lowered = remoteUrl.toLowerCase();
  if (lowered.includes("github.com")) return "github";
  if (lowered.includes("gitlab")) return "gitlab";
  throw new ArkError(`cannot tell GitHub from GitLab for remote ${remoteUrl}`);
}

function criterionTexts(runDirectory: string): Map<string, string> {
  const match = readFileSync(join(runDirectory, "ticket.md"), "utf8").match(
    /^---\n([\s\S]*?)\n---/,
  );
  const frontmatter = match
    ? (Bun.YAML.parse(match[1]) as { acceptance_criteria?: { id: string; text: string }[] })
    : {};
  const criteria = frontmatter.acceptance_criteria ?? [];
  return new Map(criteria.map((criterion) => [criterion.id, criterion.text]));
}

function defaultBranch(worktree: Worktree): string {
  const result = spawn(
    ["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    worktree.path,
  );
  return result.ok ? result.stdout.replace(/^origin\//, "") : worktree.base;
}

/**
 * UI findings of the reviewer steps: `### <rank>: <title>` headings with `**File:**`, `**Line:**`,
 * `**Skill:**` and `**Rule:**` lines. A finding with no Skill line is not a UI finding.
 */
function uiFindings(runDirectory: string, reviewers: string[]): string[] {
  const bullets: string[] = [];
  for (const step of reviewers) {
    const file = join(runDirectory, "findings", `${step}.md`);
    if (!existsSync(file)) continue;
    for (const block of readFileSync(file, "utf8").split(/^(?=### )/m)) {
      const heading = block.match(/^###\s+([^:\n]+):\s*(.*)$/m);
      const field = (name: string) =>
        block
          .match(new RegExp(`\\*\\*${name}:\\*\\*\\s*(.*)$`, "m"))?.[1]
          .replaceAll("`", "")
          .trim() ?? "";
      const skill = field("Skill");
      if (!heading || !skill) continue;
      bullets.push(
        `- ${heading[1].trim()} ${heading[2].trim()} (${skill}: ${field("Rule")}, ${field("File")}:${field("Line")})`,
      );
    }
  }
  return bullets;
}

function description(
  ticket: { id: string; title: string },
  criteriaIds: string[],
  texts: Map<string, string>,
  dependencyLines: string[],
  ui: { skills: string[]; findings: string[] } | null = null,
): string {
  const criteria = criteriaIds.map((id) => `- ${id}${texts.has(id) ? `: ${texts.get(id)}` : ""}`);
  return [
    `Ticket: ${ticket.id} ${ticket.title}`,
    "",
    "Acceptance criteria this repo serves:",
    ...(criteria.length > 0 ? criteria : ["- none"]),
    ...(dependencyLines.length > 0 ? ["", ...dependencyLines] : []),
    ...(ui
      ? [
          "",
          "## UI/UX checks",
          "",
          `Skills applied: ${ui.skills.join(", ")}`,
          "",
          ...(ui.findings.length > 0 ? ui.findings : ["- No UI/UX findings."]),
        ]
      : []),
  ].join("\n");
}

function createMergeRequest(
  host: Host,
  worktree: Worktree,
  base: string,
  title: string,
  body: string,
): OpenedMergeRequest {
  const command =
    host === "github"
      ? [
          "gh",
          "pr",
          "create",
          "--base",
          base,
          "--head",
          worktree.branch,
          "--title",
          title,
          "--body",
          body,
        ]
      : [
          "glab",
          "mr",
          "create",
          "--source-branch",
          worktree.branch,
          "--target-branch",
          base,
          "--title",
          title,
          "--description",
          body,
          "--yes",
        ];
  const output = run(command, worktree.path);
  const url = output.match(/https?:\/\/\S+/)?.[0];
  const number = Number(url?.match(/\/(\d+)\/?$/)?.[1]);
  if (url === undefined || !Number.isInteger(number)) {
    throw new ArkError(`could not read the merge request URL for ${worktree.repo} from: ${output}`);
  }
  return { repo: worktree.repo, url, number };
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

export function mergeRequestOpen(runId: string, inProject?: string): void {
  const { project, directory } = findRun(runId, inProject);
  if (mergeRequestsMode(project) === "none")
    throw new ArkError(
      `project ${project} has merge_requests: none: close the run with ark run close ${runId} handed_off`,
    );
  const events = readEvents(directory);
  const state = deriveState(events);
  if (!["building", "escalation", "merge_requests_open"].includes(state.phase)) {
    throw new ArkError(`cannot open merge requests while the run is in phase ${state.phase}`);
  }

  const worktrees = new Map<string, Worktree>();
  for (const event of events)
    if (event.type === "worktree.created") worktrees.set(event.data.repo, event.data as Worktree);
  const lastTest = events.filter((event) => event.type === "test.completed").at(-1);
  if (lastTest === undefined) throw new ArkError("no test result yet: run `ark test` first");
  const unproven = manualCriteria(directory).filter((id) => state.gates[`manual:${id}`] !== "ok");
  if (unproven.length > 0)
    throw new ArkError(
      `manual ${unproven.length === 1 ? "criterion" : "criteria"} without ok: ${unproven.join(", ")}`,
    );
  if (!lastTest.data.passed)
    throw new ArkError("the last test run did not pass: fix the failures and run `ark test` again");
  const [first] = staleHeads(events);
  if (first !== undefined) {
    throw new ArkError(
      `repo ${first.repo} changed since the last test run (tested ${first.tested?.slice(0, 8) ?? "nothing"}, now ${first.current.slice(0, 8)}): run ark test ${runId} again`,
    );
  }

  const plan = loadPlan(directory);
  const upstream = upstreamRepos(plan);
  const order = mergeOrder(plan);
  const repos = [...order, ...[...worktrees.keys()].filter((repo) => !order.includes(repo))];
  const texts = criterionTexts(directory);
  // A run with no recorded evaluation counts as Surfaces none.
  const ui =
    uiSkillsFor(state.evaluation?.surfaces ?? ["none"]).length > 0
      ? {
          skills: [...new Set(plan.steps.flatMap((step) => step.skills))],
          findings: uiFindings(
            directory,
            plan.steps.filter((step) => step.role === "reviewer").map((step) => step.id),
          ),
        }
      : null;
  const ticket = state.ticket;
  const opened = new Map<string, OpenedMergeRequest>();
  for (const event of events)
    if (event.type === "merge_request.opened")
      opened.set(event.data.repo, event.data as OpenedMergeRequest);

  for (const repo of repos) {
    const worktree = worktrees.get(repo);
    if (worktree === undefined) continue;
    if (opened.has(repo)) {
      console.log(`${repo}  already open  ${opened.get(repo)!.url}`);
      continue;
    }
    const ahead = Number(
      run(["git", "rev-list", "--count", `${worktree.base}..HEAD`], worktree.path),
    );
    if (ahead === 0) continue;

    run(["git", "push", "-u", "origin", worktree.branch], worktree.path);
    const host = detectHost(run(["git", "remote", "get-url", "origin"], worktree.path));
    const upstreamOpened = [...(upstream.get(repo) ?? [])].flatMap(
      (name) => opened.get(name) ?? [],
    );
    const dependencyLines = upstreamOpened.map(
      (merge) => `Depends on ${host === "github" ? "#" : "!"}${merge.number}`,
    );
    const criteriaIds = [
      ...new Set(plan.steps.filter((step) => step.repo === repo).flatMap((step) => step.criteria)),
    ];
    const created = createMergeRequest(
      host,
      worktree,
      defaultBranch(worktree),
      `${ticket.id}: ${ticket.title}`,
      description(ticket, criteriaIds, texts, dependencyLines, ui),
    );
    if (host === "gitlab") {
      for (const merge of upstreamOpened)
        blockOnGitLab(created, merge, worktree.path, worktrees.get(merge.repo)!.path);
    }
    appendEvent(directory, "merge_request.opened", created);
    opened.set(repo, created);
    console.log(`${repo}  ${created.url}`);
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

/** Reads one MR from the host in `cwd`. Throws when `gh` or `glab` fails. `status` is `open`, `merged`, `closed` or another host state, lowercase. `forStatus` also asks GitHub for `mergeable`. */
function viewMergeRequest(merge: OpenedMergeRequest, cwd: string, forStatus = false) {
  const github = detectHost(merge.url) === "github";
  const output = run(
    github
      ? [
          "gh",
          "pr",
          "view",
          merge.url,
          "--json",
          forStatus ? "state,statusCheckRollup,mergeable" : "state,statusCheckRollup",
        ]
      : ["glab", "mr", "view", String(merge.number), "--output", "json"],
    cwd,
  );
  const view = JSON.parse(output);
  const raw = String(view.state).toLowerCase();
  return { view, status: raw === "opened" ? "open" : raw, github };
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
  console.log(options.json ? JSON.stringify(reports) : reports.flatMap(plainLines).join("\n"));
}
