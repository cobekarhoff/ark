import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { canonicalCriterion } from "./criterion-id.ts";
import { ArkError } from "./errors.ts";
import { appendEvent, deriveState, readEvents } from "./events.ts";
import { findRun } from "./paths.ts";
import { assertAllowed } from "./transitions.ts";
import { isCaseId } from "./criterion-id.ts";
import {
  assertGuardsAllowed,
  frontmatter,
  manualCriteria,
  methods,
  parseCriteria,
  runCriteria,
} from "./ticket.ts";
import type { TicketKind } from "./lifecycle.ts";
import { discoverRepos, mirrorRoot } from "./workspace.ts";

const criteriaFileKeys = ["id", "text", "method", "verified_by", "guard"];

/** A YAML scalar for a flow list or a key: plain when it is a word, else a JSON string. */
const scalar = (value: string): string =>
  /^(?!(?:true|false|null|yes|no|on|off)$)[A-Za-z][A-Za-z0-9._/-]*$/i.test(value)
    ? value
    : JSON.stringify(value);

type FileCriterion = {
  id: string;
  method: string;
  guard?: true;
  verified_by: string[];
  text: string;
};

/**
 * Reads and checks a criteria file: a YAML mapping whose only key is `acceptance_criteria`, a list of
 * `{id, text, method, verified_by, guard}`. Refuses an unknown key (`manual` too), a duplicate id, an unknown
 * method, an empty list, a `method: test` criterion with an empty `verified_by`, and `guard: true` on a
 * criterion whose method is not `test` or in a run whose kind is not `bug`. Writes nothing.
 */
function readCriteriaFile(
  file: string,
  path: string,
  ticketId: string,
  kind: TicketKind,
): FileCriterion[] {
  const source = `criteria file ${file}`;
  if (!existsSync(path)) throw new ArkError(`${source}: not found`);
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ArkError(`${source} is not valid YAML (${(error as Error).message})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new ArkError(`${source}: expected a mapping with an acceptance_criteria list`);
  const top = parsed as Record<string, unknown>;
  const unknownKey = Object.keys(top).find((key) => key !== "acceptance_criteria");
  if (unknownKey !== undefined) throw new ArkError(`${source}: unknown key "${unknownKey}"`);
  const list = top.acceptance_criteria;
  if (!Array.isArray(list) || list.length === 0)
    throw new ArkError(`${source}: acceptance_criteria must be a list with at least one criterion`);
  list.forEach((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new ArkError(`${source}: acceptance_criteria[${i}] must be a mapping`);
    const written = typeof entry.id === "string" ? entry.id : `acceptance_criteria[${i}]`;
    for (const key of Object.keys(entry))
      if (!criteriaFileKeys.includes(key))
        throw new ArkError(`${source}: unknown key "${key}" in criterion ${written}`);
  });
  // The ticket loader checks id, text, duplicate ids, method and verified_by.
  const criteria = parseCriteria({ id: ticketId, acceptance_criteria: list }, source);
  assertGuardsAllowed(criteria, kind, source);
  return criteria.map((criterion, i) => {
    const entry = list[i] as { id: string; text: string };
    if (entry.text.trim() === "")
      throw new ArkError(`${source}: criterion ${entry.id} has no text`);
    if (criterion.method === "test" && criterion.verified_by.length === 0)
      throw new ArkError(
        `${source}: criterion ${entry.id} has method "test" and an empty verified_by list: add an integration or e2e test case id, or set method to ${methods.filter((method) => method !== "test").join(", ")}`,
      );
    return {
      id: entry.id,
      method: criterion.method,
      ...(criterion.guard && { guard: true as const }),
      verified_by: criterion.verified_by,
      text: entry.text,
    };
  });
}

/** The ticket with its `acceptance_criteria:` block replaced; every other line and the body stay. */
function replaceCriteriaBlock(ticket: string, criteria: FileCriterion[]): string {
  const eol = ticket.includes("\r\n") ? "\r\n" : "\n";
  const lines = ticket.split(eol);
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end === -1)
    throw new ArkError("the ticket file has no frontmatter between --- lines");
  const block = [
    "acceptance_criteria:",
    ...criteria.flatMap((criterion) => [
      `  - id: ${scalar(criterion.id)}`,
      `    method: ${criterion.method}`,
      ...(criterion.guard ? ["    guard: true"] : []),
      `    verified_by: [${criterion.verified_by.map(scalar).join(", ")}]`,
      `    text: ${JSON.stringify(criterion.text)}`,
    ]),
  ];
  const start = lines.findIndex((line, i) => i < end && /^acceptance_criteria\s*:/.test(line));
  if (start === -1) {
    lines.splice(end, 0, ...block);
    return lines.join(eol);
  }
  // The old block runs to the next top-level key; trailing comments and blank lines belong to what follows.
  let stop = start + 1;
  while (stop < end && !/^[A-Za-z_][\w-]*\s*:/.test(lines[stop])) stop++;
  while (
    stop > start + 1 &&
    (lines[stop - 1].trim() === "" || lines[stop - 1].trim().startsWith("#"))
  )
    stop--;
  lines.splice(start, stop - start, ...block);
  return lines.join(eol);
}

/**
 * Writes the criteria of a criteria file into the ticket file: checks the whole file first, replaces
 * only the `acceptance_criteria:` block, and checks that the result parses back to the file's criteria
 * with every other frontmatter field unchanged. A relative path is read from the run folder.
 * Nothing is written when any check fails.
 */
export function writeCriteriaFile(runDirectory: string, ticketFile: string, file: string): void {
  const before = readFileSync(ticketFile, "utf8");
  const beforeFields = frontmatter(before).fields;
  if (!beforeFields) throw new ArkError(`${ticketFile}: the ticket needs YAML frontmatter`);
  const ticketId = typeof beforeFields.id === "string" ? beforeFields.id : "";
  const criteria = readCriteriaFile(
    file,
    isAbsolute(file) ? file : join(runDirectory, file),
    ticketId,
    deriveState(readEvents(runDirectory)).kind,
  );
  const after = replaceCriteriaBlock(before, criteria);
  let afterFields: Record<string, unknown> | undefined;
  try {
    afterFields = frontmatter(after).fields;
  } catch (error) {
    throw new ArkError(
      `the rewritten ticket file does not parse (${(error as Error).message}); nothing changed`,
    );
  }
  // JSON.stringify drops an undefined value, so setting the list to undefined compares the other fields.
  const withoutList = (fields: object | undefined) =>
    JSON.stringify({ ...fields, acceptance_criteria: undefined });
  if (
    JSON.stringify(afterFields?.acceptance_criteria) !== JSON.stringify(criteria) ||
    withoutList(afterFields) !== withoutList(beforeFields)
  )
    throw new ArkError(
      "the rewritten ticket file does not hold the criteria file's criteria and its other fields; nothing changed",
    );
  writeFileSync(ticketFile, after);
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
  if (value === "" || value.startsWith("#")) {
    // The block list runs over its items, deeper continuation lines, comments and blank lines;
    // trailing comments and blanks belong to whatever follows, so the span ends at the last item.
    let spanEnd = keyLine;
    for (let i = keyLine + 1; i < end; i++) {
      const line = lines[i];
      const lineIndent = (line.match(/^\s*/) as RegExpMatchArray)[0].length;
      if (/^\s*-(\s|$)/.test(line) && lineIndent >= indent.length) spanEnd = i;
      else if (line.trim() !== "" && !line.trim().startsWith("#") && lineIndent > indent.length)
        spanEnd = i;
      else if (line.trim() !== "" && !line.trim().startsWith("#")) break;
    }
    count = spanEnd - keyLine + 1;
  }
  lines.splice(keyLine, count, `${indent}verified_by: ${list}`);
  return lines.join("\n");
}

/** Sets (`guard: true`) or removes the `guard:` line of one criterion. Only that line changes; an existing `guard: false` line is replaced, not doubled. */
function rewriteGuard(
  ticket: string,
  criterionId: string,
  guard: boolean,
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
  let guardLine = -1;
  for (let i = idLine + 1; i < end && !/^\s*-\s*id:/.test(lines[i]); i++)
    if (/^\s*guard:/.test(lines[i])) guardLine = i;
  const indent = " ".repeat((lines[idLine].match(/^(\s*-\s*)id:/) as RegExpMatchArray)[1].length);
  if (!guard) {
    if (guardLine !== -1) lines.splice(guardLine, 1);
  } else if (guardLine !== -1) lines[guardLine] = `${indent}guard: true`;
  else lines.splice(idLine + 1, 0, `${indent}guard: true`);
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
  /** `--guard` is true, `--no-guard` is false, neither is undefined. */
  guard?: boolean;
  carryManual?: string;
  project?: string;
};

export function criteriaAmend(
  runId: string,
  criterionArgument: string,
  file: string | undefined,
  options: AmendOptions,
): void {
  const { reason, verifiedBy, guard, carryManual, project } = options;
  const { directory } = findRun(runId, project);
  const state = deriveState(readEvents(directory));
  const ticketId = state.ticket.id;
  const criterionId = canonicalCriterion(criterionArgument, ticketId);
  // Refuse a wrong phase or an unknown criterion before reading the file.
  assertAllowed(state, "criteria.amended", { criterion: criterionId, reason }, directory);
  if ([file, verifiedBy, guard].filter((form) => form !== undefined).length !== 1)
    throw new ArkError(
      "criteria.amended refused: give exactly one of <file> (new text), --verified-by <case ids>, --guard or --no-guard",
    );
  const ticketFile = join(directory, "ticket.md");
  if (guard !== undefined) {
    if (carryManual !== undefined)
      throw new ArkError(
        "criteria.amended refused: --carry-manual works with the text form only (a guard amend keeps manual answers anyway)",
      );
    const criterion = runCriteria(directory).find((entry) => entry.id === criterionId);
    if (!criterion)
      throw new ArkError(`criteria.amended refused: ticket.md has no criterion ${criterionId}`);
    if (guard)
      assertGuardsAllowed([{ ...criterion, guard }], state.kind, "criteria.amended refused");
    if (criterion.guard === guard)
      throw new ArkError(
        `criteria.amended refused: ${criterionId} is ${guard ? "already a guard" : "not a guard"}; nothing to change`,
      );
    const ticket = rewriteGuard(readFileSync(ticketFile, "utf8"), criterionId, guard, ticketId);
    // A rewrite that does not parse back to the new flag is refused before anything is written.
    let written: boolean | undefined;
    try {
      written = parseCriteria(frontmatter(ticket).fields ?? {}, ticketFile).find(
        (entry) => entry.id === criterionId,
      )?.guard;
    } catch (error) {
      throw new ArkError(
        `criteria.amended refused: the rewritten ticket.md does not parse (${(error as Error).message}); nothing changed`,
      );
    }
    if (written !== guard)
      throw new ArkError(
        "criteria.amended refused: the rewritten ticket.md does not hold the new guard; nothing changed",
      );
    // The event goes first: it re-checks the phase, and a refusal must leave ticket.md untouched.
    appendEvent(directory, "criteria.amended", {
      criterion: criterionId,
      guard,
      by: "human",
      reason: reason?.trim(),
    });
    writeFileSync(ticketFile, ticket);
    console.log(
      `amended ${criterionId}: ${guard ? "guard: true (the red proof skips it)" : "guard removed (the red proof needs it failing)"}; recorded criteria.amended`,
    );
    return;
  }
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
    // A rewrite that does not parse back to the new list is refused before anything is written.
    let written: string[] | undefined;
    try {
      written = parseCriteria(frontmatter(ticket).fields ?? {}, ticketFile).find(
        (criterion) => criterion.id === criterionId,
      )?.verified_by;
    } catch (error) {
      throw new ArkError(
        `criteria.amended refused: the rewritten ticket.md does not parse (${(error as Error).message}); nothing changed`,
      );
    }
    if (written?.join(",") !== ids.join(","))
      throw new ArkError(
        "criteria.amended refused: the rewritten ticket.md does not hold the new verified_by; nothing changed",
      );
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
