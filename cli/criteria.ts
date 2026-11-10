import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalCriterion } from "./criterion-id.ts";
import { ArkError } from "./errors.ts";
import { appendEvent, deriveState, readEvents } from "./events.ts";
import { findRun } from "./paths.ts";
import { assertAllowed } from "./transitions.ts";
import { isCaseId } from "./criterion-id.ts";
import { frontmatter, manualCriteria, runCriteria } from "./ticket.ts";
import { discoverRepos, mirrorRoot } from "./workspace.ts";

/** Replaces the `text:` line of one criterion in the frontmatter and its `| ID | ... |` table row.
 * YAML has no round trip in Bun, so only that one line and that one row change; a ticket with no
 * table row keeps only the frontmatter change. Returns the new ticket and the old frontmatter text.
 */
function rewriteTicket(
  ticket: string,
  criterionId: string,
  newText: string,
  ticketId: string,
): { ticket: string; oldText: string } {
  // The ticket may write the id in any of its forms: AC1, <ticket>-AC1 or <ticket>/AC1.
  const sameId = (written: string) => canonicalCriterion(written, ticketId) === criterionId;
  const lines = ticket.split("\n");
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end === -1)
    throw new ArkError("ticket.md has no frontmatter between --- lines");
  const idLine = lines.findIndex((line, i) => {
    const written = i < end ? line.match(/^\s*-\s*id:\s*["']?([^"'\s]+)["']?\s*$/)?.[1] : undefined;
    return written !== undefined && sameId(written);
  });
  if (idLine === -1) throw new ArkError(`ticket.md frontmatter has no criterion ${criterionId}`);
  let textLine = -1;
  for (let i = idLine + 1; i < end && !/^\s*-\s*id:/.test(lines[i]); i++)
    if (/^\s*text:/.test(lines[i])) textLine = i;
  if (textLine === -1) throw new ArkError(`criterion ${criterionId} has no text: line`);
  const [, indent, value] = lines[textLine].match(/^(\s*text:\s*)(.*)$/) as RegExpMatchArray;
  if (/^[|>]/.test(value))
    throw new ArkError(`criterion ${criterionId} uses a block scalar; put its text on one line`);
  const parsed = Bun.YAML.parse(lines[textLine].trim());
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("text" in parsed) ||
    typeof parsed.text !== "string"
  )
    throw new ArkError(`criterion ${criterionId} has a text: line that is not a string`);
  const oldText = parsed.text;
  lines[textLine] = `${indent}${JSON.stringify(newText)}`;
  const row = lines.findIndex(
    (line, i) => i > end && sameId(line.match(/^\|\s*([^|\s]+)\s*\|/)?.[1] ?? ""),
  );
  if (row !== -1) {
    const written = lines[row].match(/^\|\s*([^|\s]+)\s*\|/)?.[1];
    lines[row] = `| ${written} | ${newText.replaceAll("|", "\\|")} |`;
  }
  return { ticket: lines.join("\n"), oldText };
}

/** Replaces the `verified_by` of one criterion with an inline list. Handles an inline list (a trailing
 * comment goes, it described the old list), a block list and an absent key. Only those lines change.
 */
function rewriteVerifiedBy(
  ticket: string,
  criterionId: string,
  ids: string[],
  ticketId: string,
): string {
  const lines = ticket.split("\n");
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end === -1)
    throw new ArkError("ticket.md has no frontmatter between --- lines");
  const idLine = lines.findIndex((line, i) => {
    const written = i < end ? line.match(/^\s*-\s*id:\s*["']?([^"'\s]+)["']?\s*$/)?.[1] : undefined;
    return written !== undefined && canonicalCriterion(written, ticketId) === criterionId;
  });
  if (idLine === -1) throw new ArkError(`ticket.md frontmatter has no criterion ${criterionId}`);
  let last = idLine;
  let keyLine = -1;
  let textLine = -1;
  for (let i = idLine + 1; i < end && !/^\s*-\s*id:/.test(lines[i]); i++) {
    last = i;
    if (/^\s*verified_by:/.test(lines[i])) keyLine = i;
    if (/^\s*text:/.test(lines[i])) textLine = i;
  }
  const list = `[${ids.join(", ")}]`;
  if (keyLine === -1) {
    // Absent: add the key above text:, with the indent of the criterion's other keys.
    const at = textLine === -1 ? last + 1 : textLine;
    const indent = (lines[textLine === -1 ? last : textLine].match(/^\s*/) as RegExpMatchArray)[0];
    lines.splice(at, 0, `${indent}verified_by: ${list}`);
    return lines.join("\n");
  }
  const [, indent, value] = lines[keyLine].match(/^(\s*)verified_by:\s*(.*)$/) as RegExpMatchArray;
  let count = 1;
  if (value === "" || value.startsWith("#"))
    while (
      keyLine + count < end &&
      /^\s*-\s/.test(lines[keyLine + count]) &&
      (lines[keyLine + count].match(/^\s*/) as RegExpMatchArray)[0].length >= indent.length
    )
      count++;
  lines.splice(keyLine, count, `${indent}verified_by: ${list}`);
  return lines.join("\n");
}

/** Refuses an id with no active `test/cases/<id>.md` at HEAD of any repo of the run's worktree. */
function assertCasesAtHead(directory: string, ids: string[]): void {
  const workspace = mirrorRoot(directory);
  const repos = discoverRepos(workspace);
  for (const id of ids) {
    const active = repos.some((repo) => {
      const result = Bun.spawnSync(
        ["git", "-C", join(workspace, repo), "show", `HEAD:test/cases/${id}.md`],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      return (
        result.exitCode === 0 && frontmatter(result.stdout.toString()).fields?.status === "active"
      );
    });
    if (!active)
      throw new ArkError(
        `criteria.amended refused: test case ${id} has no active test/cases/${id}.md at HEAD of the run's worktree (commit the case file first)`,
      );
  }
}

type AmendOptions = {
  reason?: string;
  verifiedBy?: string;
  carryManual?: string;
  project?: string;
};

export function criteriaAmend(
  runId: string,
  criterionArgument: string,
  file: string | undefined,
  options: AmendOptions,
): void {
  const { reason, verifiedBy, carryManual, project } = options;
  const { directory } = findRun(runId, project);
  const state = deriveState(readEvents(directory));
  const ticketId = state.ticket.id;
  const criterionId = canonicalCriterion(criterionArgument, ticketId);
  // Refuse a wrong phase or an unknown criterion before reading the file.
  assertAllowed(state, "criteria.amended", { criterion: criterionId, reason }, directory);
  if ((file === undefined) === (verifiedBy === undefined))
    throw new ArkError(
      "criteria.amended refused: give either <file> (new text) or --verified-by <case ids>, not both and not neither",
    );
  const ticketFile = join(directory, "ticket.md");
  const closing = () => {
    if (state.phase === "planning" || state.phase === "awaiting_strategy") {
      if (existsSync(join(directory, "plan.md")))
        console.log(
          `plan.md may be stale: run \`ark plan check ${runId}\` again to list this amendment`,
        );
    } else
      console.log(
        "the plan is approved: do not run ark plan check again, it can change the plan hash and reset the approval",
      );
  };
  if (verifiedBy !== undefined) {
    if (carryManual !== undefined)
      throw new ArkError(
        "criteria.amended refused: --carry-manual works with the text form only (a --verified-by amend keeps manual answers anyway)",
      );
    const ids = verifiedBy.split(",").map((id) => id.trim());
    const bad = ids.find((id) => !isCaseId(id));
    if (bad !== undefined)
      throw new ArkError(
        `criteria.amended refused: ${bad === "" ? "empty entry" : bad} in --verified-by is not a test case id like ARK-T12 (comma separated, no empty entry)`,
      );
    const repeated = ids.find((id, i) => ids.indexOf(id) !== i);
    if (repeated !== undefined)
      throw new ArkError(`criteria.amended refused: ${repeated} is listed twice in --verified-by`);
    assertCasesAtHead(directory, ids);
    const oldIds = runCriteria(directory).find((c) => c.id === criterionId)?.verified_by ?? [];
    const ticket = rewriteVerifiedBy(readFileSync(ticketFile, "utf8"), criterionId, ids, ticketId);
    // The event goes first: it re-checks the phase, and a refusal must leave ticket.md untouched.
    appendEvent(directory, "criteria.amended", {
      criterion: criterionId,
      verified_by_old: oldIds,
      verified_by_new: ids,
      by: "human",
      reason: reason?.trim(),
    });
    writeFileSync(ticketFile, ticket);
    console.log(
      `amended ${criterionId} verified_by: [${oldIds.join(", ")}] -> [${ids.join(", ")}]; recorded criteria.amended`,
    );
    closing();
    return;
  }
  if (!existsSync(file as string))
    throw new ArkError(`criteria.amended refused: ${file} not found`);
  const newText = readFileSync(file as string, "utf8")
    .trim()
    .replace(/\s*\n\s*/g, " ");
  if (newText === "")
    throw new ArkError(
      `criteria.amended refused: ${file} is empty; the new criterion text is required`,
    );
  if (carryManual !== undefined) {
    if (carryManual.trim() === "")
      throw new ArkError(
        "criteria.amended refused: --carry-manual needs the human's words, not an empty value",
      );
    if (!manualCriteria(directory).includes(criterionId))
      throw new ArkError(
        `criteria.amended refused: --carry-manual needs a manual criterion; ${criterionId} is proved by a test`,
      );
  }
  const { ticket, oldText } = rewriteTicket(
    readFileSync(ticketFile, "utf8"),
    criterionId,
    newText,
    ticketId,
  );
  appendEvent(directory, "criteria.amended", {
    criterion: criterionId,
    old: oldText,
    new: newText,
    by: "human",
    reason: reason?.trim(),
    ...(carryManual !== undefined && { carry_manual: carryManual.trim() }),
  });
  writeFileSync(ticketFile, ticket);
  console.log(
    `amended ${criterionId} in ticket.md (frontmatter and table); recorded criteria.amended`,
  );
  console.log(`  old: ${oldText}`);
  console.log(`  new: ${newText}`);
  if (carryManual !== undefined) console.log(`  manual answer kept: ${carryManual.trim()}`);
  closing();
}
