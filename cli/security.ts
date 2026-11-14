import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ArkError } from "./errors.ts";

/**
 * The security scan of `ark merge-request open` and `ark run close <run> handed_off`: gitleaks on the commits the
 * run branch added, osv-scanner on each lockfile of the head. A secret and a high or critical vulnerability block;
 * medium and low vulnerabilities and the licences of new packages go to the MR body. A failed scan never reads as clean.
 */

const scanners = ["gitleaks", "osv-scanner"] as const;

/** The same line for `ark status` and for the refusal: one for each scanner that is not on PATH. */
export function missingScannerLines(): string[] {
  return scanners
    .filter((tool) => !Bun.which(tool, { PATH: process.env.PATH }))
    .map((tool) => `scanner: ${tool} is not installed: brew install ${tool}`);
}

/** Basenames osv-scanner reads as a lockfile or a manifest of resolved packages. */
const lockfileNames = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "deno.lock",
  "Cargo.lock",
  "go.mod",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "pdm.lock",
  "requirements.txt",
  "composer.lock",
  "Gemfile.lock",
  "pubspec.lock",
  "mix.lock",
  "gradle.lockfile",
  "packages.lock.json",
]);

type Spawned = { exitCode: number; stdout: Buffer; stderr: string };

function spawn(command: string[], cwd: string): Spawned {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: Buffer.from(result.stdout),
    stderr: result.stderr.toString().trim(),
  };
}

/** The last lines of a scanner's stderr: what a person needs to act on a failure. */
const tail = (text: string) => text.split("\n").slice(-10).join("\n");

const NETWORK_HINT = "osv-scanner needs network access to osv.dev and deps.dev";

type OsvPackage = {
  package?: { name?: string; version?: string };
  vulnerabilities?: {
    id: string;
    aliases?: string[];
    database_specific?: { severity?: string };
  }[];
  groups?: { ids?: string[]; max_severity?: string }[];
  licenses?: string[];
};

/** The packages of one lockfile with their vulnerabilities and licences, or `null` when osv-scanner knows no lockfile there (exit 127 or 128). */
function osvScan(directory: string, lockfile: string, name: string): OsvPackage[] | null {
  const { exitCode, stdout, stderr } = spawn(
    [
      "osv-scanner",
      "scan",
      "source",
      "-L",
      lockfile,
      "--licenses",
      "--all-packages",
      "--format",
      "json",
    ],
    directory,
  );
  if (exitCode === 127 || exitCode === 128) return null;
  if (exitCode !== 0 && exitCode !== 1)
    throw new ArkError(
      `osv-scanner failed on ${name} (exit ${exitCode}): ${tail(stderr)}\n${NETWORK_HINT}`,
    );
  let results: { packages?: OsvPackage[] }[] | undefined;
  try {
    results = JSON.parse(stdout.toString()).results;
  } catch {
    // an unreadable report falls through to the refusal
  }
  if (!Array.isArray(results))
    throw new ArkError(
      `osv-scanner report for ${name} cannot be read (exit ${exitCode}): ${tail(stderr) || stdout.toString().slice(0, 200)}\n${NETWORK_HINT}`,
    );
  return results.flatMap((result) => result.packages ?? []);
}

/** `CRITICAL`, `HIGH`, `MEDIUM`, `LOW` or `UNKNOWN`: the advisory's own label, else the CVSS score of its group. */
function severityOf(
  vulnerability: NonNullable<OsvPackage["vulnerabilities"]>[number],
  pkg: OsvPackage,
) {
  const label = vulnerability.database_specific?.severity?.toUpperCase();
  if (label === "MODERATE") return "MEDIUM";
  if (label === "CRITICAL" || label === "HIGH" || label === "MEDIUM" || label === "LOW")
    return label;
  const score = Number(
    pkg.groups?.find((group) => group.ids?.includes(vulnerability.id))?.max_severity,
  );
  // ponytail: a vulnerability with no label and no score is listed, not blocked; block it if osv data proves too sparse
  return score >= 9
    ? "CRITICAL"
    : score >= 7
      ? "HIGH"
      : score >= 4
        ? "MEDIUM"
        : score > 0
          ? "LOW"
          : "UNKNOWN";
}

type Finding = {
  /** Ids an `accepted` entry can name: the finding id, then its aliases or its gitleaks fingerprint. */
  ids: string[];
  blocks: boolean;
  /** The refusal line, with no secret value. */
  line: string;
  /** The row of the Security section of the MR body. */
  row: (reason?: string) => string;
};

type GitleaksEntry = {
  RuleID: string;
  File: string;
  StartLine: number;
  Commit: string;
  Fingerprint: string;
};

function gitleaksFindings(path: string, base: string, report: string): Finding[] {
  const { exitCode, stderr } = spawn(
    [
      "gitleaks",
      "git",
      `--log-opts=--first-parent --no-merges ${base}..HEAD`,
      "--redact",
      "--report-path",
      report,
    ],
    path,
  );
  let entries: GitleaksEntry[] | undefined;
  try {
    const parsed = JSON.parse(readFileSync(report, "utf8"));
    if (Array.isArray(parsed)) entries = parsed;
  } catch {
    // no report or an unreadable one falls through to the refusal
  }
  // gitleaks exits 1 for a leak and for a crash alike, and exits 0 after an `ERR` of a bad git argument.
  const crashed =
    (exitCode !== 0 && exitCode !== 1) ||
    entries === undefined ||
    (exitCode === 1 && entries.length === 0) ||
    (exitCode === 0 && (entries.length > 0 || /\bERR\b/.test(stderr)));
  if (crashed)
    throw new ArkError(
      `gitleaks failed in ${path} (exit ${exitCode}): ${tail(stderr) || "no readable report"}`,
    );
  return entries!.map((entry) => {
    const where = `${entry.RuleID} in ${entry.File}:${entry.StartLine}`;
    return {
      ids: [entry.Fingerprint],
      blocks: true,
      line: `secret: ${where} (commit ${entry.Commit.slice(0, 8)})`,
      row: (reason) => `accepted ${entry.Fingerprint}: ${where} (reason: ${reason})`,
    };
  });
}

function gitBlob(path: string, spec: string): Buffer | null {
  const { exitCode, stdout } = spawn(["git", "show", spec], path);
  return exitCode === 0 ? stdout : null;
}

const packageKey = (pkg: OsvPackage) => `${pkg.package?.name}@${pkg.package?.version}`;

function osvFindings(
  path: string,
  base: string,
  folder: string,
): { findings: Finding[]; licences: string[] } {
  const tracked = spawn(["git", "ls-tree", "-r", "--name-only", "HEAD"], path)
    .stdout.toString()
    .split("\n")
    .filter((file) => lockfileNames.has(basename(file)));
  const findings: Finding[] = [];
  const licences: string[] = [];
  for (const name of tracked) {
    const head = gitBlob(path, `HEAD:${name}`)!;
    const packages = scanBlob(folder, name, head);
    if (packages === null) continue;
    // New at head: every package when the base has no such lockfile, none when it holds the same bytes, else those the base scan lacks.
    const baseBlob = gitBlob(path, `${base}:${name}`);
    let basePackages: OsvPackage[] = [];
    if (baseBlob !== null)
      basePackages = baseBlob.equals(head) ? packages : (scanBlob(folder, name, baseBlob) ?? []);
    const known = new Set(basePackages.map(packageKey));
    for (const pkg of packages) {
      const label = `${pkg.package?.name} ${pkg.package?.version}`;
      for (const vulnerability of pkg.vulnerabilities ?? []) {
        const severity = severityOf(vulnerability, pkg);
        findings.push({
          ids: [vulnerability.id, ...(vulnerability.aliases ?? [])],
          blocks: severity === "CRITICAL" || severity === "HIGH",
          line: `vulnerability: ${vulnerability.id} ${severity}, ${label}, ${name}`,
          row: (reason) =>
            reason === undefined
              ? `${severity.toLowerCase()} ${vulnerability.id}: \`${pkg.package?.name}\` ${pkg.package?.version} (\`${name}\`)`
              : `accepted ${vulnerability.id}: \`${pkg.package?.name}\` ${pkg.package?.version} (\`${name}\`, reason: ${reason})`,
        });
      }
      if (!known.has(packageKey(pkg)))
        licences.push(
          `licence: \`${pkg.package?.name}\` ${pkg.package?.version} ${pkg.licenses?.join(", ") || "unknown"} (\`${name}\`)`,
        );
    }
  }
  return { findings, licences };
}

/** osv-scanner reads a file by its name, so the blob goes to a folder of its own under its own basename. */
function scanBlob(folder: string, name: string, blob: Buffer): OsvPackage[] | null {
  const directory = mkdtempSync(join(folder, "lockfile-"));
  const file = join(directory, basename(name));
  writeFileSync(file, blob);
  return osvScan(directory, file, name);
}

export type RepoSecurity = { repo: string; path: string; base: string };

/**
 * Scans the commits of each repo that has some ahead of its base and the lockfiles of its head, and returns the rows of the
 * Security section for each repo with something to show. Refuses, naming every finding, when a secret or a high or
 * critical vulnerability is not in `accepted`. Refuses first when a scanner is not installed, whatever the repo holds.
 */
export function securityScan(
  repos: RepoSecurity[],
  accepted: { id: string; reason: string }[],
): Map<string, string[]> {
  const missing = missingScannerLines();
  if (missing.length > 0)
    throw new ArkError(`refused: the security scan cannot run\n${missing.join("\n")}`);
  const folder = mkdtempSync(join(tmpdir(), "ark-security-"));
  const rows = new Map<string, string[]>();
  const refusals: string[] = [];
  try {
    const scanned = repos.filter(
      ({ path, base }) =>
        Number(spawn(["git", "rev-list", "--count", `${base}..HEAD`], path).stdout) > 0,
    );
    for (const { repo, path, base } of scanned) {
      const prefix = scanned.length > 1 ? `${repo}: ` : "";
      const osv = osvFindings(path, base, folder);
      const found = [
        ...gitleaksFindings(
          path,
          base,
          join(mkdtempSync(join(folder, "gitleaks-")), "report.json"),
        ),
        ...osv.findings,
      ];
      const repoRows: string[] = [];
      for (const finding of found) {
        const entry = accepted.find(({ id }) => finding.ids.includes(id));
        if (entry !== undefined) repoRows.push(`- ${finding.row(entry.reason)}`);
        else if (finding.blocks) refusals.push(`  ${prefix}${finding.line}`);
        else repoRows.push(`- ${finding.row()}`);
      }
      repoRows.push(...osv.licences.map((row) => `- ${row}`));
      if (repoRows.length > 0) rows.set(repo, repoRows);
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  if (refusals.length > 0)
    throw new ArkError(
      `refused: security scan found ${refusals.length} problem${refusals.length === 1 ? "" : "s"}\n${refusals.join("\n")}\nfix it, or list its id in security.accepted of ark.yml with a reason`,
    );
  return rows;
}
