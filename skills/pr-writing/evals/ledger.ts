/**
 * The evals ledger: a neutral ledger for the replay bodies. It holds no repo, no diff and no tracker ref,
 * so the checks that read them skip, and `tier_floor` 3 lets a body use headings and up to 150 prose lines.
 * `agent_authored` is false because the replay bodies were written without the provenance line.
 */
import type { Ledger } from "../lib/ledger.ts";

export const evalsTitle = "Replay body";

export const evalsLedger: Ledger = {
  source: "git",
  host: "github",
  tokenOwner: "unknown",
  baseProbe: null,
  ticket: null,
  trackerRefs: [],
  plan: null,
  criteria: [],
  evidence: null,
  findings: [],
  hasReviewerStep: false,
  flaky: [],
  checks: [],
  reviewer: null,
  mergeOrder: [],
  repos: [],
  humanGates: [],
  template: null,
  risk: {
    verification: 1,
    alignment: 1,
    impact: 1,
    rollback: 1,
    mean: 1,
    script: "low",
    reviewer: null,
    level: "low",
    door: "two-way",
    sensitiveHits: [],
    oneWayHits: [],
    deleted: [],
    unplanned: [],
  },
  prWriting: {
    reviewers: [],
    tier_floor: 3,
    sensitive_paths: [],
    one_way_paths: [],
    agent_authored: false,
  },
  run: null,
};
