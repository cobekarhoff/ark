/** Replay eval: lints the frozen bodies of Ark PRs #121, #117 and #109 and prints the failure rate per check id. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lintBody } from "../lib/lint.ts";
import { emit, runCli, say } from "../scripts/cli.ts";
import { evalsLedger, evalsTitle } from "./ledger.ts";

const name = "run_evals";
const folder = import.meta.dir;
const replays = ["121", "117", "109"].map((number) => ({
  pr: `#${number}`,
  file: `pr-${number}.md`,
}));

await runCli(
  {
    name,
    summary:
      "lint the frozen bodies of PR #121, #117 and #109 offline; print the failure rate per check and the grader rubric",
    options: {},
    examples: [""],
    stdout:
      '{"bodies":["#121","#117","#109"],"checks":[{"id":"VAL01","failed":0,"total":3,"rate":0}],"failures":[{"pr":"#121","id":"VAL01","reason":"..."}],"rubric":["..."]}',
    exits: [
      "the eval ran, whether or not a body failed lint (it measures, it is not a gate)",
      "bad argument",
      "a fixture or the rubric is unreadable",
    ],
    schema: {
      title: "run_evals output",
      type: "object",
      required: ["bodies", "checks", "failures", "rubric"],
      properties: {
        bodies: { type: "array", items: { type: "string" } },
        checks: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "failed", "total", "rate"],
            properties: {
              id: { type: "string" },
              failed: { type: "integer", description: "bodies where the check result is fail" },
              total: { type: "integer", description: "bodies linted" },
              rate: { type: "number", description: "failed / total" },
            },
          },
        },
        failures: {
          type: "array",
          items: {
            type: "object",
            required: ["pr", "id", "reason"],
            properties: {
              pr: { type: "string" },
              id: { type: "string" },
              reason: { type: "string" },
            },
          },
        },
        rubric: { type: "array", items: { type: "string" }, description: "the six rubric items" },
      },
    },
  },
  () => {
    const rubricText = readFileSync(join(folder, "rubric.md"), "utf8");
    const rubric = [...rubricText.matchAll(/^\d+\. (.+)$/gm)].map((match) => match[1]);
    const linted = replays.map(({ pr, file }) => ({
      pr,
      results: lintBody({
        body: readFileSync(join(folder, file), "utf8"),
        title: evalsTitle,
        ledger: evalsLedger,
      }),
    }));
    const ids = linted[0].results.map((check) => check.id);
    const checks = ids.map((id) => {
      const failed = linted.filter(({ results }) =>
        results.some((check) => check.id === id && check.result === "fail"),
      ).length;
      return { id, failed, total: linted.length, rate: failed / linted.length };
    });
    const failures = linted.flatMap(({ pr, results }) =>
      results
        .filter((check) => check.result === "fail")
        .map((check) => ({ pr, id: check.id, reason: check.reason })),
    );
    for (const check of checks.filter((entry) => entry.failed > 0))
      say(name, `${check.id} failed on ${check.failed} of ${check.total} bodies`);
    say(name, `grade each body against this rubric:\n${rubricText}`);
    emit({ bodies: replays.map(({ pr }) => pr), checks, failures, rubric });
    return 0;
  },
);
