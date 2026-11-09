/** Lints the title and body against the persisted ledger and records the body hash for STALE01. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ArkError } from "../../../cli/errors.ts";
import { ledgerPath, readLedgerFile, recordBodyHash } from "../lib/ledger.ts";
import { hashBody, lintBody } from "../lib/lint.ts";
import { currentState } from "../lib/post.ts";
import { emit, ledgerForRepo, repoRoot, runCli, say, titleOf } from "./cli.ts";

const name = "lint_body";

await runCli(
  {
    name,
    summary: "lint the title and body against the ledger; records the body hash for STALE01",
    options: {
      body: {
        type: "string",
        argument: "file",
        help: "Body file. Default: .pr-writing/body.md",
      },
      title: {
        type: "string",
        argument: "text",
        help: "Title. Default: built from config title_prefix and the ledger summary.",
      },
    },
    examples: ["", '--body draft.md --title "Fix retry on 429"'],
    stdout:
      '{"ok":true|false,"bodyHash":"...","head":"...","checks":[{"id":"VAL01","result":"fail|warn|pass|skip","reason":"..."}]}',
    exits: [
      "no check failed (warn is allowed); the body hash is recorded",
      "at least one check failed (including STALE01), or bad argument",
      "ledger missing or unreadable, not a git repo, git missing",
    ],
    schema: {
      title: "lint_body output",
      type: "object",
      required: ["ok", "bodyHash", "head", "checks"],
      properties: {
        ok: { type: "boolean", description: "false when any check has result fail" },
        bodyHash: { type: "string", description: "hash of the linted body; post_mr compares it" },
        head: { type: "string", description: "git head SHA at lint time" },
        checks: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "result", "reason"],
            properties: {
              id: { type: "string" },
              result: { enum: ["fail", "warn", "pass", "skip"] },
              reason: { type: "string" },
            },
          },
        },
      },
    },
  },
  (values) => {
    const root = repoRoot();
    if (root === null) {
      say(name, "not a git repository (or git is not installed).");
      emit({ error: "not a git repo" });
      return 2;
    }
    let file;
    try {
      file = readLedgerFile(root);
    } catch (error) {
      if (!(error instanceof ArkError)) throw error;
      say(name, `${error.message}`);
      emit({ error: "ledger missing", path: ledgerPath(root) });
      return 2;
    }
    const bodyFile = values.body ?? join(root, ".pr-writing", "body.md");
    if (!existsSync(bodyFile)) {
      say(name, `${bodyFile} not found: write the body first.`);
      emit({ error: "body missing", path: bodyFile });
      return 1;
    }
    const body = readFileSync(bodyFile, "utf8");
    const ledger = ledgerForRepo(file.ledger, root);
    if (ledger === null) {
      say(name, `${root} is not a repo of the ledger: run gather.ts here first.`);
      emit({ error: "ledger missing", path: ledgerPath(root) });
      return 2;
    }
    const { currentHeads, diff } = currentState(ledger, root, ledger.repos[0].base);
    const results = lintBody({
      body,
      title: titleOf(ledger, values.title),
      ledger,
      currentHeads,
      diff,
      bodyHash: hashBody(body),
    });
    const count = (result: string) => results.filter((check) => check.result === result).length;
    say(
      name,
      `${results.length} checks: ${count("pass")} pass, ${count("warn")} warn, ${count("skip")} skip, ${count("fail")} fail`,
    );
    for (const check of results.filter(
      (entry) => entry.result !== "pass" && entry.result !== "skip",
    ))
      say(name, `${check.result} ${check.id}: ${check.reason}`);
    const ok = count("fail") === 0;
    if (ok) recordBodyHash(root, body);
    else say(name, "fix the body and run lint_body again.");
    emit({
      ok,
      bodyHash: hashBody(body),
      head: currentHeads?.[ledger.repos[0].repo] ?? "",
      checks: results,
    });
    return ok ? 0 : 1;
  },
);
