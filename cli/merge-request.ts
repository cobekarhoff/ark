import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimHumanAsk } from "./binding";
import { confirmHuman, verifyHumanProof } from "./human";
import { git } from "./repo";
import { commit, append, locked, mergeRequestsEnabled, project, readLedger, record, runDirectory, sha256, type LedgerEvent } from "./run";

type PullRequest = { url: string; number: number; state: string; baseRefName: string; headRepositoryOwner: { login: string } | null };

const closePacket = (events: LedgerEvent[]) =>
  events.filter((event) => event.type === "merge_request.opened").map((event) => ({ repo: event.data.repo, url: event.data.url, number: event.data.number }));

// Remote URLs may carry credentials (https://user:token@host/..): no error or ledger line may show them.
const redact = (text: string) => text.replace(/(\/\/)[^/@\s]+@/g, "$1***@");

function gh(...argumentsList: string[]): string {
  const result = Bun.spawnSync(["gh", ...argumentsList]);
  if (result.exitCode !== 0) throw new Error(`gh ${argumentsList.slice(0, 2).join(" ")} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

// Opens one merge request (a GitHub pull request) per repo worktree. The only gh subcommands used are `pr list` and `pr create`: nothing here, or anywhere in the CLI, merges.
export function mergeRequestOpen(runId: string): string {
  const directory = runDirectory(runId);
  const events = readLedger(directory);
  const state = project(events);
  const illegal = () => new Error(`ark merge-request open is legal only in state 'merge_requests_open' (state '${state.state}')`);

  if (!mergeRequestsEnabled()) {
    const opened = events.some((event) => event.type === "merge_request.opened");
    if (state.state === "merge_requests_open" && !opened) record(directory, "run.closed", { outcome: "handed_off", reason: "merge requests disabled" });
    else if (state.state === "merge_requests_open") throw new Error("merge requests are disabled but this run already has an opened merge request; close it as merged or abandoned with 'ark run close'");
    else if (state.state !== "done") throw illegal();
    return `merge requests are disabled in ark.yml; run closed at ready branches: ${state.repos.map((repository) => repository.branch).join(", ")}\n`;
  }
  if (state.state !== "merge_requests_open") throw illegal();
  const approvedHeads = events.findLast((event) => event.type === "gate.answered" && event.data.gate === "evidence" && event.data.answer === "approve")?.data.approved_heads as Record<string, string> | undefined;

  const ticket = JSON.parse(readFileSync(join(directory, "ticket.json"), "utf8")) as { title: string; acceptance_criteria: { id: string; text: string }[] };
  const matrixFile = join(directory, "trace-matrix.md");
  if (!existsSync(matrixFile)) throw new Error("trace-matrix.md is missing from the run folder");
  const artifactsDirectory = join(directory, "artifacts");
  const evidence = existsSync(artifactsDirectory) ? (readdirSync(artifactsDirectory, { recursive: true }) as string[]).filter((file) => statSync(join(artifactsDirectory, file)).isFile()).sort() : [];
  const body = [
    `# ${state.ticket}: ${ticket.title}`,
    ticket.acceptance_criteria.map((criterion) => `- ${criterion.id}: ${criterion.text}`).join("\n"),
    `## Trace matrix\n\n${readFileSync(matrixFile, "utf8").trimEnd()}`,
    `## Evidence (paths relative to the run folder, run ${runId})\n\n${evidence.length ? evidence.map((file) => `- artifacts/${file}`).join("\n") : "- none"}`,
  ].join("\n\n") + "\n";

  const outputLines: string[] = [];
  for (const repository of state.repos) {
    const existingMergeRequestEvent = events.find((event) => event.type === "merge_request.opened" && event.data.repo === repository.name);
    if (existingMergeRequestEvent) {
      outputLines.push(`${repository.name}: ${existingMergeRequestEvent.data.url}`);
      continue;
    }
    const worktree = join(directory, "worktrees", repository.name);
    // Only ark/* branches, and only the SHA that was approved: an agent must not steer the CLI's credentials at another branch or at later commits.
    if (!repository.branch.startsWith("ark/")) throw new Error(`refusing to push '${repository.branch}': not an ark/ branch`);
    const approvedHead = approvedHeads?.[repository.name];
    if (!approvedHead) throw new Error(`${repository.name} has no recorded head from evidence approval; approve the evidence gate before ark merge-request open`);
    if (git(worktree, "rev-parse", "HEAD") !== approvedHead) throw new Error(`${worktree} HEAD differs from the approved ${approvedHead}; commits made after approval are not pushed`);

    // The trusted git dir comes from the source checkout recorded by ark worktree create (an event advance cannot forge), never from the
    // worktree's .git file, which an agent can repoint at another repository with its own origin and hooks.
    const sourceCheckout = events.find((event) => event.type === "worktree.created" && event.data.repo === repository.name)?.data.source;
    if (typeof sourceCheckout !== "string") throw new Error(`${repository.name} has no recorded source checkout; recreate its worktree with ark worktree create`);
    const commonGitDirectory = git(sourceCheckout, "rev-parse", "--path-format=absolute", "--git-common-dir");
    if (!Bun.spawnSync(["git", "--git-dir", commonGitDirectory, "cat-file", "-e", `${approvedHead}^{commit}`]).success) throw new Error(`approved ${approvedHead} is not in ${sourceCheckout}`);
    const url = git(sourceCheckout, "config", "--file", join(commonGitDirectory, "config"), "--get", "remote.origin.url");
    const slug = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/)?.[1];
    if (!slug) throw new Error(`cannot read owner/repo from remote.origin.url '${redact(url)}'`);
    const defaultHeadResult = Bun.spawnSync(["git", "--git-dir", commonGitDirectory, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (defaultHeadResult.exitCode !== 0) throw new Error(`${repository.name} has no origin/HEAD to read the default branch from; run 'git remote set-head origin -a'`);
    const defaultBranch = defaultHeadResult.stdout.toString().trim().replace(/^origin\//, "");

    // The worktree's pushurl is DISABLED for agents; an explicit URL bypasses it with the CLI's own credentials.
    // Pushed from the shared git dir, so the agent's per-worktree config (insteadOf, hooksPath) is never loaded; the SHA resolves in the shared object store.
    // core.hooksPath on the command line outranks the source repo's hooks/ and any configured path: this push carries the human's credentials, so no hook of a repo an agent can write to runs in it.
    const push = Bun.spawnSync(["git", "--git-dir", commonGitDirectory, "-c", "core.hooksPath=/dev/null", "push", url, `${approvedHead}:refs/heads/${repository.branch}`]);
    if (push.exitCode !== 0) throw new Error(redact(`git push ${url} failed: ${push.stderr.toString().trim()}`));

    const bodyFile = join(directory, "merge-requests", `${repository.name}.md`);
    mkdirSync(join(directory, "merge-requests"), { recursive: true });
    writeFileSync(bodyFile, body);
    // A merge request counts as ours only if it is from this repo (not a fork with the same branch name) into the default branch.
    const owner = slug.split("/")[0].toLowerCase();
    const pullRequests = JSON.parse(gh("pr", "list", "--repo", slug, "--head", repository.branch, "--state", "all", "--json", "url,number,state,baseRefName,headRepositoryOwner") || "[]") as PullRequest[];
    const matchingPullRequests = pullRequests.filter((pullRequest) => pullRequest.baseRefName === defaultBranch && pullRequest.headRepositoryOwner?.login.toLowerCase() === owner);
    const openPullRequest = matchingPullRequests.find((pullRequest) => pullRequest.state === "OPEN");
    const closedPullRequest = matchingPullRequests.find((pullRequest) => pullRequest.state !== "OPEN");
    if (!openPullRequest && closedPullRequest) throw new Error(`${repository.branch} already has a ${closedPullRequest.state.toLowerCase()} merge request ${closedPullRequest.url}; ark merge-request open will not reuse it`);
    const pullRequestUrl = openPullRequest?.url ?? gh("pr", "create", "--repo", slug, "--head", repository.branch, "--base", defaultBranch, "--title", `${state.ticket}: ${ticket.title}`, "--body-file", bodyFile).split("\n").pop()!;
    const number = openPullRequest?.number ?? Number(pullRequestUrl.match(/\/pull\/(\d+)/)?.[1]);
    if (!Number.isInteger(number)) throw new Error(`cannot read a merge request number from '${pullRequestUrl}'`);
    record(directory, "merge_request.opened", { repo: repository.name, url: pullRequestUrl, number });
    outputLines.push(`${repository.name}: ${pullRequestUrl}`);
  }
  const opened = closePacket(readLedger(directory));
  return `${outputLines.join("\n")}\n${opened.length ? `close_packet: ${sha256(JSON.stringify(opened))}\n` : ""}`;
}

// The outcome of a run whose merge requests are open is a human's to record. Returns the close packet hash: sha256 of the opened merge request list.
function closePacketHash(events: LedgerEvent[], outcome: string): string {
  const state = project(events);
  if (state.state !== "merge_requests_open") throw new Error(`ark run close is legal only in state 'merge_requests_open' (state '${state.state}')`);
  const opened = closePacket(events);
  if (!opened.length) throw new Error(`cannot record ${outcome}: no merge request has been opened`);
  const unopened = state.repos.filter((repository) => !opened.some((o) => o.repo === repository.name)).map((repository) => repository.name);
  if (outcome === "merged" && unopened.length) throw new Error(`cannot record merged: no merge request was opened for ${unopened.join(", ")}`);
  return sha256(JSON.stringify(opened));
}

export function closeRun(runId: string, outcome: string): string {
  if (outcome !== "merged" && outcome !== "abandoned") throw new Error(`unknown outcome '${outcome}'; a human records merged or abandoned (aborted and handed off are recorded by Ark)`);
  const directory = runDirectory(runId);
  const choices = ["merged", "abandoned"];
  const packetHash = closePacketHash(readLedger(directory), outcome);
  const identity = confirmHuman(directory, runId, "run.closed", outcome, packetHash, choices);
  return locked(directory, () => {
    const events = readLedger(directory);
    if (closePacketHash(events, outcome) !== packetHash) throw new Error("merge request state changed after confirmation; ask the human again");
    if (!verifyHumanProof(directory, runId, "run.closed", outcome, packetHash, choices, identity)) {
      throw new Error("run-close confirmation is no longer valid; ask the human again");
    }
    if (!identity.question || !identity.ask_call_id || !claimHumanAsk(identity.question, identity.ask_call_id)) {
      throw new Error(`ask confirmation ${identity.ask_call_id} was already used; ask the human again`);
    }
    commit(directory, append(directory, events, "run.closed", { outcome, packet_sha256: packetHash, ...identity }));
    return `closed ${runId}: ${outcome}, recorded by ${identity.by}\n`;
  });
}
