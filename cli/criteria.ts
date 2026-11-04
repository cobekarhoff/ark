import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ArkError } from "./errors.ts";
import { appendEvent, deriveState, readEvents } from "./events.ts";
import { findRun } from "./paths.ts";
import { assertAllowed } from "./transitions.ts";

/** Ids of the criteria with `manual: true` in the run folder's ticket.md. A person proves them with the `manual` gate. */
export function manualCriteria(runDirectory: string): string[] {
  const file = join(runDirectory, "ticket.md");
  const match = existsSync(file)
    ? readFileSync(file, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)
    : null;
  const criteria = match
    ? (Bun.YAML.parse(match[1]) as { acceptance_criteria?: { id?: unknown; manual?: unknown }[] })
        ?.acceptance_criteria
    : undefined;
  return (criteria ?? [])
    .filter((criterion) => criterion?.manual === true)
    .map((criterion) => String(criterion.id));
}

/** Replaces the `text:` line of one criterion in the frontmatter and its `| ID | ... |` table row.
 * YAML has no round trip in Bun, so only that one line and that one row change; a ticket with no
 * table row keeps only the frontmatter change. Returns the new ticket and the old frontmatter text.
 */
function rewriteTicket(
  ticket: string,
  criterionId: string,
  newText: string,
): { ticket: string; oldText: string } {
  const lines = ticket.split("\n");
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end === -1)
    throw new ArkError("ticket.md has no frontmatter between --- lines");
  const idLine = lines.findIndex(
    (line, i) => i < end && new RegExp(`^\\s*-\\s*id:\\s*["']?${criterionId}["']?\\s*$`).test(line),
  );
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
    (line, i) => i > end && new RegExp(`^\\|\\s*${criterionId}\\s*\\|`).test(line),
  );
  if (row !== -1) lines[row] = `| ${criterionId} | ${newText.replaceAll("|", "\\|")} |`;
  return { ticket: lines.join("\n"), oldText };
}

export function criteriaAmend(
  runId: string,
  criterionId: string,
  file: string,
  inProject?: string,
): void {
  const { directory } = findRun(runId, inProject);
  // Refuse a wrong phase or an unknown criterion before reading the file.
  assertAllowed(deriveState(readEvents(directory)), "criteria.amended", { criterion: criterionId });
  if (!existsSync(file)) throw new ArkError(`criteria.amended refused: ${file} not found`);
  const newText = readFileSync(file, "utf8")
    .trim()
    .replace(/\s*\n\s*/g, " ");
  if (newText === "")
    throw new ArkError(
      `criteria.amended refused: ${file} is empty; the new criterion text is required`,
    );
  const ticketFile = join(directory, "ticket.md");
  const { ticket, oldText } = rewriteTicket(readFileSync(ticketFile, "utf8"), criterionId, newText);
  // The event goes first: it re-checks the phase, and a refusal must leave ticket.md untouched.
  appendEvent(directory, "criteria.amended", {
    criterion: criterionId,
    old: oldText,
    new: newText,
  });
  writeFileSync(ticketFile, ticket);
  console.log(
    `amended ${criterionId} in ticket.md (frontmatter and table); recorded criteria.amended`,
  );
  console.log(`  old: ${oldText}`);
  console.log(`  new: ${newText}`);
  if (existsSync(join(directory, "plan.md")))
    console.log(
      `plan.md may be stale: run \`ark plan check ${runId}\` again to list this amendment`,
    );
}
