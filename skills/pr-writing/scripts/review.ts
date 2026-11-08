/** Runs the shell checks of `.pr-writing.toml` and records pass, fail or not_run for each. Changes no file itself. */
import { loadStandaloneConfig, runChecks, UnknownConfigKey } from "../lib/ledger.ts";
import { emit, repoRoot, runCli, say } from "./cli.ts";

const name = "review";

await runCli(
  {
    name,
    summary: "run the shell checks from .pr-writing.toml and record the results",
    options: {},
    examples: [""],
    stdout:
      '{"ok":true|false,"checks":[{"command":"...","status":"pass|fail|not_run","exit_code":0,"output_tail":["last 50 lines"]}]}',
    exits: [
      "every check passed (or none is configured)",
      "a check failed, or a config key or value is bad (no check ran)",
      "environment: no check failed and a check is not_run (its tool is missing)",
    ],
    schema: {
      title: "review output",
      type: "object",
      required: ["ok", "checks"],
      properties: {
        ok: { type: "boolean", description: "false when any check has status fail or not_run" },
        checks: {
          type: "array",
          items: {
            type: "object",
            required: ["command", "status", "exit_code", "output_tail"],
            properties: {
              command: { type: "string" },
              status: { enum: ["pass", "fail", "not_run"] },
              exit_code: { type: ["integer", "null"] },
              output_tail: { type: "array", items: { type: "string" }, maxItems: 50 },
            },
          },
        },
      },
    },
  },
  () => {
    const root = repoRoot() ?? process.cwd();
    let config;
    try {
      config = loadStandaloneConfig(root);
    } catch (error) {
      if (!(error instanceof UnknownConfigKey)) throw error;
      say(name, error.message);
      emit({ error: "bad config key", key: error.key });
      return 1;
    }
    const checks = runChecks(config.checks, root).map((check) => ({
      ...check,
      output_tail: check.output_tail === "" ? [] : check.output_tail.split("\n"),
    }));
    for (const check of checks)
      say(
        name,
        `${check.command} ... ${check.status === "not_run" ? "not run" : `exit ${check.exit_code}`}`,
      );
    const count = (status: string) => checks.filter((check) => check.status === status).length;
    const ok = count("fail") === 0 && count("not_run") === 0;
    say(
      name,
      `${checks.length} checks: ${count("pass")} passed, ${count("fail")} failed, ${count("not_run")} not_run. No file changed.`,
    );
    emit({ ok, checks });
    if (count("fail") > 0) return 1;
    return ok ? 0 : 2;
  },
);
