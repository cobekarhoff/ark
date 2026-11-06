import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalCriterion } from "./criterion-id.ts";
import { ArkError } from "./errors.ts";
import { appendEvent, deriveState, readEvents } from "./events.ts";
import { findRun } from "./paths.ts";
import { assertAllowed } from "./transitions.ts";

export const methods = ["test", "demonstration", "inspection", "analysis"] as const;
export type Method = (typeof methods)[number];

export type TicketCriterion = {
  /** `<ticket id>/AC<k>`. */
  id: string;
  method: Method;
  verified_by: string[];
  /** The ticket gives `verified_by` or writes a local id (`AC1`): the human approves its test cases at the criteria gate. */
  newScheme: boolean;
};

/**
 * Reads `acceptance_criteria` from the parsed ticket frontmatter. `source` names the file in refusals.
 * A missing `method` is `test`, and `manual: true` reads as `demonstration`. Ids come back as `<ticket id>/AC<k>`.
 */
export function parseCriteria(fields: Record<string, unknown>, source: string): TicketCriterion[] {
  const list = fields.acceptance_criteria ?? [];
  if (!Array.isArray(list)) throw new ArkError(`${source}: acceptance_criteria must be a list`);
  const seen = new Set<string>();
  return list.map((entry, i) => {
    if (typeof entry?.id !== "string" || typeof entry?.text !== "string")
      throw new ArkError(`${source}: acceptance_criteria[${i}] needs id and text`);
    const id = canonicalCriterion(entry.id, typeof fields.id === "string" ? fields.id : "");
    if (seen.has(id)) throw new ArkError(`${source}: duplicate criterion id ${id}`);
    seen.add(id);
    const method = entry.method ?? (entry.manual === true ? "demonstration" : "test");
    if (!(methods as readonly unknown[]).includes(method))
      throw new ArkError(
        `${source}: criterion ${id} has method ${JSON.stringify(method)}: use ${methods.join(", ")}`,
      );
    const verified = entry.verified_by;
    if (
      verified !== undefined &&
      (!Array.isArray(verified) || !verified.every((item) => typeof item === "string"))
    )
      throw new ArkError(`${source}: criterion ${id} verified_by must be a list of strings`);
    return {
      id,
      method,
      verified_by: verified ?? [],
      newScheme: verified !== undefined || /^AC\d+$|\/AC\d+$/.test(entry.id),
    };
  });
}

function frontmatterOf(file: string): Record<string, unknown> {
  const match = readFileSync(file, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? ((Bun.YAML.parse(match[1]) ?? {}) as Record<string, unknown>) : {};
}

/** The criteria of the run folder's ticket.md, with method and verified_by. */
export function runCriteria(runDirectory: string): TicketCriterion[] {
  const file = join(runDirectory, "ticket.md");
  return existsSync(file) ? parseCriteria(frontmatterOf(file), file) : [];
}

/** Ids of the criteria whose method is not `test` (`manual: true` included). A person proves them with the `manual` gate. */
export function manualCriteria(runDirectory: string): string[] {
  return runCriteria(runDirectory)
    .filter((criterion) => criterion.method !== "test")
    .map((criterion) => criterion.id);
}

/** The evidence file of a criterion that no test proves: `results/evidence/AC<k>.md` in the run folder. */
export function evidenceFile(runDirectory: string, criterionId: string): string {
  return join(runDirectory, "results", "evidence", `${criterionId.split("/").pop()}.md`);
}

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

export function criteriaAmend(
  runId: string,
  criterionArgument: string,
  file: string,
  reason: string | undefined,
  inProject?: string,
): void {
  const { directory } = findRun(runId, inProject);
  const ticketId = deriveState(readEvents(directory)).ticket.id;
  const criterionId = canonicalCriterion(criterionArgument, ticketId);
  // Refuse a wrong phase or an unknown criterion before reading the file.
  assertAllowed(deriveState(readEvents(directory)), "criteria.amended", {
    criterion: criterionId,
    reason,
  });
  if (!existsSync(file)) throw new ArkError(`criteria.amended refused: ${file} not found`);
  const newText = readFileSync(file, "utf8")
    .trim()
    .replace(/\s*\n\s*/g, " ");
  if (newText === "")
    throw new ArkError(
      `criteria.amended refused: ${file} is empty; the new criterion text is required`,
    );
  const ticketFile = join(directory, "ticket.md");
  const { ticket, oldText } = rewriteTicket(
    readFileSync(ticketFile, "utf8"),
    criterionId,
    newText,
    ticketId,
  );
  // The event goes first: it re-checks the phase, and a refusal must leave ticket.md untouched.
  appendEvent(directory, "criteria.amended", {
    criterion: criterionId,
    old: oldText,
    new: newText,
    by: "human",
    reason: reason?.trim(),
  });
  writeFileSync(ticketFile, ticket);
  console.log(
    `amended ${criterionId} in ticket.md (frontmatter and table); recorded criteria.amended`,
  );
  console.log(`  old: ${oldText}`);
  console.log(`  new: ${newText}`);
  const phase = deriveState(readEvents(directory)).phase;
  if (phase === "planning" || phase === "awaiting_strategy") {
    if (existsSync(join(directory, "plan.md")))
      console.log(
        `plan.md may be stale: run \`ark plan check ${runId}\` again to list this amendment`,
      );
  } else
    console.log(
      "the plan is approved: do not run ark plan check again, it can change the plan hash and reset the approval",
    );
}
