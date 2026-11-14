import type { Snapshot } from "../hub/types.ts";

/**
 * A `snapshotWhen` predicate for the named runs: each run shows a merged merge request (github loop) and has
 * its repo facts (repo-facts loop). The two loops publish apart, so a snapshot can hold `merged` while the
 * facts are still unread and every submodule bump reads `unknown`. `branch.ahead` is set in the same read as
 * the bump pointer, so a measured branch means the pointer was read too.
 */
export const waitForRepoFacts =
  (...runs: string[]) =>
  (snapshot: Snapshot): boolean =>
    Array.isArray(snapshot.runs) &&
    runs.every((name) => {
      const view = (snapshot.runs as Exclude<Snapshot["runs"], "unknown">).find(
        (candidate) => candidate.run === name,
      );
      return (
        view !== undefined &&
        view.merge_requests.some((mergeRequest) => mergeRequest.state === "merged") &&
        view.repos?.some((repoView) => repoView.branch?.ahead != null) === true
      );
    });
