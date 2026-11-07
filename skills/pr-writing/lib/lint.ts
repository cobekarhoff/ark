/**
 * Lint for an MR title and body. `lintBody` returns every check with its id, a result and a reason.
 * Decidable checks `fail`; judgment checks `warn`. A check that does not apply is `skip`.
 */
import type { Finding, Ledger } from "./ledger.ts";

export type LintResult = {
  id: string;
  result: "fail" | "warn" | "pass" | "skip";
  reason: string;
};

export type LintInput = {
  body: string;
  title: string;
  ledger: Ledger;
  /** Three-dot diff text. Without it SEC01 skips. */
  diff?: string;
  /** Head SHA of each repo now, keyed by repo. Without it the head half of STALE01 skips. */
  currentHeads?: Record<string, string>;
  /** `hashBody` of the body when it was linted last. Without it the body half of STALE01 skips. */
  bodyHash?: string;
  /** Reason line that raises the tier by one. A raise with no reason is ignored. */
  raise?: string;
};

export type Tier = { tier: 0 | 1 | 2 | 3; reason: string };

export function hashBody(body: string): string {
  return new Bun.CryptoHasher("sha256").update(body).digest("hex");
}

// --- tier -------------------------------------------------------------------------------------

/** 0: 20 lines or less and no sensitive path; 1: under 150; 2: under 400; 3: else. Never below the floor. */
export function tierOf(input: {
  changedLines: number;
  sensitiveHits: string[];
  floor: number;
  raise?: string;
}): Tier {
  const { changedLines, sensitiveHits, floor } = input;
  let tier = changedLines <= 20 ? 0 : changedLines < 150 ? 1 : changedLines < 400 ? 2 : 3;
  const reasons = [`${changedLines} changed lines`];
  if (sensitiveHits.length > 0) {
    reasons.push(`sensitive path ${sensitiveHits.join(", ")}`);
    tier = Math.max(tier, 1);
  }
  if (input.raise !== undefined && input.raise.trim() !== "") {
    reasons.push(`raise: ${input.raise.trim()}`);
    tier = Math.min(3, tier + 1);
  }
  if (floor > tier) {
    reasons.push(`tier_floor ${floor}`);
    tier = floor;
  }
  return { tier: tier as Tier["tier"], reason: reasons.join("; ") };
}

function changedLinesOf(shortstat: string): number {
  const numbers = [...shortstat.matchAll(/(\d+) (?:insertion|deletion)/g)].map((match) =>
    Number(match[1]),
  );
  return numbers.reduce((sum, count) => sum + count, 0);
}

export function tierOfLedger(ledger: Ledger, raise?: string): Tier {
  return tierOf({
    changedLines: ledger.repos.reduce((sum, repo) => sum + changedLinesOf(repo.shortstat), 0),
    sensitiveHits: ledger.risk.sensitiveHits,
    floor: ledger.prWriting.tier_floor,
    raise,
  });
}

// --- gaps -------------------------------------------------------------------------------------

export type Gap = { keys: string[]; text: string };

/** The short form of a criterion id: `ARK-316/AC4` is `AC4`. */
export function shortId(id: string): string {
  return id.split("/").at(-1)!;
}

function findingGap(finding: Finding): Gap {
  return {
    keys: [finding.title],
    text: `${finding.rank} open: ${finding.title} (\`findings/${finding.file}\`)`,
  };
}

/** Everything the ledger says is not done. The body lists each under `Not done`; VAL03 checks it. ACs with the same status share one item. */
export function gapsOf(ledger: Ledger): Gap[] {
  const gaps = ledger.findings.map(findingGap);
  const byStatus = new Map<string, string[]>();
  for (const criterion of ledger.criteria) {
    if (criterion.status === "passing" || criterion.status === "manual ok") continue;
    byStatus.set(criterion.status, [
      ...(byStatus.get(criterion.status) ?? []),
      shortId(criterion.id),
    ]);
  }
  for (const [status, ids] of byStatus)
    gaps.push({
      keys: ids,
      text: status.startsWith("manual")
        ? `${ids.join(" ")} ${status}: no manual ok yet`
        : `${ids.join(" ")} not proven: ${status}`,
    });
  for (const check of ledger.checks) {
    if (check.state === "passed" || check.state === "unknown") continue;
    gaps.push({
      keys: [check.name],
      text: `Check \`${check.name}\` ${check.state === "failed" ? "failed" : "did not run"} on the last head`,
    });
  }
  return gaps;
}

// --- markdown reading -------------------------------------------------------------------------

const isHeading = (line: string) => /^#{1,6}\s/.test(line);
const isLabel = (line: string) => /^\*\*[^*]+\*\*\s*$/.test(line);
const isListItem = (line: string) => /^\s*([-*+]|\d+[.)])\s/.test(line);
const isTableRow = (line: string) => /^\s*\|/.test(line);
const isQuote = (line: string) => /^\s*>/.test(line);
const isComment = (line: string) => /^\s*<!--.*-->\s*$/.test(line);

/** Lines outside code fences, with their 1-based line numbers. */
function unfenced(body: string): { text: string; number: number }[] {
  let inside = false;
  const lines: { text: string; number: number }[] = [];
  body.split("\n").forEach((text, index) => {
    if (/^\s*(```|~~~)/.test(text)) inside = !inside;
    else if (!inside) lines.push({ text, number: index + 1 });
  });
  return lines;
}

const isProse = (line: string) =>
  line.trim() !== "" &&
  !isHeading(line) &&
  !isLabel(line) &&
  !isListItem(line) &&
  !isTableRow(line) &&
  !isQuote(line) &&
  !isComment(line);

/** The text of the section whose heading (`## name`) or bold label (`**name**`) matches, up to the next one. */
function sectionOf(body: string, name: RegExp): string | null {
  const lines = unfenced(body).map((line) => line.text);
  const start = lines.findIndex((line) => {
    const title = line.match(/^#{1,6}\s+(.*?)\s*$/)?.[1] ?? line.match(/^\*\*([^*]+)\*\*\s*$/)?.[1];
    return title !== undefined && name.test(title);
  });
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => isHeading(line) || isLabel(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

const notDoneName = /^Not done\b/i;
const evidenceName = /^Evidence\b/i;

function sentences(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// --- checks -----------------------------------------------------------------------------------

type Check = (input: LintInput) => Omit<LintResult, "id">;
const pass = (reason: string) => ({ result: "pass" as const, reason });
const fail = (reason: string) => ({ result: "fail" as const, reason });
const warn = (reason: string) => ({ result: "warn" as const, reason });
const skip = (reason: string) => ({ result: "skip" as const, reason });

const variants = [
  /^> Written by an AI agent on behalf of @(\S+?), following their spec\.(?: @\1 has not reviewed it yet\.)?$/,
  /^> Written by an AI agent on behalf of @(\S+?), who shaped the solution\.(?: @\1 has not reviewed it yet\.)?$/,
  /^> Written by an AI agent on behalf of @(\S+?)\.(?: @\1 has not reviewed it yet\.)?$/,
];

/** The first line of the body that is not blank and not a pr-writing marker. */
function firstContent(body: string): { text: string; index: number; lines: string[] } {
  const lines = body.split("\n");
  const index = lines.findIndex((line) => line.trim() !== "" && !isComment(line));
  return { text: index === -1 ? "" : lines[index].trimEnd(), index, lines };
}

const PROV01: Check = ({ body, ledger }) => {
  if (!ledger.prWriting.agent_authored) return skip("agent_authored is false");
  if (ledger.tokenOwner === "unknown")
    return fail(
      "the token owner is unknown (the host probe failed), so the provenance line cannot name a handle: sign in with gh or glab",
    );
  const { text, index, lines } = firstContent(body);
  const matched = variants.map((variant) => text.match(variant)).find((match) => match !== null);
  if (!matched) {
    const later = lines.findIndex((line) => variants.some((variant) => variant.test(line.trim())));
    return fail(
      later > index
        ? `the provenance line is line ${later + 1}, not the first line`
        : `the first line is not a provenance variant: ${text.slice(0, 80) || "(empty)"}`,
    );
  }
  if (matched[1] !== ledger.tokenOwner)
    return fail(
      `the provenance line names @${matched[1]}, the token owner is @${ledger.tokenOwner}`,
    );
  const sentence = `@${matched[1]} has not reviewed it yet.`;
  const next = lines.slice(index + 1).find((line) => line.trim() !== "");
  return text.endsWith(sentence) || next?.trim() === sentence
    ? pass("first line is a provenance variant")
    : fail(`the provenance line is not followed by "${sentence}"`);
};

const modelTrailer =
  /^\s*Co-Authored-By:.*(Claude|Anthropic|OpenAI|GPT|Copilot|Gemini|Codex|noreply@anthropic)/im;
const generatedLine = /^.*Generated with.*$/im;

const PROV02: Check = ({ body, ledger }) => {
  const found = (text: string) => text.match(modelTrailer)?.[0] ?? text.match(generatedLine)?.[0];
  const inBody = found(body);
  if (inBody) return fail(`the body has "${inBody.trim()}"`);
  for (const repo of ledger.repos)
    for (const commit of repo.commits) {
      const line = found(commit.message);
      if (line) return fail(`commit ${commit.sha.slice(0, 7)} in the range has "${line.trim()}"`);
    }
  return pass("no model Co-Authored-By or Generated with line");
};

/** `feat(TICKET): desc` as a regex: `TICKET` is a ticket id, `desc` the rest, any other word is itself or a word. */
function prefixPattern(rule: string): RegExp {
  const source = rule
    .split(/(TICKET|desc|type)/)
    .map((part) =>
      part === "TICKET"
        ? "[A-Z][A-Z0-9]*-\\d+"
        : part === "desc"
          ? ".+"
          : part === "type"
            ? "[a-z]+"
            : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`);
}

const TITLE01: Check = ({ title, ledger }) => {
  const problems: string[] = [];
  if (title.length > 72) problems.push(`${title.length} characters, 72 allowed`);
  if (title.endsWith(".")) problems.push("ends with a period");
  const rule = ledger.prWriting.title_prefix;
  if (rule && !prefixPattern(rule).test(title))
    problems.push(`does not follow the prefix rule ${rule}`);
  return problems.length > 0
    ? fail(`title ${problems.join("; ")}`)
    : pass(`${title.length} characters`);
};

const imperativeVerbs = [
  "add", "allow", "build", "bump", "change", "clean", "create", "delete", "disable", "drop",
  "enable", "ensure", "extract", "fix", "handle", "implement", "improve", "introduce", "keep",
  "make", "merge", "move", "prevent", "refactor", "remove", "rename", "replace", "return", "run",
  "show", "simplify", "skip", "split", "stop", "support", "update", "use", "wrap", "write",
]; // prettier-ignore

const TITLE01_IMPERATIVE: Check = ({ title }) => {
  const word =
    title
      .replace(/^[^:]*:\s*/, "")
      .split(/\s+/)[0]
      ?.toLowerCase() ?? "";
  const inflected = imperativeVerbs.find((verb) =>
    [
      `${verb}ed`,
      `${verb}d`,
      `${verb}s`,
      `${verb}es`,
      `${verb}ing`,
      `${verb.slice(0, -1)}ies`,
    ].includes(word),
  );
  return inflected
    ? warn(`"${word}" is not imperative: use "${inflected}"`)
    : pass("title starts imperative or with a noun");
};

const ceilings = [3, 12, 40, 150];

const SIZE01: Check = ({ body, ledger, raise }) => {
  const { tier, reason } = tierOfLedger(ledger, raise);
  const count = unfenced(body).filter((line) => isProse(line.text)).length;
  return count > ceilings[tier]
    ? fail(`${count} prose lines, tier ${tier} allows ${ceilings[tier]} (${reason})`)
    : pass(`${count} prose lines, tier ${tier} allows ${ceilings[tier]}`);
};

const SIZE02: Check = ({ body, ledger, raise }) => {
  const { tier } = tierOfLedger(ledger, raise);
  if (tier !== 0) return skip(`tier ${tier} may have headings`);
  if (ledger.template !== null) return skip("the repo template names the headings");
  const heading = unfenced(body).find((line) => isHeading(line.text));
  return heading
    ? fail(`tier 0 has no headings: line ${heading.number} is "${heading.text.trim()}"`)
    : pass("no headings at tier 0");
};

const REF01: Check = ({ body, ledger }) => {
  const missing = ledger.trackerRefs.filter((ref) => !body.includes(ref));
  const contradicting = [...body.matchAll(/\b(?:Closes|Fixes|Resolves)\s+([A-Z][A-Z0-9]*-\d+)\b/g)]
    .map((match) => match[1])
    .filter((ref) => !ledger.trackerRefs.includes(ref));
  if (missing.length + contradicting.length === 0)
    return ledger.trackerRefs.length === 0 ? skip("no tracker refs") : pass("tracker refs named");
  return fail(
    [
      missing.length > 0 ? `the body does not name ${missing.join(", ")}` : "",
      contradicting.length > 0
        ? `the body closes ${contradicting.join(", ")}, the ledger holds ${ledger.trackerRefs.join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join("; "),
  );
};

/** `Depends on !1, !2.` gives `!1`, `!2`. */
function dependsRefs(body: string): string[] {
  return [...body.matchAll(/^[ \t]*Depends on[ \t]+(.*)$/gim)].flatMap((match) =>
    match[1]
      .replace(/\.(\s.*)?$/, "")
      .split(/,\s*(?:and\s+)?|\s+and\s+/)
      .map((ref) => ref.trim())
      .filter((ref) => ref !== ""),
  );
}

const REF02: Check = ({ body, ledger }) => {
  const wanted = ledger.repos.flatMap((repo) =>
    repo.dependsOn.map((line) => line.replace(/^Depends on\s+/i, "").trim()),
  );
  const stated = dependsRefs(body);
  const missing = wanted.filter((ref) => !stated.includes(ref));
  const contradicting = stated.filter((ref) => !wanted.includes(ref));
  const problems = [
    missing.length > 0 ? `no "Depends on" line for ${missing.join(", ")}` : "",
    contradicting.length > 0
      ? `"Depends on" names ${contradicting.join(", ")}, the ledger holds ${wanted.join(", ") || "none"}`
      : "",
  ].filter(Boolean);

  const order = ledger.mergeOrder;
  if (order.length > 1) {
    const line = body.split("\n").find((text) => /merge (order|after|first)/i.test(text));
    if (line === undefined)
      problems.push(`the body has no merge order line for ${order.join(", ")}`);
    else {
      const places = order.map((name) => line.indexOf(name));
      if (places.some((place) => place === -1))
        problems.push(
          `the merge order line misses ${order.filter((_, i) => places[i] === -1).join(", ")}`,
        );
      else if (places.some((place, i) => i > 0 && place < places[i - 1]))
        problems.push(
          `the merge order line says "${line.trim()}", the ledger holds ${order.join(", then ")}`,
        );
    }
  }
  if (problems.length > 0) return fail(problems.join("; "));
  return wanted.length === 0 && order.length < 2
    ? skip("no dependency or merge order")
    : pass("dependency and merge order refs match");
};

const VAL01: Check = ({ body }) => {
  const verify = sectionOf(body, /^How to verify\b/i) ?? sectionOf(body, /^Testing\b/i) ?? body;
  return /^\s*[-*] \[ \] /m.test(verify) ? pass("a `- [ ]` item") : fail("no `- [ ]` verify item");
};

const VAL02: Check = ({ body }) => {
  const verify = sectionOf(body, /^How to verify\b/i) ?? sectionOf(body, /^Testing\b/i) ?? body;
  const items = verify.split("\n").filter((line) => /^\s*[-*] \[ \] /.test(line));
  if (items.length === 0) return skip("no verify items");
  const bad = items.find((item) => !/`[^`]+`/.test(item) || !/\bExpect\b/i.test(item));
  return bad
    ? warn(`verify item has no backticked command or no Expect clause: ${bad.trim().slice(0, 80)}`)
    : pass("every verify item has a command and an Expect clause");
};

const VAL03: Check = ({ body, ledger }) => {
  const gaps = gapsOf(ledger);
  if (gaps.length === 0) return pass("the ledger has no gaps");
  const section = sectionOf(body, notDoneName);
  if (section === null)
    return fail(
      `the body has no Not done section for ${gaps.flatMap((gap) => gap.keys).join(", ")}`,
    );
  const lowered = section.toLowerCase();
  const unlisted = gaps
    .flatMap((gap) => gap.keys)
    .filter((key) => !lowered.includes(key.toLowerCase()));
  return unlisted.length > 0
    ? fail(`Not done does not list: ${unlisted.join(", ")}`)
    : pass(`Not done lists ${gaps.length} gaps`);
};

const filesOf = (ledger: Ledger) =>
  ledger.repos.flatMap((repo) => repo.files.map((file) => file.path));

const migrationFile = /(^|\/)(migrations?|migrate)\/|\.sql$/i;
const ciFile = /^\.github\/workflows\/|^\.gitlab-ci\.ya?ml$|(^|\/)\.circleci\/|(^|\/)Jenkinsfile$/;

const RISK02: Check = ({ body, ledger }) => {
  const flagged = filesOf(ledger).filter((path) => migrationFile.test(path));
  if (flagged.length === 0) return skip("no migration file in the diff");
  const named = body
    .split("\n")
    .some(
      (line) =>
        !/^\s*[-*]\s*Rollback cost/i.test(line) &&
        /migrat/i.test(line) &&
        /roll\s?back|revert|undo|down/i.test(line),
    );
  return named
    ? pass("the body names the migration rollback")
    : fail(
        `the diff has migration files (${flagged.join(", ")}) and the body names no rollback for them`,
      );
};

const RISK03: Check = ({ body, ledger }) => {
  const flagged = filesOf(ledger).filter((path) => ciFile.test(path));
  if (flagged.length === 0) return skip("no CI file in the diff");
  const unnoted = flagged.filter(
    (path) =>
      !body.includes(path) &&
      !body.includes(path.split("/").at(-1)!) &&
      !/\bCI\b.*\b(chang|touch|modif)/i.test(body),
  );
  return unnoted.length > 0
    ? fail(`the body does not note the CI file ${unnoted.join(", ")}`)
    : pass("the CI file change is noted");
};

/** What the body writes for a one-way door with no recovery named; the lint refuses it. */
export const noRecoveryText = "none named";
const noRecovery = new RegExp(`^(${noRecoveryText}|none|not named|tbd|unknown|n/a|-|\\s)*$`, "i");

const RISK04: Check = ({ body, ledger }) => {
  if (!ledger.hasReviewerStep) return skip("the run has no reviewer step");
  if (ledger.reviewer === null)
    return fail("the latest findings file of the reviewer step has no ## Merge risk block");
  const door = body.match(/^[ \t]*(?:[-*] )?Door: one-way(.*)$/m);
  if (door) {
    const recovery = door[1].match(/Recovery:\s*(.*)$/i)?.[1] ?? "";
    if (noRecovery.test(recovery.replace(/\.$/, "")))
      return fail("Door: one-way names no recovery (add `Recovery: <how>`)");
  }
  const start = body.search(/^[ \t]*(?:[-*] )?Also changed, not in plan:/m);
  if (start !== -1) {
    const [first, ...rest] = body.slice(start).split("\n");
    const inline = first.replace(/^.*?Also changed, not in plan:\s*/, "");
    const listed = [];
    for (const line of rest) {
      if (line.trim() === "" && listed.length === 0) continue;
      if (!isListItem(line)) break;
      listed.push(line);
    }
    const entries = /^(none\.?)?$/i.test(inline) ? listed : inline.split(/;\s*/);
    // `- \`file\`: reason` or `\`file\`: reason`: the reason is what follows the first colon after the path.
    const bare = entries.find((entry) => {
      const reason = entry.replace(/^\s*[-*]\s*/, "").replace(/^`[^`]*`:?\s*/, "");
      return reason.replace(/[().]/g, "").trim() === "" || /no reason given/i.test(entry);
    });
    if (bare) return fail(`an unplanned file has no reason: ${bare.trim().slice(0, 80)}`);
  }
  return pass("the reviewer block exists, the door and the unplanned files are explained");
};

const FMT01: Check = ({ body }) => {
  const paragraphs: { text: string; number: number }[][] = [];
  let current: { text: string; number: number }[] = [];
  for (const line of unfenced(body)) {
    if (isProse(line.text)) current.push(line);
    else {
      if (current.length > 0) paragraphs.push(current);
      current = [];
    }
  }
  if (current.length > 0) paragraphs.push(current);
  const wrapped = paragraphs.find(
    (paragraph) =>
      paragraph.length > 1 && paragraph.slice(0, -1).every((line) => line.text.length >= 60),
  );
  return wrapped
    ? fail(`hard-wrapped paragraph at line ${wrapped[0].number}: ${wrapped[0].text.slice(0, 60)}`)
    : pass("no hard-wrapped paragraph");
};

const FMT02: Check = ({ body }) => {
  const match = body.match(/\b(AKIA|ghp_|glpat-|xox)\w*|-----BEGIN/);
  return match
    ? fail(`the body has a token that starts with ${match[1] ?? match[0]}`)
    : pass("no known token prefix");
};

const STALE01: Check = ({ body, ledger, currentHeads, bodyHash }) => {
  if (currentHeads === undefined && bodyHash === undefined)
    return skip("no current head or body hash given");
  for (const repo of ledger.repos) {
    const now = currentHeads?.[repo.repo];
    if (now !== undefined && now !== repo.head)
      return fail(
        `the ledger head ${repo.head.slice(0, 7)} of ${repo.repo} differs from the current head ${now.slice(0, 7)}`,
      );
  }
  if (bodyHash !== undefined && bodyHash !== hashBody(body))
    return fail(
      `the body hash ${bodyHash.slice(0, 7)} differs from the linted body ${hashBody(body).slice(0, 7)}`,
    );
  return pass("ledger head and body hash are current");
};

const pathPattern =
  /(?<![\w./-])((?:[\w.-]+\/)+[\w.-]+\.(?:tsx?|jsx?|md|ya?ml|json|py|sh|css|sql))\b/g;

const DIFF01: Check = ({ body, ledger }) => {
  const files = filesOf(ledger);
  if (files.length === 0) return skip("the diff is empty or unknown");
  const stated = unfenced(body)
    .map((line) => line.text)
    .filter((line) => !/^\s*[-*] .*\bfindings\//.test(line));
  const skipped = /^(Evidence|How to verify|Testing|Not done|Risk|Acceptance)/i;
  const text: string[] = [];
  let skipping = false;
  for (const line of stated) {
    const title = line.match(/^#{1,6}\s+(.*?)\s*$/)?.[1] ?? line.match(/^\*\*([^*]+)\*\*\s*$/)?.[1];
    if (title !== undefined) skipping = skipped.test(title);
    if (!skipping) text.push(line);
  }
  const unsupported = [
    ...new Set([...text.join("\n").matchAll(pathPattern)].map((match) => match[1])),
  ]
    .filter((path) => !/^(findings|results|test|docs)\//.test(path))
    .filter(
      (path) =>
        !files.some(
          (file) => file === path || file.endsWith(`/${path}`) || path.endsWith(`/${file}`),
        ),
    );
  return unsupported.length > 0
    ? warn(`the body names ${unsupported.join(", ")}, which the diff does not change`)
    : pass("every file the body names is in the diff");
};

const EVID01: Check = ({ body, ledger }) => {
  const kind = ledger.ticket?.kind;
  if (kind !== "bug" && kind !== "perf" && kind !== "refactor")
    return skip(`kind ${kind ?? "unknown"} has no fixed evidence`);
  const evidence = sectionOf(body, evidenceName) ?? "";
  const fits =
    kind === "bug"
      ? /base\s+(fail|failing|red)/i.test(evidence) && /head\s+(pass|passing|green)/i.test(evidence)
      : kind === "refactor"
        ? /base\s+(pass|passing|green)/i.test(evidence) &&
          /head\s+(pass|passing|green)/i.test(evidence)
        : /baseline\.md/.test(evidence) && /compare\.md/.test(evidence);
  const needs = {
    bug: "fail at base and pass at head",
    refactor: "pass at base and at head",
    perf: "baseline.md and compare.md",
  }[kind];
  return fits
    ? pass(`evidence fits kind ${kind}`)
    : warn(`kind ${kind} needs evidence that shows ${needs}`);
};

const claim = /`?([A-Z][A-Z0-9]*-T\d+)`?:\s*base\s+(\S+?),\s*head\s+(\S+?)\s*@\s*`?([0-9a-f]+)`?/g;

const EVID03: Check = ({ body, ledger }) => {
  const claims = [...(sectionOf(body, evidenceName) ?? "").matchAll(claim)];
  if (claims.length === 0) return skip("the body claims no test case result");
  for (const [, id, , , sha] of claims) {
    const entry = ledger.evidence?.find((item) => item.testCase === id);
    if (!entry) return warn(`the body claims ${id}, and results/evidence/ has no folder for it`);
    if (entry.head === "missing")
      return warn(`the body claims ${id} at head, and its head result is missing`);
    if (!entry.sha.startsWith(sha) && !sha.startsWith(entry.sha))
      return warn(
        `the body claims ${id} at ${sha}, the head result is for ${entry.sha.slice(0, 7)}`,
      );
  }
  return pass("every evidence claim has a run artifact for its case and head");
};

const screenshotPath = /[^\s`,()]+\.(?:png|jpe?g|webp|gif)/gi;

const EVID04: Check = ({ body, ledger }) => {
  if (ledger.evidence === null) return skip("the run has no results/evidence/");
  const section = sectionOf(body, evidenceName);
  if (section === null)
    return fail("results/evidence/ exists and the body has no ## Evidence section");
  const shots = new Set(section.match(screenshotPath) ?? []);
  return shots.size > 5
    ? warn(`the Evidence section names ${shots.size} screenshots, 5 at most`)
    : pass(`Evidence section present, ${shots.size} screenshots named`);
};

const securityDiff =
  /^\+.*(process\.env\.\w*(TOKEN|SECRET|KEY|PASSWORD)\w*|Authorization|password|secret|crypto\.|eval\()/im;

const SEC01: Check = ({ body, diff }) => {
  if (diff === undefined) return skip("no diff text given");
  if (!securityDiff.test(diff)) return pass("the diff touches nothing security-relevant");
  return /\b(security|secret|credential|token)s?\b.*[.:]/i.test(
    body.replace(/^.*process\.env.*$/gim, ""),
  ) && /^\W*Security\b/im.test(body)
    ? pass("the body has a security note")
    : warn("the diff touches a token, credential or auth line and the body has no Security note");
};

const jargon =
  /\b(memoiz\w*|reducer|selector|invalidat\w*|shallow|callback|middleware|mutex|refactor\w*|hydrat\w*|serializ\w*)\b/gi;
const implementationVerb =
  /^(refactors?|adds?|implements?|replaces?|renames?|moves?|extracts?|introduces?|wraps?|updates?|changes?)\b/i;

const ELI01: Check = ({ body }) => {
  const section = sectionOf(body, /^(Problem|Summary|Overview|Description)\b/i);
  if (section === null) return skip("the body has no problem section");
  const text = sentences(section.trim().split(/\n\s*\n/)[0]);
  if (text === "") return skip("the problem section is empty");
  const terms = new Set((text.match(jargon) ?? []).map((term) => term.toLowerCase()));
  return implementationVerb.test(text) || terms.size >= 2
    ? warn(`the problem text describes the code, not the problem: ${text.slice(0, 80)}`)
    : pass("the problem text is in plain words");
};

const RISK01: Check = ({ body }) => {
  const scope = sectionOf(body, /^Risk\b/i) ?? body;
  if (!/\brisk\b/i.test(scope)) return warn("the body has no risk and revert text");
  return !/git revert/.test(body) || sentences(scope).split(" ").length < 8
    ? warn("the risk and revert text is too vague: name what breaks and the `git revert` step")
    : pass("risk and revert text present");
};

const checks: [string, Check][] = [
  ["PROV01", PROV01],
  ["PROV02", PROV02],
  ["TITLE01", TITLE01],
  ["TITLE01-imperative", TITLE01_IMPERATIVE],
  ["SIZE01", SIZE01],
  ["SIZE02", SIZE02],
  ["REF01", REF01],
  ["REF02", REF02],
  ["DIFF01", DIFF01],
  ["EVID01", EVID01],
  ["EVID03", EVID03],
  ["EVID04", EVID04],
  ["VAL01", VAL01],
  ["VAL02", VAL02],
  ["VAL03", VAL03],
  ["RISK01", RISK01],
  ["RISK02", RISK02],
  ["RISK03", RISK03],
  ["RISK04", RISK04],
  ["FMT01", FMT01],
  ["FMT02", FMT02],
  ["STALE01", STALE01],
  ["SEC01", SEC01],
  ["ELI01", ELI01],
];

export function lintBody(input: LintInput): LintResult[] {
  return checks.map(([id, check]) => ({ id, ...check(input) }));
}
