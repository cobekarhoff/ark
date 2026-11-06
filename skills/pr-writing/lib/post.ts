/**
 * `postMergeRequest` creates or updates the one MR of a branch on GitHub (`gh`) or GitLab (`glab`), with the body
 * from a file. It probes the host twice, the second time just before it writes. An update replaces only the text
 * between the two markers. The final body is linted, and a `fail` refuses the post before any write.
 * `buildTitle` is the one place that makes an MR title.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArkError } from "../../../cli/errors.ts";
import { beginMarker, endMarker } from "./body.ts";
import type { Ledger } from "./ledger.ts";
import { hashBody, lintBody } from "./lint.ts";

export const maxTitleLength = 72;

/** An MR title: `<ticket id>: <summary>`, or the repo `title_prefix` rule when the config has one. */
export function buildTitle(ledger: Ledger, summaryFlag?: string): string {
  const ticket = ledger.ticket;
  if (ticket === null) throw new ArkError("the ledger has no ticket: cannot build an MR title");
  const rule = ledger.prWriting.title_prefix;
  const titleOf = (summary: string) =>
    rule
      ? rule.replace("TICKET", ticket.id).replace("type", "feat").replace("desc", summary)
      : `${ticket.id}: ${summary}`;
  if (summaryFlag !== undefined) {
    const title = titleOf(summaryFlag.trim());
    if (title.length > maxTitleLength)
      throw new ArkError(
        `--summary makes a title of ${title.length} characters, ${maxTitleLength} allowed: ${title}`,
      );
    return title;
  }
  const usable = [ticket.summary, ticket.title]
    .filter((summary): summary is string => summary !== null && summary.trim() !== "")
    .map((summary) => titleOf(summary.trim()))
    .find((title) => title.length <= maxTitleLength);
  if (usable === undefined) throw new ArkError("ticket has no summary: pass --summary");
  return usable;
}

export type PostInput = {
  host: "github" | "gitlab";
  /** A directory inside the repo: `gh` and `glab` read the remote from it. */
  directory: string;
  branch: string;
  base: string;
  title: string;
  bodyFile: string;
  /** The ledger the body was written from: its token owner is the assignee, and the lint reads it. */
  ledger: Ledger;
  reviewers: string[];
  dryRun?: boolean;
};

export type Posted = {
  action: "created" | "updated" | "unchanged" | "dry-run";
  url: string;
  number: number;
  /** Set when the post did something the person should know, such as a whole rewrite. */
  note?: string;
};

type Existing = { number: number; url: string; body: string };

/** The one place a host command runs. In a dry run it prints each call, and a write is not run. */
function host(command: string[], directory: string, input: PostInput, write = false) {
  if (input.dryRun) {
    console.log(`dry-run: ${command.join(" ")}`);
    if (write) return { ok: true, output: "", error: "" };
  }
  const result = Bun.spawnSync(command, { cwd: directory, stdout: "pipe", stderr: "pipe" });
  return {
    ok: result.exitCode === 0,
    output: result.stdout.toString().trim(),
    error: result.stderr.toString().trim(),
  };
}

/** The open MR on the source branch, or `null` when the host answered and found none. A failed probe throws. */
function probe(input: PostInput): Existing | null {
  const command =
    input.host === "github"
      ? ["gh", "pr", "list", "--head", input.branch, "--state", "open", "--json", "number,url,body"]
      : [
          "glab",
          "api",
          `projects/:fullpath/merge_requests?state=opened&source_branch=${encodeURIComponent(input.branch)}`,
        ];
  const result = host(command, input.directory, input);
  let list: unknown;
  try {
    list = result.ok ? JSON.parse(result.output) : undefined;
  } catch {
    list = undefined;
  }
  if (!Array.isArray(list))
    throw new ArkError(
      `could not ask ${input.host} for an MR on ${input.branch}, so nothing was written: ${result.error || result.output || "unreadable answer"}`,
    );
  const first = list[0] as
    | {
        number: number;
        url: string;
        body?: string;
        iid: number;
        web_url: string;
        description?: string;
      }
    | undefined;
  if (first === undefined) return null;
  return input.host === "github"
    ? { number: first.number, url: first.url, body: first.body ?? "" }
    : { number: first.iid, url: first.web_url, body: first.description ?? "" };
}

const region = (text: string): [number, number] | null => {
  const start = text.indexOf(beginMarker);
  const end = text.indexOf(endMarker, start + 1);
  return start === -1 || end === -1 ? null : [start, end + endMarker.length];
};

/** The body to write: the file when there is no MR or the old body has no markers, else the old body with its marked text replaced. */
function finalBodyOf(
  generated: string,
  existing: Existing | null,
): { body: string; note?: string } {
  if (existing === null) return { body: generated };
  const old = region(existing.body);
  const fresh = region(generated);
  if (old === null || fresh === null)
    return {
      body: generated,
      note: "the old MR body has no pr-writing markers: rewrote the whole body once",
    };
  return {
    body: `${existing.body.slice(0, old[0])}${generated.slice(...fresh)}${existing.body.slice(old[1])}`,
  };
}

const git = (args: string[], directory: string) => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
};

/** The head of the repo now and its three-dot diff against the base, read at the moment of the lint. */
function current(input: PostInput): { currentHeads?: Record<string, string>; diff?: string } {
  const repo = input.ledger.repos[0];
  const head = git(["rev-parse", "HEAD"], input.directory);
  if (repo === undefined || head === null) return {};
  const base = git(["rev-parse", "--verify", "--quiet", `origin/${input.base}`], input.directory)
    ? `origin/${input.base}`
    : input.base;
  return {
    currentHeads: { [repo.repo]: head },
    diff: git(["diff", `${base}...HEAD`], input.directory) ?? undefined,
  };
}

/**
 * Lints the final body, with the repo's current head and diff so STALE01 and SEC01 run, and prints the warnings.
 * A warning never refuses the post. Text a person put above the markers must not hide the provenance line, so PROV01 reads the
 * generated text alone. An update leaves the title alone, so it skips the title checks: an old MR may hold a long title.
 */
function refuseOnFail(
  input: PostInput,
  existing: Existing | null,
  body: string,
  generated: string,
  showWarnings = true,
) {
  const { currentHeads, diff } = current(input);
  const lint = (text: string) =>
    lintBody({
      body: text,
      title: input.title,
      ledger: input.ledger,
      currentHeads,
      diff,
      bodyHash: hashBody(text),
    });
  const own = lint(generated).find((check) => check.id === "PROV01")!;
  const checks = lint(body).map((check) => (check.id === "PROV01" ? own : check));
  for (const check of showWarnings ? checks.filter((entry) => entry.result === "warn") : [])
    console.error(`warning: ${check.id}: ${check.reason}`);
  const failed = checks
    .filter((check) => check.result === "fail")
    .filter((check) => existing === null || !check.id.startsWith("TITLE01"));
  if (failed.length > 0)
    throw new ArkError(
      `lint failed, nothing was written:\n${failed.map((check) => `${check.id}: ${check.reason}`).join("\n")}`,
    );
}

/** `gh` and `glab` flags for the assignee and the reviewers; a reviewer is never the token owner. */
function people(input: PostInput): { assignee: string[]; reviewers: string[] } {
  const owner = input.ledger.tokenOwner;
  const reviewers = input.reviewers.filter((name) => name !== owner);
  if (input.reviewers.length > 0 && reviewers.length === 0)
    console.error(`warning: reviewers lists only the author @${owner}: no reviewer set`);
  return {
    assignee: owner === "unknown" ? [] : [owner],
    reviewers,
  };
}

function writeCommand(input: PostInput, existing: Existing | null, bodyFile: string, body: string) {
  const { assignee, reviewers } = people(input);
  const github = input.host === "github";
  if (existing === null)
    return github
      ? [
          "gh",
          "pr",
          "create",
          "--base",
          input.base,
          "--head",
          input.branch,
          "--title",
          input.title,
          "--body-file",
          bodyFile,
          ...(assignee.length > 0 ? ["--assignee", assignee[0]] : []),
          ...(reviewers.length > 0 ? ["--reviewer", reviewers.join(",")] : []),
        ]
      : [
          "glab",
          "mr",
          "create",
          "--source-branch",
          input.branch,
          "--target-branch",
          input.base,
          "--title",
          input.title,
          "--description",
          body,
          "--yes",
          ...(assignee.length > 0 ? ["--assignee", assignee[0]] : []),
          ...(reviewers.length > 0 ? ["--reviewer", reviewers.join(",")] : []),
        ];
  return github
    ? [
        "gh",
        "pr",
        "edit",
        String(existing.number),
        "--body-file",
        bodyFile,
        ...(assignee.length > 0 ? ["--add-assignee", assignee[0]] : []),
        ...(reviewers.length > 0 ? ["--add-reviewer", reviewers.join(",")] : []),
      ]
    : [
        "glab",
        "mr",
        "update",
        String(existing.number),
        "--description",
        body,
        ...(assignee.length > 0 ? ["--assignee", assignee[0]] : []),
        ...(reviewers.length > 0 ? ["--reviewer", reviewers.join(",")] : []),
      ];
}

export function postMergeRequest(input: PostInput): Posted {
  const generated = readFileSync(input.bodyFile, "utf8");
  // First look: refuse early. Second look, just before the write: the host may have changed in between.
  const first = probe(input);
  refuseOnFail(input, first, finalBodyOf(generated, first).body, generated, false);
  const existing = probe(input);
  const { body, note } = finalBodyOf(generated, existing);
  refuseOnFail(input, existing, body, generated);
  if (existing !== null && body === existing.body)
    return { action: "unchanged", url: existing.url, number: existing.number };

  const directory = mkdtempSync(join(tmpdir(), "ark-pr-writing-"));
  try {
    const bodyFile = join(directory, "body.md");
    writeFileSync(bodyFile, body);
    const command = writeCommand(input, existing, bodyFile, body);
    const result = host(command, input.directory, input, true);
    if (input.dryRun)
      return { action: "dry-run", url: existing?.url ?? "", number: existing?.number ?? 0, note };
    if (!result.ok)
      throw new ArkError(
        `\`${command.slice(0, 3).join(" ")}\` failed: ${result.error || result.output}`,
      );
    if (existing !== null)
      return { action: "updated", url: existing.url, number: existing.number, note };
    const url = result.output.match(/https?:\/\/\S+/)?.[0];
    const number = Number(url?.match(/\/(\d+)\/?$/)?.[1]);
    if (url === undefined || !Number.isInteger(number))
      throw new ArkError(`could not read the MR URL for ${input.branch} from: ${result.output}`);
    return { action: "created", url, number, note };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
