/** Lines of a *.pw.ts spec that read or build a date. Limit 0: use isoAt/dateOf/testNow from test/pw/helpers.ts. */
export function countDateReads(text: string): number {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//") && /\bnew Date\(|\bDate\.now\(/.test(line))
    .length;
}
