import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ArkError } from "./errors";
import { appendEvent, deriveState, readEvents } from "./events";
import { findRun } from "./paths";
import { loadPlan } from "./plan";

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

function description(
  ticket: { id: string; title: string },
  criteriaIds: string[],
  texts: Map<string, string>,
  dependencyLines: string[],
): string {
  const criteria = criteriaIds.map((id) => `- ${id}${texts.has(id) ? `: ${texts.get(id)}` : ""}`);
  return [
    `Ticket: ${ticket.id} ${ticket.title}`,
    "",
    "Acceptance criteria this repo serves:",
    ...(criteria.length > 0 ? criteria : ["- none"]),
    ...(dependencyLines.length > 0 ? ["", ...dependencyLines] : []),
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

export function mergeRequestOpen(runId: string): void {
  const { directory } = findRun(runId);
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
  if (!lastTest.data.passed)
    throw new ArkError("the last test run did not pass: fix the failures and run `ark test` again");
  for (const worktree of worktrees.values()) {
    const head = run(["git", "rev-parse", "HEAD"], worktree.path);
    const tested: string | undefined = lastTest.data.heads?.[worktree.repo];
    if (tested !== head) {
      throw new ArkError(
        `repo ${worktree.repo} changed since the last test run (tested ${tested?.slice(0, 8) ?? "nothing"}, now ${head.slice(0, 8)}): run \`ark test\` again`,
      );
    }
  }

  const plan: PlanSteps = loadPlan(directory);
  const upstream = upstreamRepos(plan);
  const order = mergeOrder(plan);
  const repos = [...order, ...[...worktrees.keys()].filter((repo) => !order.includes(repo))];
  const texts = criterionTexts(directory);
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
      description(ticket, criteriaIds, texts, dependencyLines),
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

/** Prints `<repo>  merged|open|closed  <url>` for each MR the run opened. Read-only. */
export function mergeRequestStatus(runId: string): void {
  const { directory } = findRun(runId);
  const state = deriveState(readEvents(directory));
  if (state.merge_requests.length === 0) throw new ArkError(`${runId} has no merge requests`);
  for (const merge of state.merge_requests) {
    const worktree = state.worktrees.find((candidate) => candidate.repo === merge.repo);
    if (worktree === undefined) throw new ArkError(`no worktree for repo ${merge.repo}`);
    const github = detectHost(merge.url) === "github";
    const output = run(
      github
        ? ["gh", "pr", "view", merge.url, "--json", "state"]
        : ["glab", "mr", "view", String(merge.number), "--output", "json"],
      worktree.path,
    );
    const raw = String(JSON.parse(output).state).toLowerCase();
    console.log(`${merge.repo}  ${raw === "opened" ? "open" : raw}  ${merge.url}`);
  }
}
