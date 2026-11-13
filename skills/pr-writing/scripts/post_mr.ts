/**
 * Opens or updates the one MR of the current branch, after the human said go. Needs `gather.ts` and `lint_body.ts` first:
 * the persisted ledger and body hash are what STALE01 compares. All logic lives in `../lib/`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ArkError } from "../../../cli/errors.ts";
import { readLedgerFile } from "../lib/ledger.ts";
import { LintRefusal, postMergeRequest, ProbeFailure } from "../lib/post.ts";
import { currentBranch, emit, ledgerForRepo, repoRoot, runCli, say, titleOf } from "./cli.ts";

const name = "post_mr";

await runCli(
  {
    name,
    summary: "open or update the one MR/PR of the current branch",
    options: {
      confirmed: {
        type: "boolean",
        help: "REQUIRED. The human has seen the title, body and lint report and said go in this conversation.",
      },
      ready: {
        type: "boolean",
        help: "Create as ready. Default: Draft. An update keeps the MR's state.",
      },
      title: {
        type: "string",
        argument: "text",
        help: "Title. Default: built from config title_prefix and the ledger summary.",
      },
      body: { type: "string", argument: "file", help: "Body file. Default: .pr-writing/body.md" },
    },
    examples: ["--confirmed", '--confirmed --ready --title "Fix retry on 429"'],
    stdout:
      '{"action":"created|updated|unchanged","url":"...","draft":true|false}; a refusal {"refused":"...","posted":false}',
    exits: [
      "MR created or updated",
      "refused: no --confirmed, lint fail, STALE01 (stale head or body), bad argument",
      "environment: not authenticated, host unreachable, unknown host, git or gh/glab missing, an image upload failed, gh older than 2.99.0 (no --attach), a body over 65,536 characters on GitHub",
    ],
    schema: {
      title: "post_mr output",
      type: "object",
      properties: {
        action: { enum: ["created", "updated", "unchanged"] },
        url: { type: "string" },
        draft: { type: "boolean" },
        refused: { type: "string", description: "why nothing was posted" },
        posted: { const: false },
        checks: { type: "array", description: "the failed lint checks of a lint refusal" },
        error: { type: "string" },
      },
    },
  },
  (values) => {
    if (!values.confirmed) {
      say(
        name,
        "refused. Pass --confirmed only after the human has seen the title, body and lint report and said go in this conversation. Not posted.",
      );
      emit({ refused: "no --confirmed", posted: false });
      return 1;
    }
    const root = repoRoot();
    if (root === null) {
      say(name, "not a git repository (or git is not installed). Not posted.");
      emit({ error: "not a git repo", posted: false });
      return 2;
    }
    let file;
    try {
      file = readLedgerFile(root);
    } catch (error) {
      if (!(error instanceof ArkError)) throw error;
      say(name, `${error.message}. Not posted.`);
      emit({ error: "ledger missing", posted: false });
      return 2;
    }
    const branch = currentBranch(root);
    const ledger = ledgerForRepo(file.ledger, root);
    const repo = ledger?.repos[0];
    if (ledger === null || repo === undefined || ledger.host === "unknown") {
      say(name, `no repo at ${root} with a known host in the ledger. Not posted.`);
      emit({ error: "unknown host", posted: false });
      return 2;
    }
    const bodyFile = values.body ?? join(root, ".pr-writing", "body.md");
    if (!existsSync(bodyFile)) {
      say(name, `${bodyFile} not found: write the body first. Not posted.`);
      emit({ error: "body missing", posted: false });
      return 1;
    }
    if (file.bodyHash === null) {
      say(name, "refused. The body was never linted: run lint_body.ts first. Not posted.");
      emit({ refused: "not linted", posted: false });
      return 1;
    }
    try {
      const posted = postMergeRequest({
        host: ledger.host,
        directory: root,
        branch,
        base: repo.base,
        title: titleOf(ledger, values.title),
        bodyFile,
        ledger,
        reviewers: ledger.prWriting.reviewers,
        draft: values.ready !== true,
        lintedBodyHash: file.bodyHash,
      });
      if (posted.note !== undefined) say(name, `note: ${posted.note}`);
      say(name, `${posted.action} ${posted.draft ? "Draft " : ""}${posted.url}`);
      emit({ action: posted.action, url: posted.url, draft: posted.draft });
      return 0;
    } catch (error) {
      if (error instanceof LintRefusal) {
        say(name, `refused. ${error.message}`);
        if (error.checks.some((check) => check.id === "STALE01"))
          say(
            name,
            "run gather.ts, rewrite the body if needed, run lint_body.ts, show the human, then post again.",
          );
        emit({ refused: "lint fail", posted: false, checks: error.checks });
        return 1;
      }
      const message = error instanceof Error ? error.message : String(error);
      say(name, `${message} Not posted.`);
      const unauthenticated = /401|403|auth|log ?in|token/i.test(message);
      emit({
        error: unauthenticated
          ? "not authenticated"
          : error instanceof ProbeFailure
            ? "host unreachable"
            : "host call failed",
        host: ledger.host,
        detail: message,
        posted: false,
      });
      return 2;
    }
  },
);
