import type { Parser, TestResult } from "./index.ts";

const criterionPattern = /\b[A-Z][A-Z0-9]+-\d+-AC\d+\b/g;
const entities: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };

function unescapeXml(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(lt|gt|quot|apos|amp));/g, (_match, decimal, hex, name) =>
    name ? entities[name] : String.fromCodePoint(decimal ? Number(decimal) : parseInt(hex, 16)),
  );
}

function attributesOf(text: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const [, key, value] of text.matchAll(/([\w:-]+)="([^"]*)"/g)) attributes[key] = unescapeXml(value);
  return attributes;
}

// Reads the JUnit XML that `bun test --reporter=junit` writes. Bun puts describe-block names in `classname`.
export const parseBun: Parser = ({ report }) => {
  const results: TestResult[] = [];
  for (const [, attributeText, , body = ""] of report.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const { name = "", classname = "" } = attributesOf(attributeText);
    const criteria = [...new Set(`${classname} ${name}`.match(criterionPattern) ?? [])].sort();
    const status = /<(failure|error)\b/.test(body) ? "failed" : /<skipped\b/.test(body) ? "skipped" : "passed";
    results.push({ name, criteria, status });
  }
  return results;
};
