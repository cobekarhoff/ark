import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { API } from "typescript/unstable/async";
import {
  isArrayLiteralExpression,
  isArrowFunction,
  isCallExpression,
  isFunctionExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isStringLiteral,
  isTemplateExpression,
  isTaggedTemplateExpression,
  isVariableStatement,
  type CallExpression,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";
import { loadConfig, type ProjectConfig } from "./config.ts";
import { ArkError } from "./errors.ts";
import { projectDirectory, runsDirectory } from "./paths.ts";
import { attributesOf, criterionPattern } from "./parsers/bun.ts";
import { caseIdsIn } from "./parsers/case.ts";
import { frontmatter, parseCriteria } from "./ticket.ts";

type Suite = ProjectConfig["suites"][number];
type Kind = "case" | "old" | "none";

export type Row = {
  file: string;
  line: number;
  title: string;
  kind: Kind;
  id: string | null;
  acs: string[];
  durationMs: number | null;
  /** The row count of a `test.each` table, 1 for a plain test, null when the table is not a literal. */
  rows: number | null;
  modifier: string | null;
};

/** A declaration as the scanner sees it: `endLine` closes the title, the table and the body. */
type Declaration = Omit<Row, "file" | "acs" | "durationMs"> & { endLine: number; cases: string[] };

const defaultGlob = "**/*.{test,spec}.{ts,tsx,js,jsx}";
const allowedModifiers = new Set([
  "each",
  "only",
  "skip",
  "todo",
  "skipIf",
  "if",
  "failing",
  "concurrent",
  "serial",
  "fixme",
  "slow",
  "fail",
]);
const modifierLabels = ["skipIf", "only", "skip", "todo", "fixme", "failing", "fail", "slow"];

const globOf = (suite: Suite): Bun.Glob => new Bun.Glob(suite.base_files ?? defaultGlob);

/** The first suite whose files include `path` owns it, so no file is counted twice. */
const ownerOf = (suites: Suite[], repo: string, path: string): Suite | undefined =>
  suites.find((suite) => suite.repo === repo && globOf(suite).match(path));

function analyze(call: CallExpression): {
  group: boolean;
  modifier: string | null;
  table: Node | undefined;
} | null {
  let expression: Node = call.expression;
  const modifiers: string[] = [];
  let table: Node | undefined;
  for (;;) {
    if (isPropertyAccessExpression(expression)) {
      modifiers.unshift(expression.name.text);
      expression = expression.expression;
    } else if (isCallExpression(expression)) {
      // the factory call of `each(table)` or `skipIf(condition)`
      if (
        isPropertyAccessExpression(expression.expression) &&
        expression.expression.name.text === "each"
      )
        table = expression.arguments[0];
      expression = expression.expression;
    } else if (isTaggedTemplateExpression(expression)) {
      table = expression.template;
      expression = expression.tag;
    } else break;
  }
  if (!isIdentifier(expression) || !["test", "it", "describe"].includes(expression.text))
    return null;
  let group = expression.text === "describe";
  // Playwright: test.describe(...)
  if (expression.text === "test" && modifiers[0] === "describe") {
    group = true;
    modifiers.shift();
  }
  if (!modifiers.every((modifier) => allowedModifiers.has(modifier))) return null;
  return {
    group,
    modifier: modifierLabels.find((label) => modifiers.includes(label)) ?? null,
    table,
  };
}

function kindOf(text: string): { kind: Kind; id: string | null; cases: string[] } {
  const cases = caseIdsIn(text);
  if (cases.length > 0) return { kind: "case", id: cases[0], cases };
  const old = text.match(criterionPattern);
  return old ? { kind: "old", id: old[0], cases } : { kind: "none", id: null, cases };
}

/** Every test and it declaration of one file. A describe title counts for the ids of its tests, as the bun report's classname does. */
function declarationsOf(sourceFile: SourceFile, text: string): Declaration[] {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const lineAt = (offset: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
  // top-level `const name = [...]` tables, for `test.each(name)`
  const arrayRows = new Map<string, number>();
  for (const statement of sourceFile.statements)
    if (isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (
          isIdentifier(declaration.name) &&
          declaration.initializer !== undefined &&
          isArrayLiteralExpression(declaration.initializer)
        )
          arrayRows.set(declaration.name.text, declaration.initializer.elements.length);
  const found: Declaration[] = [];
  const titleOf = (node: Node): string => {
    if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) return node.text;
    const source = node.getText();
    return source.startsWith("`") ? source.slice(1, -1) : source;
  };
  const visit = (node: Node, describes: string[]): void => {
    if (isCallExpression(node)) {
      const shape = analyze(node);
      const [first, second] = node.arguments;
      const titled =
        first !== undefined &&
        (isStringLiteral(first) ||
          isNoSubstitutionTemplateLiteral(first) ||
          first.getText().startsWith("`") ||
          (second !== undefined && (isArrowFunction(second) || isFunctionExpression(second))));
      if (shape && titled) {
        const title = titleOf(first);
        if (shape.group) {
          for (const argument of node.arguments) visit(argument, [...describes, title]);
          return;
        }
        let rows: number | null = 1;
        if (shape.table !== undefined) {
          rows = isArrayLiteralExpression(shape.table) ? shape.table.elements.length : null;
          if (rows === null && isIdentifier(shape.table))
            rows = arrayRows.get(shape.table.text) ?? null;
          // tagged table: the head text is the header row, each row holds one `${}` per column
          if (isNoSubstitutionTemplateLiteral(shape.table)) rows = 0;
          else if (isTemplateExpression(shape.table)) {
            const columns = shape.table.head.text.split("|").length;
            rows = shape.table.templateSpans.length / columns;
          }
        }
        found.push({
          line: lineAt(node.getStart()),
          endLine: lineAt(node.end - 1),
          title,
          rows,
          modifier: shape.modifier,
          ...kindOf([...describes, title].join(" ")),
        });
        return;
      }
    }
    node.forEachChild((child) => {
      visit(child, describes);
    });
  };
  visit(sourceFile, []);
  return found;
}

/** Parses every source with the TypeScript AST (native API) and returns its declarations, in input order. */
async function scanSources(
  sources: { text: string; extension: string }[],
): Promise<Declaration[][]> {
  if (sources.length === 0) return [];
  // The API reads files from disk: a private folder with no tsconfig keeps the repo's own project out of it.
  const folder = mkdtempSync(join(tmpdir(), "ark-audit-"));
  const api = new API({ cwd: folder });
  try {
    const names = sources.map((source, i) => {
      const name = join(folder, `${i}${source.extension}`);
      writeFileSync(name, source.text);
      return name;
    });
    const snapshot = await api.updateSnapshot({ openFiles: names });
    const found: Declaration[][] = [];
    for (const [i, name] of names.entries()) {
      const project = await snapshot.getDefaultProjectForFile(name);
      const sourceFile = await project?.program.getSourceFile(name);
      if (!sourceFile) throw new ArkError(`TypeScript could not parse a test file`);
      found.push(declarationsOf(sourceFile, sources[i].text));
    }
    return found;
  } finally {
    await api.close();
    rmSync(folder, { recursive: true, force: true });
  }
}

function git(repoPath: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", repoPath, "-c", "core.quotepath=false", ...args]);
  if (result.exitCode !== 0)
    throw new ArkError(`git ${args[0]} failed in ${repoPath}: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

/** Per new path, the new-side line ranges that `git diff base HEAD` changes. */
function changedLines(repoPath: string, base: string): Map<string, { from: number; to: number }[]> {
  const diff = git(repoPath, [
    "diff",
    "-U0",
    "--find-renames",
    "--no-color",
    "--no-ext-diff",
    base,
    "HEAD",
  ]);
  const changed = new Map<string, { from: number; to: number }[]>();
  let current: { from: number; to: number }[] | null = null;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = null;
      inHunk = false;
    } else if (!inHunk && line.startsWith("+++ ")) {
      const path = line.slice(4);
      current = path === "/dev/null" ? null : [];
      if (current) changed.set(path.replace(/^b\//, ""), current);
    } else if (line.startsWith("@@ ")) {
      inHunk = true;
      const match = line.match(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/);
      if (!match || !current) continue;
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      // A removal has no new line: it sits after line `start`, so it touches the two lines around it.
      current.push(
        count === 0 ? { from: start, to: start + 1 } : { from: start, to: start + count - 1 },
      );
    }
  }
  return changed;
}

/**
 * The declarations that the diff from `base` to HEAD changes, read from git objects: hunks from `git diff`,
 * file content from `git show HEAD:<path>`. Neither the working tree nor a checkout is read. A deleted file has none.
 */
async function changedDeclarations(
  repoPath: string,
  repo: string,
  base: string,
  suites: Suite[],
  only?: Suite,
): Promise<{ path: string; declaration: Declaration }[]> {
  const files = [...changedLines(repoPath, base)].filter(([path]) => {
    const owner = ownerOf(suites, repo, path);
    return owner !== undefined && owner.parser === "bun" && (only === undefined || owner === only);
  });
  const found = await scanSources(
    files.map(([path]) => ({
      text: git(repoPath, ["show", `HEAD:${path}`]),
      extension: extname(path),
    })),
  );
  return files.flatMap(([path, lines], i) =>
    found[i]
      .filter((declaration) =>
        lines.some((range) => range.from <= declaration.endLine && range.to >= declaration.line),
      )
      .map((declaration) => ({ path, declaration })),
  );
}

const oldIdLine = (file: string, declaration: Declaration): string =>
  `old id touched: ${file}:${declaration.line} ${declaration.title}`;

/** The `old id touched:` lines of one bun suite: each old-id declaration that the diff from `base` to HEAD changes. */
export async function oldIdsTouched(
  repoPath: string,
  base: string,
  suite: Suite,
  suites: Suite[],
): Promise<string[]> {
  const changed = await changedDeclarations(repoPath, suite.repo, base, suites, suite);
  return changed
    .filter(({ declaration }) => declaration.kind === "old")
    .map(({ path, declaration }) => oldIdLine(path, declaration));
}

/** Case id -> the criteria whose `verified_by` names it, from the project's tickets and the tickets copied into its runs. */
function criteriaByCase(project: string): Map<string, Set<string>> {
  const files = [join(projectDirectory(project), "tickets")].filter(existsSync).flatMap((folder) =>
    readdirSync(folder)
      .filter((name) => name.endsWith(".md"))
      .map((name) => join(folder, name)),
  );
  if (existsSync(runsDirectory(project)))
    for (const run of readdirSync(runsDirectory(project))) {
      const file = join(runsDirectory(project), run, "ticket.md");
      if (existsSync(file)) files.push(file);
    }
  const byCase = new Map<string, Set<string>>();
  for (const file of files) {
    try {
      const fields = frontmatter(readFileSync(file, "utf8")).fields ?? {};
      for (const criterion of parseCriteria(fields, file))
        for (const id of criterion.verified_by)
          byCase.set(id, (byCase.get(id) ?? new Set()).add(criterion.id));
    } catch {
      // a ticket that does not parse has no links
    }
  }
  return byCase;
}

type TimedCase = { file: string; name: string; seconds: number };

/** The testcases of the newest `<suite>.report` over the project's runs, with the JUnit `time`. */
function newestReport(project: string, suite: Suite): TimedCase[] {
  if (!existsSync(runsDirectory(project))) return [];
  let newest: { file: string; modified: number } | null = null;
  for (const run of readdirSync(runsDirectory(project))) {
    const file = join(runsDirectory(project), run, "results", `${suite.name}.report`);
    if (!existsSync(file)) continue;
    const modified = statSync(file).mtimeMs;
    if (newest === null || modified > newest.modified) newest = { file, modified };
  }
  if (newest === null) return [];
  const report = readFileSync(newest.file, "utf8");
  const timed: TimedCase[] = [];
  for (const [, attributeText] of report.matchAll(/<testcase\b([^>]*?)\/?>/g)) {
    const { name = "", classname = "", file, time } = attributesOf(attributeText);
    if (time !== undefined) timed.push({ file: file ?? classname, name, seconds: Number(time) });
  }
  return timed;
}

/** `%s`, `%d` and the other printf marks of a `test.each` title match any text. */
function titlePattern(title: string, table: boolean): RegExp {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${table ? escaped.replace(/%[sdifjoOp#%]/g, ".*") : escaped}$`);
}

export type InventoryOptions = { changed?: string };

/** One row for each test declaration of the project's bun suites, or only the changed ones with `changed`. */
export async function inventory(
  project: string,
  options: InventoryOptions = {},
): Promise<{ rows: Row[]; skipped: string[] }> {
  const config = loadConfig(project);
  const byCase = criteriaByCase(project);
  const rows: Row[] = [];
  const skipped: string[] = [];
  for (const suite of config.suites) {
    if (suite.parser !== "bun") {
      skipped.push(
        `suite ${suite.name} (${suite.parser}): the parser ${suite.parser} has no declaration scan`,
      );
      continue;
    }
    const repoPath = join(config.workspace, suite.repo);
    let found: { path: string; declaration: Declaration }[];
    if (options.changed !== undefined) {
      found = await changedDeclarations(
        repoPath,
        suite.repo,
        options.changed,
        config.suites,
        suite,
      );
    } else {
      const paths = [...globOf(suite).scanSync({ cwd: repoPath, onlyFiles: true })]
        .filter(
          (path) =>
            !path.split("/").includes("node_modules") &&
            ownerOf(config.suites, suite.repo, path) === suite,
        )
        .sort();
      const scanned = await scanSources(
        paths.map((path) => ({
          text: readFileSync(join(repoPath, path), "utf8"),
          extension: extname(path),
        })),
      );
      found = paths.flatMap((path, i) => scanned[i].map((declaration) => ({ path, declaration })));
    }
    const timed = newestReport(project, suite);
    for (const { path, declaration } of found) {
      const pattern = titlePattern(declaration.title, declaration.rows !== 1);
      const matches = timed.filter(
        (entry) =>
          (entry.file === path || path.endsWith(`/${entry.file}`)) && pattern.test(entry.name),
      );
      rows.push({
        file: suite.repo === "." ? path : join(suite.repo, path),
        line: declaration.line,
        title: declaration.title,
        kind: declaration.kind,
        id: declaration.id,
        acs: [...new Set(declaration.cases.flatMap((id) => [...(byCase.get(id) ?? [])]))].sort(),
        durationMs:
          matches.length === 0
            ? null
            : Math.round(matches.reduce((sum, entry) => sum + entry.seconds, 0) * 1000),
        rows: declaration.rows,
        modifier: declaration.modifier,
      });
    }
  }
  return { rows, skipped };
}

const seconds = (milliseconds: number | null): string =>
  milliseconds === null ? "-" : `${(milliseconds / 1000).toFixed(1)}s`;

function tableText(rows: Row[]): string[] {
  return [
    ["file", "line", "title", "kind", "id", "acs", "last"].join("\t"),
    ...rows.map((row) =>
      [
        row.file,
        row.line,
        row.title +
          (row.rows !== 1 ? ` [table x${row.rows ?? "?"}]` : "") +
          (row.modifier ? ` [${row.modifier}]` : ""),
        row.kind,
        row.id ?? "-",
        row.acs.join(",") || "-",
        seconds(row.durationMs),
      ].join("\t"),
    ),
  ];
}

function summaryText(rows: Row[]): string[] {
  const kinds: Kind[] = ["case", "old", "none"];
  const count = (kind: Kind, of: Row[] = rows) => of.filter((row) => row.kind === kind).length;
  const percent = (value: number) =>
    (rows.length === 0 ? 0 : (100 * value) / rows.length).toFixed(1);
  const files = [...new Set(rows.map((row) => row.file))].sort();
  return [
    "by kind",
    ...kinds.map(
      (kind) =>
        `  ${kind.padEnd(5)} ${String(count(kind)).padStart(5)}   (${percent(count(kind))}%)`,
    ),
    `total declarations  ${rows.length}`,
    `total test lines    ${rows.length} (a table counts once)`,
    "",
    ["by file", "case", "old", "none", "total"].join("\t"),
    ...files.map((file) => {
      const own = rows.filter((row) => row.file === file);
      return [file, count("case", own), count("old", own), count("none", own), own.length].join(
        "\t",
      );
    }),
  ];
}

type InventoryFlags = { json: boolean; summary: boolean; changed?: string };

export async function testAuditInventory(
  project: string | undefined,
  flags: InventoryFlags,
): Promise<void> {
  if (project === undefined) throw new ArkError("--project is required");
  if (flags.json && flags.summary) throw new ArkError("use --json or --summary, not both");
  const { rows, skipped } = await inventory(project, { changed: flags.changed });
  for (const line of skipped) console.error(`skip: ${line}`);
  if (flags.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const files = new Set(rows.map((row) => row.file)).size;
  if (flags.summary) {
    console.log(summaryText(rows).join("\n"));
    return;
  }
  console.log(tableText(rows).join("\n"));
  console.log(
    flags.changed === undefined
      ? `${rows.length} declarations in ${files} files`
      : `${rows.length} declarations changed since ${flags.changed}`,
  );
  if (flags.changed !== undefined)
    for (const row of rows.filter((candidate) => candidate.kind === "old"))
      console.log(`old id touched: ${row.file}:${row.line} ${row.title}`);
}
