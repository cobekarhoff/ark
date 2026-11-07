/**
 * Opens or refreshes the one MR of a git repo branch, outside an Ark run or inside one.
 * Usage: bun post_mr.ts <repo directory> [--run <run folder>] [--base <branch>] [--title <title>]
 *                       [--summary <text>] [--dry-run]
 * `--dry-run` prints each host call and writes nothing. All logic lives in `../lib/`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildBody } from "../lib/body.ts";
import { buildLedger } from "../lib/ledger.ts";
import { lintBody } from "../lib/lint.ts";
import { buildTitle, postMergeRequest } from "../lib/post.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    run: { type: "string" },
    base: { type: "string" },
    title: { type: "string" },
    summary: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});
const [directory] = positionals;
if (directory === undefined) {
  console.error(
    "usage: post_mr.ts <repo directory> [--run <run folder>] [--base <branch>] [--title <title>] [--summary <text>] [--dry-run]",
  );
  process.exit(2);
}

const git = (...args: string[]) =>
  Bun.spawnSync(["git", ...args], { cwd: directory })
    .stdout.toString()
    .trim();
const branch = git("symbolic-ref", "--short", "HEAD");
const fullLedger = buildLedger(
  values.run === undefined
    ? { directory, base: values.base, dryRun: values["dry-run"] }
    : { runFolder: values.run, dryRun: values["dry-run"] },
);
// A run ledger holds every repo of the run: this MR is the one for the repo on the current branch.
const ledger =
  values.run === undefined
    ? fullLedger
    : { ...fullLedger, repos: fullLedger.repos.filter((repo) => repo.branch === branch) };
const repo = ledger.repos[0];
if (repo === undefined || fullLedger.host === "unknown") {
  console.error(`no repo on branch ${branch} with a known host in the ledger`);
  process.exit(1);
}

const title = values.title ?? buildTitle(ledger, values.summary);
const body = buildBody(ledger);
const failed = lintBody({ body, title, ledger }).filter((check) => check.result === "fail");
if (failed.length > 0) {
  console.error(failed.map((check) => `${check.id}: ${check.reason}`).join("\n"));
  process.exit(1);
}

const folder = mkdtempSync(join(tmpdir(), "ark-post-mr-"));
try {
  const bodyFile = join(folder, "body.md");
  writeFileSync(bodyFile, body);
  const posted = postMergeRequest({
    host: fullLedger.host,
    directory,
    branch,
    base: repo.base,
    title,
    bodyFile,
    ledger,
    reviewers: ledger.prWriting.reviewers,
    dryRun: values["dry-run"],
  });
  console.log(`${posted.action}  ${posted.url}`);
} finally {
  rmSync(folder, { recursive: true, force: true });
}
