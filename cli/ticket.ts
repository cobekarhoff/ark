import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalCriterion } from "./criterion-id.ts";
import { ArkError } from "./errors.ts";
import { ticketKinds, ticketStatuses, type TicketKind } from "./lifecycle.ts";

const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** The YAML block between the `---` lines of a Markdown file and the body after it. `yaml` is undefined when there is no block. */
export function splitFrontmatter(text: string): { yaml: string | undefined; body: string } {
  const match = text.match(frontmatterPattern);
  return match ? { yaml: match[1], body: match[2] } : { yaml: undefined, body: text };
}

/** The parsed frontmatter fields and the body. `fields` is undefined when there is no block and `{}` when the block is empty or not a mapping; a block that is not valid YAML throws. */
export function frontmatter(text: string): {
  fields: Record<string, unknown> | undefined;
  body: string;
} {
  const { yaml, body } = splitFrontmatter(text);
  if (yaml === undefined) return { fields: undefined, body };
  const parsed: unknown = Bun.YAML.parse(yaml);
  return {
    fields:
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {},
    body,
  };
}

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

/** The id, title, kind and criterion ids of a ticket file, refusing one that lacks the required fields. */
export function readTicket(ticketFile: string): {
  id: string;
  title: string;
  kind: TicketKind;
  criteria: string[];
} {
  const fields = frontmatter(readFileSync(ticketFile, "utf8")).fields;
  if (!fields)
    throw new ArkError(
      `${ticketFile}: the ticket needs YAML frontmatter with id, title and acceptance_criteria`,
    );
  for (const key of ["id", "title"]) {
    if (typeof fields[key] !== "string" || fields[key] === "")
      throw new ArkError(`${ticketFile}: ticket field ${key} is required`);
  }
  if (fields.summary !== undefined && (typeof fields.summary !== "string" || fields.summary === ""))
    throw new ArkError(`${ticketFile}: ticket field summary must be a non-empty string`);
  const kind = fields.kind ?? "feature";
  if (!(ticketKinds as readonly unknown[]).includes(kind))
    throw new ArkError(
      `${ticketFile}: kind must be one of ${ticketKinds.join(", ")}, not ${JSON.stringify(kind)}`,
    );
  if (
    fields.status !== undefined &&
    !(ticketStatuses as readonly unknown[]).includes(fields.status)
  )
    console.warn(
      `warning: ${ticketFile}: status ${JSON.stringify(fields.status)} is not one of ${ticketStatuses.join(", ")}; the hub shows it as written`,
    );
  const ids = parseCriteria(fields, ticketFile).map((criterion) => criterion.id);
  return {
    id: fields.id as string,
    title: fields.title as string,
    kind: kind as TicketKind,
    criteria: ids,
  };
}

/** Sets the first `status:` line of the ticket front matter. Changes no other byte. Returns false when there is no such line. */
export function setTicketStatus(ticketFile: string, status: string): boolean {
  const text = readFileSync(ticketFile, "utf8");
  const { yaml, body } = splitFrontmatter(text);
  if (yaml === undefined) return false;
  const line = /^status:[^\r\n]*/m.exec(text.slice(0, text.length - body.length));
  if (!line) return false;
  writeFileSync(
    ticketFile,
    text.slice(0, line.index) + `status: ${status}` + text.slice(line.index + line[0].length),
  );
  return true;
}

/** The criteria of the run folder's ticket.md, with method and verified_by. */
export function runCriteria(runDirectory: string): TicketCriterion[] {
  const file = join(runDirectory, "ticket.md");
  return existsSync(file)
    ? parseCriteria(frontmatter(readFileSync(file, "utf8")).fields ?? {}, file)
    : [];
}

/** Ids of the criteria whose method is not `test` (`manual: true` included). A person proves them with the `manual` gate. */
export function manualCriteria(runDirectory: string): string[] {
  return runCriteria(runDirectory)
    .filter((criterion) => criterion.method !== "test")
    .map((criterion) => criterion.id);
}

/** True when a criterion of the run folder's ticket has method `test`: the red-test (bug) and base-pass (refactor) rules apply only then. */
export function hasTestCriterion(runDirectory: string): boolean {
  return runCriteria(runDirectory).some((criterion) => criterion.method === "test");
}

/** The evidence file of a criterion that no test proves: `results/evidence/AC<k>.md` in the run folder. */
export function evidenceFile(runDirectory: string, criterionId: string): string {
  return join(runDirectory, "results", "evidence", `${criterionId.split("/").pop()}.md`);
}

const headingLine = /^#{1,6}\s+(.+?)\s*$/;
const screenshotPath = /\S+\.(png|jpe?g|gif|webp)\b/i;

/** The lines under the heading `name`, up to the next heading of the same or a higher level; undefined when the heading is missing. */
function sectionOf(lines: string[], name: string): string[] | undefined {
  const start = lines.findIndex(
    (line) => headingLine.exec(line)?.[1].toLowerCase() === name.toLowerCase(),
  );
  if (start === -1) return undefined;
  const level = lines[start].indexOf(" ");
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (headingLine.test(line) && line.indexOf(" ") <= level) break;
    body.push(line);
  }
  return body;
}

/** True when the section names `label` as a sub-heading with text under it, or as a line `label: text`. */
function hasLabel(body: string[], label: string): boolean {
  const inline = new RegExp(`^\\s*(?:[-*]\\s+)?\\**${label}\\**\\s*:\\s*\\**\\s*\\S`, "i");
  return body.some((line, i) => {
    if (inline.test(line)) return true;
    if (headingLine.exec(line)?.[1].toLowerCase() !== label.toLowerCase()) return false;
    for (const next of body.slice(i + 1)) {
      if (headingLine.test(next)) return false;
      if (next.trim() !== "") return true;
    }
    return false;
  });
}

/**
 * The shape of `results/evidence/<AC id>.md` for its method. Returns the reason the file is malformed, naming the
 * section, or undefined. Screenshot paths are checked for shape, not for existence.
 */
export function evidenceProblem(method: Method, text: string): string | undefined {
  const lines = text.split("\n").map((line) => line.trimEnd());
  const missing = (name: string) => `missing section "${name}"`;
  const empty = (name: string) => `section "${name}" is empty`;
  if (method === "demonstration") {
    for (const name of ["What the human did", "What the human saw", "Before", "After"]) {
      const body = sectionOf(lines, name);
      if (body === undefined) return missing(name);
      if (body.every((line) => line.trim() === "")) return empty(name);
      if (
        (name === "Before" || name === "After") &&
        !body.some((line) => screenshotPath.test(line))
      )
        return `section "${name}" has no screenshot path`;
    }
    return lines.findLast((line) => line !== "") === "human: ok"
      ? undefined
      : 'the last line is not "human: ok"';
  }
  if (method === "inspection") {
    for (const name of ["Files", "Checked against", "Verdict"]) {
      const body = sectionOf(lines, name);
      if (body === undefined) return missing(name);
      if (body.every((line) => line.trim() === "")) return empty(name);
      if (name !== "Files") continue;
      const entry = body
        .map((line) =>
          line
            .replace(/^\s*[-*]\s+/, "")
            .replace(/`/g, "")
            .trim(),
        )
        .find((line) => line !== "" && !/^\S+:\d+(-\d+)?$/.test(line));
      if (entry !== undefined)
        return `section "Files": "${entry}" has no path:start-end line range`;
    }
    return sectionOf(lines, "Verdict")!.some((line) => /^reviewer: (pass|fail)$/.test(line.trim()))
      ? undefined
      : 'section "Verdict" has no reviewer line: write "reviewer: pass" or "reviewer: fail"';
  }
  for (const name of ["Command", "Output", "Threshold", "Result"]) {
    const body = sectionOf(lines, name);
    if (body === undefined) return missing(name);
    for (const label of ["Base", "Head"])
      if (!hasLabel(body, label)) return `section "${name}" has no ${label}`;
  }
  return undefined;
}
