/**
 * The CLI contract the four pr-writing scripts share: `--help` (prose on stderr, stdout empty), `--json-schema`,
 * JSON on stdout, prose on stderr, exit 0 success, 1 violation or refusal, 2 environment problem.
 * A bad argument exits 1 with `{"error": ...}` on stdout and a hint to `--help` on stderr.
 */
import { realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { ArkError } from "../../../cli/errors.ts";
import type { Ledger } from "../lib/ledger.ts";
import { buildTitle } from "../lib/post.ts";

type OptionSpec = { type: "string" | "boolean"; argument?: string; help: string };
type Values<Options extends Record<string, OptionSpec>> = {
  [Name in keyof Options]?: Options[Name]["type"] extends "string" ? string : boolean;
};

export type Spec<Options extends Record<string, OptionSpec>> = {
  name: string;
  summary: string;
  options: Options;
  examples: string[];
  /** One line: the JSON shape of stdout. */
  stdout: string;
  /** What each exit code means, keyed 0, 1 and 2. */
  exits: [string, string, string];
  schema: Record<string, unknown>;
};

const command = (name: string) => `bun skills/pr-writing/scripts/${name}.ts`;

function helpText<Options extends Record<string, OptionSpec>>(spec: Spec<Options>): string {
  const entries: [string, string][] = [
    ...Object.entries(spec.options).map(([option, { argument, help }]): [string, string] => [
      argument === undefined ? `--${option}` : `--${option} <${argument}>`,
      help,
    ]),
    ["--json-schema", "Print the JSON schema of stdout and exit 0."],
    ["-h, --help", "Print this text on stderr and exit 0."],
  ];
  const width = Math.max(...entries.map(([flag]) => flag.length));
  return [
    `${spec.name}.ts - ${spec.summary}`,
    "",
    "OPTIONS",
    ...entries.map(([flag, help]) => `  ${flag.padEnd(width)}  ${help}`),
    "",
    "EXAMPLES",
    ...spec.examples.map(
      (example) => `  ${command(spec.name)}${example === "" ? "" : ` ${example}`}`,
    ),
    "",
    `STDOUT   ${spec.stdout}`,
    "STDERR   prose: what was done, or why it refused",
    "",
    "EXIT CODES",
    ...spec.exits.map((meaning, code) => `  ${code}  ${meaning}`),
    "",
  ].join("\n");
}

/** Prose for a person, on stderr, prefixed with the script name. */
export const say = (name: string, message: string) => console.error(`${name}: ${message}`);

/** The one JSON document of stdout. */
export const emit = (document: unknown) => console.log(JSON.stringify(document));

/** Parses the arguments, answers `--help` and `--json-schema`, then runs `main` and sets the exit code. */
export async function runCli<Options extends Record<string, OptionSpec>>(
  spec: Spec<Options>,
  main: (values: Values<Options>) => number | Promise<number>,
): Promise<void> {
  try {
    const { values }: { values: Record<string, string | boolean | undefined> } = parseArgs({
      options: {
        ...spec.options,
        "json-schema": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) {
      process.stderr.write(helpText(spec));
      return;
    }
    if (values["json-schema"]) {
      emit({ $schema: "https://json-schema.org/draft/2020-12/schema", ...spec.schema });
      return;
    }
    process.exitCode = await main(values as Values<Options>);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const parseFailure =
      error instanceof TypeError &&
      "code" in error &&
      String(error.code).startsWith("ERR_PARSE_ARGS");
    if (parseFailure) {
      const problem = message.split(". ")[0] ?? message;
      say(spec.name, `${problem}. Try --help.`);
      emit({ error: problem });
      process.exitCode = 1;
      return;
    }
    // A violation the lib refuses is exit 1; anything else (a missing program, a crash of the host call) is the environment.
    say(spec.name, message);
    emit({ error: message });
    process.exitCode = error instanceof ArkError ? 1 : 2;
  }
}

/** The root of the git repo that holds the current directory, or `null` outside a repo or without git. */
export function repoRoot(): string | null {
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return result.exitCode === 0 ? result.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

/** The branch checked out at `root`, or `""` when HEAD is detached. */
export function currentBranch(root: string): string {
  const result = Bun.spawnSync(["git", "symbolic-ref", "--short", "HEAD"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0 ? result.stdout.toString().trim() : "";
}

/**
 * A run ledger holds every repo of the run: this MR is the one for the repo at `root`. The returned ledger carries
 * that repo's host, token owner and template; a ledger written before per-repo fields keeps its run-level values.
 * Returns `null` when no repo of the ledger is at `root`.
 */
export function ledgerForRepo(ledger: Ledger, root: string): Ledger | null {
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  const repo = ledger.repos.find(
    (entry) => entry.path === undefined || real(entry.path) === real(root),
  );
  if (repo === undefined) return null;
  return {
    ...ledger,
    repos: [repo],
    host: repo.host ?? ledger.host,
    tokenOwner: repo.tokenOwner ?? ledger.tokenOwner,
    template: repo.template === undefined ? ledger.template : repo.template,
  };
}

/** `--title`, else the title built from the config rule and the ledger summary. Throws `ArkError` when neither exists. */
export function titleOf(ledger: Ledger, flag: string | undefined): string {
  if (flag !== undefined) return flag;
  try {
    return buildTitle(ledger);
  } catch (error) {
    throw new ArkError(`no title: pass --title (${(error as Error).message})`);
  }
}
