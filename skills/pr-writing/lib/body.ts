/**
 * `buildBody(ledger)` writes the MR body from the ledger.
 * It never pastes an AC text. All generated text sits between the two markers; `post.ts` replaces only that.
 */
import type { Ledger, Rating } from "./ledger.ts";
import { gapsOf, noRecoveryText, shortId, tierOfLedger } from "./lint.ts";

export const beginMarker = "<!-- pr-writing:begin -->";
export const endMarker = "<!-- pr-writing:end -->";

type Key = "problem" | "different" | "evidence" | "verify" | "notdone" | "risk" | "acs";
type Block = { key: Key; title: string; lines: string[] };

const ratingOf = (score: number): Rating => (["good", "decent", "poor"] as const)[score - 1];

/** `> Written by an AI agent on behalf of @handle, ...` : the strategy gate beats the criteria gate. */
export function provenanceLine(ledger: Ledger): string {
  const handle = ledger.tokenOwner;
  const shape = ledger.humanGates.includes("strategy")
    ? ", who shaped the solution."
    : ledger.humanGates.includes("criteria")
      ? ", following their spec."
      : ".";
  return `> Written by an AI agent on behalf of @${handle}${shape} @${handle} has not reviewed it yet.`;
}

function duration(startedAt: string, endedAt: string): string | null {
  const minutes = Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

function introLines(ledger: Ledger, tier: number): string[] {
  const facts = [`Refs: ${ledger.trackerRefs.join(", ") || "none"}.`];
  const took = ledger.run && duration(ledger.run.startedAt, ledger.run.endedAt);
  if (tier > 0 && ledger.run && took)
    facts.push(
      `Run took ${took}, ${ledger.run.rounds} round${ledger.run.rounds === 1 ? "" : "s"}.`,
    );
  if (tier > 0)
    for (const repo of ledger.repos)
      if (repo.shortstat !== "unknown") facts.push(`${repo.shortstat.trim()}.`);
  const dependencies = [
    ...new Set(
      ledger.repos.flatMap((repo) =>
        repo.dependsOn.map((line) => line.replace(/^Depends on\s+/i, "")),
      ),
    ),
  ];
  return [
    facts.join(" "),
    ...(dependencies.length > 0 ? [`Depends on ${dependencies.join(", ")}.`] : []),
    ...(ledger.mergeOrder.length > 1 ? [`Merge order: ${ledger.mergeOrder.join(", then ")}.`] : []),
  ];
}

/** The first paragraph of text, on one line, cut at a sentence end when it is long. */
function firstParagraph(text: string, limit = 500): string {
  const paragraph = (text.trim().split(/\n\s*\n/)[0] ?? "").replace(/\s+/g, " ").trim();
  if (paragraph.length <= limit) return paragraph;
  const cut = paragraph.slice(0, limit);
  const end = cut.lastIndexOf(". ");
  return end > 0 ? cut.slice(0, end + 1) : `${cut.trimEnd()}...`;
}

function problemBlock(ledger: Ledger): Block {
  const commit = ledger.repos[0]?.commits.at(-1);
  const text =
    ledger.ticket?.problem ||
    ledger.plan?.why ||
    (commit && commit.message.split("\n").slice(1).join("\n").trim()) ||
    commit?.subject ||
    "";
  return {
    key: "problem",
    title: "Problem",
    lines: [firstParagraph(text) || "No problem text in the ticket or the plan."],
  };
}

function differentBlock(ledger: Ledger): Block {
  // Only the list items of the Change text before its `Risks:` label, at the shallowest indent, each cut at its first sentence end.
  const change = (ledger.ticket?.change ?? "").split(/^\s*risks?\s*:\s*$/im)[0];
  const listed = change
    .split("\n")
    .map((line) => line.match(/^(\s*)(?:\d+\.|[-*])\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => match !== null);
  const indent = Math.min(...listed.map((match) => match[1].length));
  const items = listed
    .filter((match) => match[1].length === indent)
    .map((match) => match[2].replace(/\s+/g, " ").match(/^.*?(?:\.(?=\s)|$)/)![0])
    .filter((item) => !item.endsWith(":")); // a lead-in to a nested list
  const subjects = ledger.repos.flatMap((repo) => repo.commits.map((commit) => commit.subject));
  const lines = (items.length > 0 ? items : subjects).slice(0, 6).map((item) => `- ${item}`);
  return {
    key: "different",
    title: "What is different",
    lines: lines.length > 0 ? lines : ["- No change text and no commits."],
  };
}

const shortSha = (sha: string) => sha.slice(0, 7);

/** The flow of a screenshot path: `login-1.png` and `login-2.png` are the flow `login`. */
const flowOf = (path: string) =>
  path
    .split("/")
    .at(-1)!
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]\d+$/, "");

/** The evidence entries the body shows: the plan's test cases, or every entry when the ledger has no plan cases. `ledger.evidence` stays complete for the lint checks. */
const shownEvidence = (ledger: Ledger) =>
  (ledger.evidence ?? []).filter(
    (entry) => ledger.planCases === undefined || ledger.planCases.includes(entry.testCase),
  );

/** One screenshot for each flow of a test case and side (`login-1.png` and `login-2.png` are one flow), five at most; `omitted` counts the flows cut. */
function screenshotFlows(ledger: Ledger): { shown: string[]; omitted: number } {
  const paths = [...new Set(shownEvidence(ledger).flatMap((entry) => entry.screenshots))].sort();
  // The directory holds the test case and the side, so equal file names in two cases stay apart.
  const flows = new Map<string, { flow: string; path: string }>();
  for (const path of paths) {
    const key = `${path.slice(0, path.lastIndexOf("/"))}/${flowOf(path)}`;
    if (!flows.has(key)) flows.set(key, { flow: flowOf(path), path });
  }
  const ordered = [...flows.values()].sort(
    (a, b) => a.flow.localeCompare(b.flow) || a.path.localeCompare(b.path),
  );
  return {
    shown: ordered.slice(0, 5).map(({ path }) => path),
    omitted: Math.max(0, ordered.length - 5),
  };
}

/** A test title as literal Markdown text: one line, with the characters that format or break a table escaped. */
const escapeTitle = (title: string) =>
  title.replace(/\s+/g, " ").replace(/[\\`*_[\]<>|~#]/g, "\\$&");

/** The Tests line and one Deleted bullet for each deleted test, sorted by file then title; none for an old run. */
function testLines({ tests }: Ledger): string[] {
  if (tests === null) return [];
  const { passed, skipped, baseSkipped, deleted } = tests;
  if (baseSkipped === undefined || deleted === undefined)
    return [`- Tests: ${passed} passed, ${skipped} skipped (no base count, deleted not counted)`];
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [
    `- Tests: ${passed} passed, ${skipped} skipped (base ${baseSkipped}), ${deleted.length} deleted`,
    ...[...deleted]
      .sort((a, b) => order(a.file ?? "", b.file ?? "") || order(a.name, b.name))
      .map(
        ({ file, name }) =>
          `  - Deleted: ${file === undefined ? "" : `\`${file}\` `}${escapeTitle(name)}`,
      ),
  ];
}

/** A log line that looks like it holds a credential is dropped, never posted. This is the only secret scan of a body. */
const secretLike =
  /token|secret|passw(or)?d|api[_-]?key|private[ _-]?key|credential|bearer|authorization|\b\w*(key|secret|credential)\w*\s*[=:]|\b(ghp|gho|ghs|github_pat|glpat|xox[bap]|sk)[-_][\w-]{8,}|AKIA[0-9A-Z]{12,}/i;

/** Drops private-key blocks, also one whose BEGIN or END line is outside the lines given (a tail cut inside a block). */
function withoutPrivateKeys(textLines: string[]): string[] {
  const begin = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
  const end = /-----END [A-Z ]*PRIVATE KEY-----/;
  const firstBegin = textLines.findIndex((line) => begin.test(line));
  const firstEnd = textLines.findIndex((line) => end.test(line));
  // An END before any BEGIN: the lines start inside a block.
  let inside = firstEnd >= 0 && (firstBegin < 0 || firstEnd < firstBegin);
  const kept: string[] = [];
  for (const line of textLines) {
    if (begin.test(line)) inside = true;
    if (!inside) kept.push(line);
    if (end.test(line)) inside = false;
  }
  return kept;
}

/** Log or AC text as a fenced block that no line of it can close or leave. */
function fenced(textLines: string[]): string[] {
  const safeLines = withoutPrivateKeys(textLines)
    .filter((line) => !secretLike.test(line))
    .map((line) => line.replace(/`{3,}|~{3,}/g, "'''").replace(/<\/details/gi, "<\\/details"));
  return safeLines.length === 0 ? [] : ["```", ...safeLines, "```", ""];
}

/** One collapsed block. The visible summary holds the id and the result (EVID01 and EVID03 read it); the rest is Markdown. */
const details = (summary: string, inner: string[]) => [
  `<details><summary>${summary}</summary>`,
  "",
  ...inner,
  "</details>",
  "",
];

const logLines = 20;

/** `keep` is how many of the last log lines each case block holds. */
function evidenceBlock(ledger: Ledger, keep = logLines): Block {
  const kind = ledger.ticket?.kind;
  const { shown, omitted } = screenshotFlows(ledger);
  const lines: string[] = [];
  let leftOut = 0;
  for (const entry of shownEvidence(ledger)) {
    const prefix = `results/evidence/${entry.testCase}/`;
    const result = `base ${entry.base}, head ${entry.head} @ ${shortSha(entry.sha) || "unknown"}`;
    const pictures = shown.filter((path) => path.startsWith(prefix));
    const logTail = (entry.log ?? []).slice(-keep);
    leftOut += (entry.log ?? []).length - logTail.length;
    const log = fenced(logTail);
    lines.push(
      ...details(`\`${entry.testCase}\`: ${result}`, [
        `Result: ${result}`,
        "",
        ...(pictures.length === 0
          ? []
          : [
              "Screenshots:",
              "",
              ...pictures.flatMap((path) => {
                const side = path.slice(prefix.length).split("/")[0];
                const flow = escapeTitle(flowOf(path));
                const name = escapeTitle(
                  path
                    .split("/")
                    .at(-1)!
                    .replace(/\.[^.]+$/, ""),
                );
                return [
                  // A path with a space or a parenthesis goes in angle brackets; post.ts reads both forms.
                  `![${entry.testCase} ${side} ${flow}](${/[\s()<>]/.test(path) ? `<${path}>` : path})`,
                  "",
                  `${entry.testCase} ${side}, flow ${flow}: ${name}`,
                  "",
                ];
              }),
            ]),
        ...(log.length === 0 ? [] : ["Log (last 20 lines of the head command.log):", "", ...log]),
      ]),
    );
  }
  if (leftOut > 0)
    lines.push(
      `- Log tails: ${leftOut.toLocaleString("en-US")} log lines left out so the body fits GitHub's ${githubBodyLimit.toLocaleString("en-US")}-character limit.`,
    );
  if (omitted > 0)
    lines.push(`- Screenshots: ${omitted} more flow(s) left out, five are shown at most.`);
  for (const { id, text } of ledger.acEvidence ?? []) {
    const body = fenced(text.split("\n"));
    lines.push(
      ...details(`\`${id}\`: evidence`, [`Evidence file results/evidence/${id}.md:`, "", ...body]),
    );
  }
  if (kind === "perf")
    lines.push(
      "- Perf: `results/baseline.md` and `results/compare.md` in the run folder, not uploaded.",
    );
  if (ledger.evidence === null && kind !== "perf")
    lines.push("- No base and head evidence recorded: the run has no `results/evidence/`.");
  lines.push(...testLines(ledger));
  for (const { suite, file } of ledger.flaky)
    lines.push(`- Flaky: \`${file}\` in suite \`${suite}\` failed once and passed on retry.`);
  return { key: "evidence", title: "Evidence", lines };
}

function verifyBlock(ledger: Ledger): Block {
  const head = shortSha(ledger.repos[0]?.head ?? "");
  const lines: string[] = [];
  if (ledger.run) {
    const checks = ledger.checks.map((check) => check.name);
    lines.push(
      `- [ ] \`ark test ${ledger.run.id}\`. Expect: every AC passing at head ${head}${checks.length > 0 ? ` and the checks ${checks.join(", ")} passing` : ""}.`,
    );
    if (ledger.ticket?.kind === "perf")
      lines.push(
        "- [ ] `cat results/compare.md`. Expect: no result slower than `results/baseline.md`.",
      );
  } else
    for (const repo of ledger.repos)
      lines.push(`- [ ] \`git diff ${repo.base}...HEAD --stat\`. Expect: ${repo.shortstat}.`);
  return { key: "verify", title: "How to verify", lines };
}

function notDoneBlock(ledger: Ledger): Block {
  const gaps = gapsOf(ledger);
  return {
    key: "notdone",
    title: "Not done",
    lines: gaps.length > 0 ? gaps.map((gap) => `- ${gap.text}.`) : ["- Nothing open."],
  };
}

function riskBlock(ledger: Ledger, tier: number): Block {
  const { risk, reviewer } = ledger;
  const caller = (ledger.plan?.interfaces ?? [])
    .filter((entry) => entry.callers.length > 0)
    .map((entry) => entry.name.split(" (")[0]);
  const unproven = ledger.criteria.filter(
    (criterion) => criterion.status !== "passing" && criterion.status !== "manual ok",
  );
  const unevidenced = ledger.criteria.filter(
    (criterion) => criterion.evidenced === false && !unproven.includes(criterion),
  );
  const gap = (items: string[], none: string) => {
    const text = items.length > 0 ? items.join("; ") : none;
    return text[0].toUpperCase() + text.slice(1);
  };
  const rows: [string, number, string, Rating | undefined][] = [
    [
      "Verification",
      risk.verification,
      gap(
        [
          ...[...new Set(unproven.map((criterion) => criterion.status))].map(
            (status) =>
              `${unproven
                .filter((criterion) => criterion.status === status)
                .map((criterion) => shortId(criterion.id))
                .join(" ")} ${status}`,
          ),
          ...(unevidenced.length > 0
            ? [
                `${unevidenced.map((criterion) => shortId(criterion.id)).join(" ")} have no evidence`,
              ]
            : []),
        ],
        "all ACs pass with evidence",
      ),
      reviewer?.ratings.Verification,
    ],
    [
      "Alignment",
      risk.alignment,
      gap(
        risk.unplanned.length > 0
          ? [`${risk.unplanned.length} source file(s) outside the plan`]
          : [],
        "every changed file is in the plan",
      ),
      reviewer?.ratings.Alignment,
    ],
    [
      "Impact",
      risk.impact,
      gap(
        [
          ...(risk.sensitiveHits.length > 0
            ? [`touches ${risk.sensitiveHits.map((path) => `\`${path}\``).join(", ")}`]
            : []),
          ...(caller.length > 0 ? [`callers of ${caller.join(", ")}`] : []),
        ],
        "no sensitive path and no interface callers",
      ),
      reviewer?.ratings.Impact,
    ],
    [
      "Rollback cost",
      risk.rollback,
      gap(
        [
          ...(risk.oneWayHits.length > 0
            ? [`one-way path ${risk.oneWayHits.map((path) => `\`${path}\``).join(", ")}`]
            : []),
          ...(risk.deleted.length > 0
            ? [`deleted ${risk.deleted.map((path) => `\`${path}\``).join(", ")}`]
            : []),
        ],
        "no one-way path and no deleted file",
      ),
      reviewer?.ratings["Rollback cost"],
    ],
  ];
  const differs = risk.reviewer !== null && risk.reviewer !== risk.script;
  const scores = `${risk.verification}/${risk.alignment}/${risk.impact}/${risk.rollback}`;
  const why = differs
    ? ` The levels differ: the script scored Verification, Alignment, Impact and Rollback cost ${scores} from run data, the reviewer rated them ${["Verification", "Alignment", "Impact", "Rollback cost"].map((name) => reviewer?.ratings[name as "Verification"] ?? "?").join(", ")}. The higher level is shown.`
    : "";
  const oneWay = risk.door === "one-way" || reviewer?.door === "one-way";
  const recovery = reviewer?.recovery.trim() || noRecoveryText;
  const unplanned = new Map(risk.unplanned.map((entry) => [entry.file, entry.reason]));
  const door = oneWay ? `Door: one-way. Recovery: ${recovery}` : "Door: two-way";
  const blast = `Blast radius: ${reviewer?.blastRadius || `${ledger.repos.reduce((sum, repo) => sum + repo.files.length, 0)} changed files in ${ledger.repos.length} repo(s)`}`;
  const compact = tier === 0;
  const lines = [
    `Merge risk: ${risk.level} (script ${risk.script}, reviewer ${risk.reviewer ?? "none"}).${why}`,
    "",
    ...rows.map(
      ([name, score, gaps, rated]) =>
        `- ${name}: ${ratingOf(score)}${rated && rated !== ratingOf(score) ? ` (reviewer: ${rated})` : ""}. ${gaps}.`,
    ),
    "",
    ...(compact ? [`- ${door}.`, `- ${blast}.`] : [`${door}`, "", `${blast}`]),
    "",
    ...(unplanned.size === 0
      ? [compact ? "- Also changed, not in plan: none." : "Also changed, not in plan: none."]
      : compact
        ? [
            `- Also changed, not in plan: ${[...unplanned].map(([file, reason]) => `\`${file}\`: ${reason}`).join("; ")}`,
          ]
        : [
            "Also changed, not in plan:",
            "",
            ...[...unplanned].map(([file, reason]) => `- \`${file}\`: ${reason}`),
          ]),
  ];
  const migration = ledger.repos
    .flatMap((repo) => repo.files)
    .filter((file) => /(^|\/)(migrations?|migrate)\/|\.sql$/i.test(file.path));
  if (migration.length > 0)
    lines.push(
      "",
      `Migration files changed (${migration.map((file) => `\`${file.path}\``).join(", ")}). Migration rollback: revert the merge, then undo the migration by hand; no down script is recorded.`,
    );
  const ci = ledger.repos
    .flatMap((repo) => repo.files)
    .filter((file) =>
      /^\.github\/workflows\/|^\.gitlab-ci\.ya?ml$|(^|\/)\.circleci\/|(^|\/)Jenkinsfile$/.test(
        file.path,
      ),
    );
  if (ci.length > 0)
    lines.push(
      "",
      `CI files changed (${ci.map((file) => `\`${file.path}\``).join(", ")}): the pipeline on this MR runs the new definition.`,
    );
  const only = ledger.mergeOrder.length < 2;
  lines.push(
    "",
    "```text",
    "# Revert, newest merge first",
    ...[...ledger.mergeOrder]
      .reverse()
      .map((repo) => `git revert -m 1 <merge sha of the MR for ${only ? "this repo" : repo}>`),
    "```",
  );
  return { key: "risk", title: "Risk and revert", lines };
}

function acsBlock(ledger: Ledger): Block {
  const byStatus = new Map<string, string[]>();
  for (const criterion of ledger.criteria) {
    const status = criterion.status === "passing" ? "tested" : criterion.status;
    byStatus.set(status, [...(byStatus.get(status) ?? []), shortId(criterion.id)]);
  }
  return {
    key: "acs",
    title: "Acceptance criteria",
    lines: [...byStatus].map(
      ([status, ids]) =>
        `- [${status === "tested" || status === "manual ok" ? "x" : " "}] ${ids.join(" ")} ${status}`,
    ),
  };
}

// --- template ---------------------------------------------------------------------------------

type Heading = { level: number; text: string };

/** Headings of a repo template, or of the template inside a fence in a rule file; bold bullets when it has none. */
function templateHeadings(text: string): Heading[] {
  const read = (source: string): Heading[] =>
    [...source.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gm)].map((match) => ({
      level: match[1].length,
      text: match[2].replace(/:$/, ""),
    }));
  const fenced = [...text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)]
    .map((match) => read(match[1]))
    .find((found) => found.length > 1);
  let headings = fenced ?? read(text);
  const shallowest = Math.min(...headings.map((heading) => heading.level));
  if (
    !fenced &&
    headings.length > 1 &&
    headings.filter((heading) => heading.level === shallowest).length === 1
  )
    headings = headings.filter((heading) => heading.level !== shallowest);
  if (headings.length === 0)
    headings = [...text.matchAll(/^\s*[-*]\s+\*\*(.+?)\*\*/gm)].map((match) => ({
      level: 2,
      text: match[1].replace(/:$/, ""),
    }));
  return headings;
}

const headingRules: Record<Key, RegExp> = {
  problem: /summary|overview|description|problem|why|context|purpose|motivation/i,
  different: /change|different|solution|approach|what/i,
  evidence: /test|verif|evidence|validation|qa/i,
  verify: /test|verif|evidence|validation|qa/i,
  notdone: /test|verif|evidence|validation|qa/i,
  risk: /related|link|ticket|issue|depend|risk|rollout|deploy|revert/i,
  acs: /related|link|ticket|issue|depend|risk|rollout|deploy|revert/i,
};

function renderBlocks(blocks: Block[], template: Heading[] | null, bare: boolean): string[] {
  if (template === null || template.length === 0) {
    const title = (block: Block) => (bare ? `**${block.title}**` : `## ${block.title}`);
    return blocks.flatMap((block) => ["", title(block), "", ...block.lines]);
  }
  // A key goes under the first template heading that fits; `different` shares the problem's heading when none fits.
  const placed = new Map<Heading, Block[]>();
  const loose: Block[] = [];
  for (const block of blocks) {
    const heading =
      template.find((candidate) => headingRules[block.key].test(candidate.text)) ??
      (block.key === "different"
        ? template.find((candidate) => headingRules.problem.test(candidate.text))
        : undefined);
    if (heading) placed.set(heading, [...(placed.get(heading) ?? []), block]);
    else loose.push(block);
  }
  const lines: string[] = [];
  for (const heading of template) {
    const owned = placed.get(heading);
    if (!owned) continue;
    lines.push("", `${"#".repeat(heading.level)} ${heading.text}`);
    owned.forEach((block, i) =>
      lines.push(
        "",
        ...(i === 0 && (block.key === "problem" || block.key === "different")
          ? []
          : [`### ${block.title}`, ""]),
        ...block.lines,
      ),
    );
  }
  for (const block of loose) lines.push("", `## ${block.title}`, "", ...block.lines);
  return lines;
}

/** The body length GitHub accepts. */
export const githubBodyLimit = 65_536;

/** The body, with the log tails of the case blocks cut when it is over `githubBodyLimit`: the most lines each block keeps that fit, down to none. The AC evidence blocks and the result lines stay whole. */
export function buildBody(ledger: Ledger): string {
  const body = buildBodyKeeping(ledger, logLines);
  if (body.length <= githubBodyLimit) return body;
  // ponytail: binary search on one per-case line count; per-case weighting if blocks differ a lot.
  let low = 0;
  let high = logLines - 1;
  let best = buildBodyKeeping(ledger, 0);
  while (low <= high) {
    const middle = (low + high) >> 1;
    const attempt = buildBodyKeeping(ledger, middle);
    if (attempt.length <= githubBodyLimit) {
      best = attempt;
      low = middle + 1;
    } else high = middle - 1;
  }
  return best;
}

function buildBodyKeeping(ledger: Ledger, keep: number): string {
  const { tier } = tierOfLedger(ledger);
  const blocks: Block[] = [problemBlock(ledger), differentBlock(ledger)];
  if (ledger.source === "run") blocks.push(evidenceBlock(ledger, keep));
  blocks.push(verifyBlock(ledger), notDoneBlock(ledger), riskBlock(ledger, tier));
  if (ledger.ticket) blocks.push(acsBlock(ledger));
  const intro = [
    ...(ledger.prWriting.agent_authored ? [provenanceLine(ledger), ""] : []),
    ...introLines(ledger, tier).flatMap((line) => [line, ""]),
  ];
  const body = [
    beginMarker,
    ...intro,
    ...renderBlocks(
      blocks,
      ledger.template ? templateHeadings(ledger.template.text) : null,
      tier === 0,
    ),
    "",
    endMarker,
  ];
  return `${body.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}
