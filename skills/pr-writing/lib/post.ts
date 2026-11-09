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
import { hashBody, lintBody, maxTitleLength, type LintResult } from "./lint.ts";

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
  /** Open a new MR as a Draft (`--draft`). Default off: Ark opens ready MRs. An update never changes the Draft state. */
  draft?: boolean;
  /** `hashBody` of the generated body when it was linted last (see `persist.ts`). A different hash makes STALE01 fail. */
  lintedBodyHash?: string;
  /** The current head of the repo, when the caller just read it: the lint skips its own `rev-parse HEAD`. */
  head?: string;
};

export type Posted = {
  action: "created" | "updated" | "unchanged" | "dry-run";
  url: string;
  number: number;
  /** Whether the MR is a Draft after the post. */
  draft: boolean;
  /** Set when the post did something the person should know, such as a whole rewrite. */
  note?: string;
};

/** An open MR: its number (`iid` on GitLab), URL, description, Draft state and head SHA (`""` when the host omits it). */
export type OpenMergeRequest = {
  number: number;
  url: string;
  body: string;
  draft: boolean;
  head: string;
};
type Existing = OpenMergeRequest;

/** The open-MR probe failed: the host did not answer or answered nonsense. Scripts map it to exit 2. */
export class ProbeFailure extends ArkError {}

/** The one place a host command runs. In a dry run it prints each call, and a write is not run. */
function host(command: string[], directory: string, input: { dryRun?: boolean }, write = false) {
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

/**
 * The open MR on the source branch, or `null` when the host answered and found none.
 * A failed probe throws `ProbeFailure`, never `null`.
 */
export function probeOpenMergeRequest(target: {
  host: "github" | "gitlab";
  directory: string;
  branch: string;
  dryRun?: boolean;
}): OpenMergeRequest | null {
  const command =
    target.host === "github"
      ? [
          "gh",
          "pr",
          "list",
          "--head",
          target.branch,
          "--state",
          "open",
          "--json",
          "number,url,body,isDraft,headRefOid",
        ]
      : [
          "glab",
          "api",
          `projects/:fullpath/merge_requests?state=opened&source_branch=${encodeURIComponent(target.branch)}`,
        ];
  const result = host(command, target.directory, target);
  let list: unknown;
  try {
    list = result.ok ? JSON.parse(result.output) : undefined;
  } catch {
    list = undefined;
  }
  if (!Array.isArray(list))
    throw new ProbeFailure(
      `could not ask ${target.host} for an MR on ${target.branch}, so nothing was written: ${result.error || result.output || "unreadable answer"}`,
    );
  const first = list[0] as
    | {
        number: number;
        url: string;
        body?: string;
        isDraft?: boolean;
        headRefOid?: string;
        iid: number;
        web_url: string;
        description?: string;
        draft?: boolean;
        sha?: string;
      }
    | undefined;
  if (first === undefined) return null;
  return target.host === "github"
    ? {
        number: first.number,
        url: first.url,
        body: first.body ?? "",
        draft: first.isDraft === true,
        head: first.headRefOid ?? "",
      }
    : {
        number: first.iid,
        url: first.web_url,
        body: first.description ?? "",
        draft: first.draft === true,
        head: first.sha ?? "",
      };
}

/** A marker counts only alone on its line: an old body may quote the marker text inside a sentence or code span. */
const markerLine = (marker: string) =>
  new RegExp(`^${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*$`, "m");

const region = (text: string): [number, number] | null => {
  const start = text.match(markerLine(beginMarker));
  if (start?.index === undefined) return null;
  const afterStart = start.index + start[0].length;
  const end = text.slice(afterStart).match(markerLine(endMarker));
  return end?.index === undefined
    ? null
    : [start.index, afterStart + end.index + end[0].trimEnd().length];
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
export function currentState(
  ledger: Ledger,
  directory: string,
  base: string,
  knownHead?: string,
): { currentHeads?: Record<string, string>; diff?: string } {
  const repo = ledger.repos[0];
  const head = knownHead ?? git(["rev-parse", "HEAD"], directory);
  if (repo === undefined || head === null) return {};
  // The merge-request open path carries the ledger's own base ref; a standalone lint probes it.
  const baseRef =
    repo.baseRef ??
    (git(["rev-parse", "--verify", "--quiet", `origin/${base}`], directory)
      ? `origin/${base}`
      : base);
  return {
    currentHeads: { [repo.repo]: head },
    diff: git(["diff", `${baseRef}...HEAD`], directory) ?? undefined,
  };
}

/** The final body failed lint: `checks` holds the failed ones. Scripts print them as JSON. */
export class LintRefusal extends ArkError {
  constructor(readonly checks: LintResult[]) {
    super(
      `lint failed, nothing was written:\n${checks.map((check) => `${check.id}: ${check.reason}`).join("\n")}`,
    );
  }
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
  state: ReturnType<typeof currentState>,
  showWarnings = true,
) {
  const { currentHeads, diff } = state;
  const lint = (text: string, bodyHash = hashBody(text)) =>
    lintBody({
      body: text,
      title: input.title,
      ledger: input.ledger,
      currentHeads,
      diff,
      bodyHash,
    });
  // The linted hash belongs to the generated text, not to the merged body.
  const own = lint(generated, input.lintedBodyHash);
  const ownCheck = (id: string) => own.find((check) => check.id === id)!;
  const checks = lint(body).map((check) =>
    check.id === "PROV01" || check.id === "STALE01" ? ownCheck(check.id) : check,
  );
  for (const check of showWarnings ? checks.filter((entry) => entry.result === "warn") : [])
    console.error(`warning: ${check.id}: ${check.reason}`);
  const failed = checks
    .filter((check) => check.result === "fail")
    .filter((check) => existing === null || !check.id.startsWith("TITLE01"));
  if (failed.length > 0) throw new LintRefusal(failed);
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
          ...(input.draft ? ["--draft"] : []),
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
          ...(input.draft ? ["--draft"] : []),
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
  // The head and diff are read once: the probes between the two looks do not move HEAD.
  const state = currentState(input.ledger, input.directory, input.base, input.head);
  const first = probeOpenMergeRequest(input);
  refuseOnFail(input, first, finalBodyOf(generated, first).body, generated, state, false);
  const existing = probeOpenMergeRequest(input);
  const { body, note } = finalBodyOf(generated, existing);
  refuseOnFail(input, existing, body, generated, state);
  if (existing !== null && body === existing.body)
    return {
      action: "unchanged",
      url: existing.url,
      number: existing.number,
      draft: existing.draft,
    };

  const directory = mkdtempSync(join(tmpdir(), "ark-pr-writing-"));
  try {
    const bodyFile = join(directory, "body.md");
    writeFileSync(bodyFile, body);
    const command = writeCommand(input, existing, bodyFile, body);
    const result = host(command, input.directory, input, true);
    if (input.dryRun)
      return {
        action: "dry-run",
        url: existing?.url ?? "",
        number: existing?.number ?? 0,
        draft: existing?.draft ?? input.draft === true,
        note,
      };
    if (!result.ok)
      throw new ArkError(
        `\`${command.slice(0, 3).join(" ")}\` failed: ${result.error || result.output}`,
      );
    if (existing !== null)
      return {
        action: "updated",
        url: existing.url,
        number: existing.number,
        draft: existing.draft,
        note,
      };
    const url = result.output.match(/https?:\/\/\S+/)?.[0];
    const number = Number(url?.match(/\/(\d+)\/?$/)?.[1]);
    if (url === undefined || !Number.isInteger(number))
      throw new ArkError(`could not read the MR URL for ${input.branch} from: ${result.output}`);
    return { action: "created", url, number, draft: input.draft === true, note };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
