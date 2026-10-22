// bun:test has no native tags: an AC ID sits in the test name or any describe name.
// bun's JUnit puts the describe path in `classname` (innermost first) and thrown errors in <failure type="Error">.
export const AC_ID = /[A-Z][A-Z0-9]+-\d+-AC\d+/g;

export type Status = "pass" | "failure" | "error" | "skipped";
export type Case = { file: string; name: string; classname: string; acs: string[]; status: Status };

const unescape = (s: string) =>
  s.replace(/&(#\d+|lt|gt|amp|quot|apos);/g, (_, e: string) =>
    e[0] === "#" ? String.fromCodePoint(+e.slice(1)) : ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[e]);
const attrs = (s: string) => Object.fromEntries([...s.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], unescape(m[2])]));

// ponytail: regex over bun's flat, escaped JUnit; a real XML parser if another runner's output needs it.
export function parse(xml: string): Case[] {
  return [...xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)].map(([, a, body = ""]) => {
    const { name = "", classname = "", file = "" } = attrs(a);
    const acs = [...new Set(`${name} ${classname}`.match(AC_ID) ?? [])];
    const bad = body.match(/<(failure|error)\b([^>]*)>/);
    let status: Status = "pass";
    if (/<skipped\b/.test(body)) status = "skipped";
    else if (bad) status = bad[1] === "error" || (attrs(bad[2]).type && !/assert/i.test(attrs(bad[2]).type)) ? "error" : "failure";
    return { file, name, classname, acs, status };
  });
}

// Selector for `-t`: test names are matched as a regex against the full describe path.
export const tags = (ids: string[]) => ids.join("|");

// Static check for AC7: does this source file carry an AC tag?
export const taggedFile = (source: string) => (source.match(AC_ID) ?? []).length > 0;
