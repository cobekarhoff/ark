import ticketSchema from "../../schemas/ticket.schema.json";

// bun:test has no native tags: an AC ID sits in the test name or any describe name.
// bun's JUnit puts the describe path in `classname` (innermost first) and thrown errors in <failure type="Error">.
// The ticket id pattern is the schema's own, so a one-letter project prefix (A-1-AC1) is a tag too.
// Bounded on both sides: with one-letter prefixes, `XA-1-AC1` must not yield `A-1-AC1`, nor `A-1-AC10` yield `A-1-AC1`.
const ID = `(?<![A-Za-z0-9-])${ticketSchema.properties.id.pattern.slice(1, -1)}-AC\\d+(?!\\d)`;
export const AC_ID = new RegExp(ID, "g");

export type Status = "pass" | "failure" | "error" | "skipped";
// `line`: where the test is declared, so same-named tests in one file stay distinct.
export type Case = { file: string; name: string; classname: string; line: string; acs: string[]; status: Status };

const unescape = (s: string) =>
  s.replace(/&(#\d+|lt|gt|amp|quot|apos);/g, (_, e: string) =>
    e[0] === "#" ? String.fromCodePoint(+e.slice(1)) : ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[e]);
const attrs = (s: string) => Object.fromEntries([...s.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], unescape(m[2])]));

// ponytail: regex over bun's flat, escaped JUnit; a real XML parser if another runner's output needs it.
export function parse(xml: string): Case[] {
  return [...xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)].map(([, a, body = ""]) => {
    const { name = "", classname = "", file = "", line = "" } = attrs(a);
    const acs = [...new Set(`${name} ${classname}`.match(AC_ID) ?? [])];
    const bad = body.match(/<(failure|error)\b([^>]*)>/);
    let status: Status = "pass";
    if (/<skipped\b/.test(body)) status = "skipped";
    else if (bad) status = bad[1] === "error" || (attrs(bad[2]).type && !/assert/i.test(attrs(bad[2]).type)) ? "error" : "failure";
    return { file, name, classname, line, acs, status };
  });
}

// Selector for `-t`: a regex over the full describe path, bounded like AC_ID so AC1 selects neither AC10 nor BA-1-AC1.
export const tags = (ids: string[]) => `(?<![A-Za-z0-9-])(${ids.join("|")})(?!\\d)`;

// Static check for AC7: does this source file carry an AC tag?
export const taggedFile = (source: string) => (source.match(AC_ID) ?? []).length > 0;
