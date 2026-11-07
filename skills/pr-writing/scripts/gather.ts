/** Writes `.pr-writing/ledger.json` for the current branch from git and the host, or prints the open MR. */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildBody } from "../lib/body.ts";
import {
  buildLedger,
  hostOf,
  ledgerPath,
  loadStandaloneConfig,
  UnknownConfigKey,
  writeLedgerFile,
} from "../lib/ledger.ts";
import { probeOpenMergeRequest, ProbeFailure } from "../lib/post.ts";
import { currentBranch, emit, ledgerForBranch, repoRoot, runCli, say } from "./cli.ts";

const name = "gather";

await runCli(
  {
    name,
    summary: "write the ledger of the current branch (git + host), or print the open MR",
    options: {
      base: {
        type: "string",
        argument: "branch",
        help: "Base branch. Default: the open MR target, else the host's default branch.",
      },
      "run-dir": {
        type: "string",
        argument: "dir",
        help: "Use the Ark ledger of this run folder instead of git.",
      },
      "existing-only": {
        type: "boolean",
        help: "Print the open MR of this branch as JSON, or nothing. Writes no file.",
      },
    },
    examples: ["", "--base develop", "--run-dir ~/.ark/projects/app/runs/RUN", "--existing-only"],
    stdout:
      '{"ledger":".pr-writing/ledger.json","head":"...","base":"...","host":"...","files":6,"existing_mr":null}; with --existing-only {"iid":412,"url":"...","draft":true,"head":"..."} or nothing',
    exits: [
      "ledger written (or MR printed, or no MR)",
      "bad argument or config key, not on a branch, empty diff",
      "environment: not a git repo, unknown host, auth, network, probe failed (--existing-only)",
    ],
    schema: {
      title: "gather output",
      type: "object",
      properties: {
        ledger: { type: "string", description: "path of the ledger file written" },
        head: { type: "string" },
        base: { type: "string" },
        host: { enum: ["github", "gitlab", "unknown"] },
        files: { type: "integer" },
        existing_mr: {
          type: ["object", "null"],
          description: "the open MR, or null when none or the probe failed",
        },
        iid: { type: "integer", description: "--existing-only: MR number" },
        url: { type: "string" },
        draft: { type: "boolean" },
        error: { type: "string" },
      },
    },
  },
  (values) => run(values),
);

function run(values: { base?: string; "run-dir"?: string; "existing-only"?: boolean }): number {
  const root = repoRoot();
  if (root === null) {
    say(name, "not a git repository (or git is not installed).");
    emit({ error: "not a git repo" });
    return 2;
  }
  const branch = currentBranch(root);
  if (branch === "") {
    say(name, "HEAD is detached: check out the branch of the MR.");
    emit({ error: "not on a branch" });
    return 1;
  }
  const host = hostOf(
    Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: root, stdout: "pipe" })
      .stdout.toString()
      .trim(),
  );

  if (values["existing-only"]) {
    if (host === "unknown") {
      say(name, "the origin remote is neither GitHub nor GitLab: cannot probe for an MR.");
      emit({ error: "probe failed", detail: "unknown host" });
      return 2;
    }
    try {
      const open = probeOpenMergeRequest({ host, directory: root, branch });
      if (open === null) {
        say(name, `no open MR for ${branch}`);
        return 0;
      }
      emit({ iid: open.number, url: open.url, draft: open.draft, head: open.head });
      return 0;
    } catch (error) {
      if (!(error instanceof ProbeFailure)) throw error;
      say(name, error.message);
      emit({ error: "probe failed", detail: error.message });
      return 2;
    }
  }

  let config;
  try {
    config = loadStandaloneConfig(root);
  } catch (error) {
    if (!(error instanceof UnknownConfigKey)) throw error;
    say(name, error.message);
    emit({ error: "bad config key", key: error.key });
    return 1;
  }
  const full = buildLedger(
    values["run-dir"] === undefined
      ? { directory: root, base: values.base, prWriting: config }
      : { runFolder: values["run-dir"] },
  );
  const ledger = ledgerForBranch(full, branch);
  const repo = ledger.repos[0];
  if (repo === undefined || repo.files.length === 0) {
    say(name, `no changed files on ${branch} against the base: nothing to write.`);
    emit({ error: "empty diff" });
    return 1;
  }
  say(
    name,
    `branch ${branch} vs ${repo.base}, ${repo.commits.length} commits, ${repo.files.length} files, host ${full.host}`,
  );
  writeLedgerFile(root, full);
  // The folder keeps ledger.json, body.md and nothing of it in `git status`.
  writeFileSync(join(root, ".pr-writing", ".gitignore"), "*\n");
  const bodyFile = join(root, ".pr-writing", "body.md");
  if (!existsSync(bodyFile)) writeFileSync(bodyFile, buildBody(ledger));
  say(name, `wrote ${ledgerPath(root)} (head ${repo.head.slice(0, 7)})`);

  let existing = null;
  if (host !== "unknown") {
    try {
      const open = probeOpenMergeRequest({ host, directory: root, branch });
      existing = open && { iid: open.number, url: open.url, draft: open.draft, head: open.head };
    } catch (error) {
      if (!(error instanceof ProbeFailure)) throw error;
      say(name, `warning: ${error.message}`);
    }
  }
  emit({
    ledger: ".pr-writing/ledger.json",
    head: repo.head,
    base: repo.base,
    host: full.host,
    files: repo.files.length,
    existing_mr: existing,
  });
  return 0;
}
