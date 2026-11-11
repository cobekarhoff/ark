import { caseIdsIn } from "./case.ts";
import type { Parser, TestResult } from "./index.ts";

export const criterionPattern = /\b[A-Z][A-Z0-9]+-\d+[-/]AC\d+\b/g;
const entities: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };

function unescapeXml(text: string): string {
  return text.replace(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|(lt|gt|quot|apos|amp));/g,
    (_match, decimal, hex, name) =>
      name ? entities[name] : String.fromCodePoint(decimal ? Number(decimal) : parseInt(hex, 16)),
  );
}

export function attributesOf(text: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const [, key, value] of text.matchAll(/([\w:-]+)="([^"]*)"/g))
    attributes[key] = unescapeXml(value);
  return attributes;
}

// Reads the JUnit XML that `bun test --reporter=junit` writes. Bun puts describe-block names in `classname`.
// A test carries an old AC id (`criteria`) or a test case id `<KEY>-T<n>` (`cases`) when its title (or describe
// name) holds it, for example `ARK-T12 ark test joins results through verified_by`.
export const parseBun: Parser = ({ report }) => {
  const results: TestResult[] = [];
  for (const [, attributeText, , body = ""] of report.matchAll(
    /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g,
  )) {
    const { name = "", classname = "", file } = attributesOf(attributeText);
    const criteria = [...new Set(`${classname} ${name}`.match(criterionPattern) ?? [])].sort();
    const status = /<(failure|error)\b/.test(body)
      ? "failed"
      : /<skipped\b/.test(body)
        ? "skipped"
        : "passed";
    results.push({
      name,
      criteria,
      cases: caseIdsIn(`${classname} ${name}`).sort(),
      status,
      ...(file ? { file } : {}),
    });
  }
  return results;
};
