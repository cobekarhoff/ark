import ticketSchema from "../../schemas/ticket.schema.json";

// bun:test has no native tags: an AC ID sits in the test name or any describe name.
// bun's JUnit puts the describe path in `classname` (innermost first) and thrown errors in <failure type="Error">.
// The ticket id pattern is the schema's own, so a one-letter project prefix (A-1-AC1) is a tag too.
// Bounded on both sides: with one-letter prefixes, `XA-1-AC1` must not yield `A-1-AC1`, nor `A-1-AC10` yield `A-1-AC1`.
const ID = `(?<![A-Za-z0-9-])${ticketSchema.properties.id.pattern.slice(1, -1)}-AC\\d+(?!\\d)`;
export const AC_ID = new RegExp(ID, "g");

export type Status = "pass" | "failure" | "error" | "skipped";
// `line`: where the test is declared, so same-named tests in one file stay distinct.
export type TestCase = { file: string; name: string; classname: string; line: string; acs: string[]; status: Status };

const unescape = (source: string) =>
  source.replace(/&(#\d+|lt|gt|amp|quot|apos);/g, (_, entity: string) =>
    entity[0] === "#" ? String.fromCodePoint(+entity.slice(1)) : ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[entity]);
const attributes = (source: string) => Object.fromEntries([...source.matchAll(/([\w:-]+)="([^"]*)"/g)].map((match) => [match[1], unescape(match[2])]));

// ponytail: regex over bun's flat, escaped JUnit; a real XML parser if another runner's output needs it.
export function parse(xml: string): TestCase[] {
  return [...xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)].map(([, attributesText, body = ""]) => {
    const { name = "", classname = "", file = "", line = "" } = attributes(attributesText);
    const acs = [...new Set(`${name} ${classname}`.match(AC_ID) ?? [])];
    const failure = body.match(/<(failure|error)\b([^>]*)>/);
    let status: Status = "pass";
    if (/<skipped\b/.test(body)) status = "skipped";
    else if (failure) status = failure[1] === "error" || (attributes(failure[2]).type && !/assert/i.test(attributes(failure[2]).type)) ? "error" : "failure";
    return { file, name, classname, line, acs, status };
  });
}

// Selector for `-t`: a regex over the full describe path, bounded like AC_ID so AC1 selects neither AC10 nor BA-1-AC1.
export const tags = (ids: string[]) => `(?<![A-Za-z0-9-])(${ids.join("|")})(?!\\d)`;

// The AC IDs a source file carries.
export const tagsIn = (source: string): string[] => [...new Set(source.match(AC_ID) ?? [])];

// Static check for AC7: does this source file carry an AC tag?
export const taggedFile = (source: string) => tagsIn(source).length > 0;


// Every suite runs for every selection, so a suite that holds none of the selected ACs must exit 0: bun exits 1 when `-t` matches nothing unless told otherwise.
export const runProblem = (run: string): string | undefined =>
  run.includes("--pass-with-no-tests") ? undefined : "bun-test suites must pass --pass-with-no-tests so a suite without the selected acceptance criteria exits 0";
