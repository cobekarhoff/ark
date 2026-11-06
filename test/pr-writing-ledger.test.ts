import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../cli/config.ts";
import { buildLedger } from "../skills/pr-writing/lib/ledger.ts";

setDefaultTimeout(30_000);

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "ledger-repo-"));
  git(repo, "init", "-b", "main");
  mkdirSync(join(repo, "cli"));
  writeFileSync(join(repo, "cli", "gate.ts"), "a\n");
  writeFileSync(join(repo, "cli", "other.ts"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  git(repo, "checkout", "-b", "ark/ARK-9-x");
  writeFileSync(join(repo, "cli", "gate.ts"), "b\n");
  writeFileSync(join(repo, "cli", "other.ts"), "b\n");
  git(repo, "commit", "-am", "ARK-9: change");
  return repo;
}

function writeEvents(directory: string, repo: string, extra: object[]): void {
  const events = [
    {
      type: "run.started",
      data: {
        run: "r",
        project: "p",
        ticket: { id: "ARK-9", title: "T" },
        kind: "bug",
        criteria: ["AC1", "AC2"],
        criteria_gate: true,
      },
    },
    {
      type: "worktree.created",
      data: { repo: ".", path: repo, branch: "ark/ARK-9-x", base: "main" },
    },
    { type: "step.started", data: { step: "review", role: "reviewer", repo: ".", round: 1 } },
    ...extra,
  ];
  writeFileSync(
    join(directory, "events.ndjson"),
    events.map((event, i) => JSON.stringify({ seq: i + 1, time: "t", ...event })).join("\n") + "\n",
  );
}

test("run ledger keeps only open findings, scores risk and ignores auto gates", () => {
  const repo = makeRepo();
  const directory = mkdtempSync(join(tmpdir(), "ledger-run-"));
  writeFileSync(
    join(directory, "ticket.md"),
    "---\nid: ARK-9\ntitle: T\nsummary: Short\nkind: bug\nacceptance_criteria:\n  - id: AC1\n    text: one\n  - id: AC2\n    text: two\n---\n## Problem\n\nBroken.\n\n## Change\n\nFix.\n",
  );
  writeFileSync(
    join(directory, "plan.yml"),
    "steps:\n  - {id: review, role: reviewer, repo: '.', needs: []}\ntest_cases: []\nsummary:\n  why: w\n  changes:\n    - {criterion: AC1, where: 'cli/gate.ts', now: n, fix: f}\n",
  );
  mkdirSync(join(directory, "findings"));
  writeFileSync(
    join(directory, "findings", "review-1.md"),
    "### P0: Old\n\n### P1: Sent\n\n### P2: Kept\n\n## Run lead decision\n\n- P1 Sent: send back, fix it\n- P2 Kept: leave, minor\n",
  );
  writeFileSync(
    join(directory, "findings", "review-2.md"),
    "### P3: New\n\n## Merge risk\n\n- Verification: good — ok\n- Alignment: good — ok\n- Impact: good — ok\n- Rollback cost: good — ok\n- Door: two-way\n- Blast radius: small\n- Not in plan: cli/other.ts — shared helper\n",
  );
  writeEvents(directory, repo, [
    { type: "gate.answered", data: { gate: "criteria", answer: "accept", by: "auto" } },
    { type: "gate.answered", data: { gate: "plan", answer: "approve", by: "human" } },
    {
      type: "test.completed",
      data: { passed: true, heads: {}, criteria: { AC1: "passing", AC2: "failing" } },
    },
  ]);

  const ledger = buildLedger({
    runFolder: directory,
    prWriting: {
      reviewers: [],
      tier_floor: 0,
      sensitive_paths: ["cli/gate.ts"],
      one_way_paths: [],
      agent_authored: true,
    },
  });

  expect(ledger.findings.map((finding) => finding.title)).toEqual(["Old", "Kept", "New"]);
  expect(ledger.humanGates).toEqual(["plan"]);
  expect(ledger.ticket?.summary).toBe("Short");
  expect(ledger.evidence).toBeNull();
  expect(ledger.risk.unplanned).toEqual([{ file: "cli/other.ts", reason: "shared helper" }]);
  // Verification poor (AC2 failing) 3, Impact 2 (sensitive hit), Rollback 1, Alignment 2.
  expect(ledger.risk).toMatchObject({ verification: 3, impact: 2, rollback: 1, alignment: 2 });
  expect(ledger.risk.script).toBe("medium");
  expect(ledger.risk.reviewer).toBe("low");
  expect(ledger.risk.level).toBe("medium");
});

test("git ledger records a failed host probe as unknown and asks for --base", () => {
  const repo = makeRepo();
  git(repo, "remote", "add", "origin", "https://github.com/o/r.git");
  const bin = mkdtempSync(join(tmpdir(), "ledger-bin-"));
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "gh"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    expect(() => buildLedger({ directory: repo })).toThrow(
      /open MR target unknown, origin\/HEAD none, host default branch unknown\): pass --base/,
    );
    expect(buildLedger({ directory: repo, base: "main" }).baseProbe).toMatchObject({
      mergeRequestTarget: "unknown",
      hostDefault: "unknown",
      chosen: "main",
    });
  } finally {
    process.env.PATH = path;
  }
});

test("pr_writing config defaults and names the bad key", () => {
  const base = {
    workspace: tmpdir(),
    ticket_source: "local",
    suites: [{ name: "s", level: "unit", repo: ".", command: "c", parser: "bun" }],
    roles: Object.fromEntries(
      ["implementer", "validator", "reviewer"].map((role) => [role, { harness: "h", model: "m" }]),
    ),
  };
  expect(validateConfig(base, "ark.yml").pr_writing).toEqual({
    reviewers: [],
    tier_floor: 0,
    sensitive_paths: [],
    one_way_paths: [],
    agent_authored: true,
  });
  for (const [key, value] of [
    ["tier_floor", 4],
    ["tier_floor", 1.5],
    ["reviewers", "alice"],
    ["agent_authored", "yes"],
  ] as const)
    expect(() => validateConfig({ ...base, pr_writing: { [key]: value } }, "ark.yml")).toThrow(
      `pr_writing.${key}`,
    );
});
