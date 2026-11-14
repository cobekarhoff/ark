import type { Snapshot } from "../hub/types.ts";

/**
 * A `snapshotWhen` predicate for the named runs: each run has its repo facts (repo-facts loop). That loop publishes
 * apart from the github loop, so a snapshot can hold a run whose facts are still unread, and every submodule bump
 * reads `unknown`. `branch.ahead` is set in the same read as the bump pointer, so a measured branch means the
 * pointer was read too. A test that also needs a merge request state joins its own predicate to this one.
 */
export const waitForRepoFacts =
  (...runs: string[]) =>
  (snapshot: Snapshot): boolean => {
    const views = snapshot.runs;
    return (
      Array.isArray(views) &&
      runs.every((name) =>
        views
          .find((candidate) => candidate.run === name)
          ?.repos?.some((repoView) => repoView.branch?.ahead != null),
      )
    );
  };
