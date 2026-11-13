/**
 * The repo graph of a run, for the run page and the ticket chain. The order is `repoGraph`'s (cli/plan.ts), never
 * re-derived. A run has a graph only when its steps work in two or more repos (`hasMultipleRepos`) and its repos
 * can be ordered. Git is read here, in `readRepoFacts`, which only the background reader calls: `repoViews` reads nothing.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../cli/config.ts";
import { bumpState, submodulePointer } from "../cli/merge-request.ts";
import { hasMultipleRepos, repoGraph, type PlanRepo, type PlanRepoEdge } from "../cli/plan.ts";
import { commitsAhead } from "../cli/worktree.ts";
import type { ArkRun } from "./sources.ts";
import type { ChainRepo, MergeRequestView, RepoState, RepoView } from "./types.ts";

/** What git says. `ahead` is by repo (null: could not count); `pointers` by bump step id (undefined: no pointer). */
export type RepoFacts = {
  ahead: Record<string, number | null>;
  pointers: Record<string, string | undefined>;
};

/** The repos of the run in merge order with their `repos` entry, or null when the run draws no graph. */
function graphOf(run: ArkRun): { order: string[]; entries: Map<string, PlanRepo> } | null {
  if (!run.plan || !hasMultipleRepos({ steps: run.plan })) return null;
  try {
    const { order } = repoGraph({ steps: run.plan, repos: run.repos });
    return { order, entries: new Map(run.repos.map((entry) => [entry.repo, entry])) };
  } catch {
    return null; // a dependency cycle: the run shows without a graph
  }
}

/** A run that has a graph and a branch to measure or a pointer to read; closed runs other than `handed_off` have none to read. */
export const needsRepoFacts = (run: ArkRun): boolean =>
  (run.state.phase !== "closed" || run.state.outcome === "handed_off") && graphOf(run) !== null;

export function readRepoFacts(run: ArkRun): RepoFacts {
  const { state } = run;
  let workspace: string | null = null;
  try {
    workspace = loadConfig(state.project).workspace;
  } catch {
    // ark.yml does not load: the branch state stays unknown
  }
  const facts: RepoFacts = { ahead: {}, pointers: {} };
  for (const { repo, branch, base } of state.worktrees)
    facts.ahead[repo] =
      (workspace === null ? undefined : commitsAhead(join(workspace, repo), branch, base)) ?? null;
  for (const entry of run.repos)
    for (const edge of entry.depends_on) {
      if (!edge.bump || state.bump_refreshed[edge.bump] !== undefined) continue;
      const path = state.worktrees.find((worktree) => worktree.repo === entry.repo)?.path;
      facts.pointers[edge.bump] =
        path && existsSync(path) ? submodulePointer(edge, path) : undefined;
    }
  return facts;
}

export function repoViews(
  run: ArkRun,
  facts: RepoFacts | undefined,
  mergeRequests: Pick<MergeRequestView, "repo" | "number" | "state">[],
): RepoView[] | null {
  const graph = graphOf(run);
  if (!graph) return null;
  const mergeRequestOf = (repo: string) =>
    mergeRequests.find((candidate) => candidate.repo === repo);
  return graph.order.map((repo, index) => {
    const entry = graph.entries.get(repo);
    const mergeRequest = mergeRequestOf(repo);
    const worktree = run.state.worktrees.find((candidate) => candidate.repo === repo);
    const ahead = facts?.ahead[repo] ?? null;
    const state: RepoState = mergeRequest
      ? mergeRequest.state
      : !worktree
        ? "pending"
        : ahead === null
          ? "unknown"
          : ahead > 0
            ? "ahead"
            : "clean";
    return {
      repo,
      why: entry?.why ?? "",
      order: index + 1,
      depends_on: (entry?.depends_on ?? []).map((edge: PlanRepoEdge) => ({
        ...edge,
        bump_state: edge.bump
          ? bumpState(edge, facts?.pointers[edge.bump], run.state, mergeRequestOf(edge.repo)?.state)
          : null,
      })),
      state,
      mr: mergeRequest?.number ?? null,
      branch: worktree ? { name: worktree.branch, ahead } : null,
    };
  });
}

export const chainOf = (repos: RepoView[] | null): ChainRepo[] | null =>
  repos && repos.map(({ repo, order, state }) => ({ repo, order, state }));
