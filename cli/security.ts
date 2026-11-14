import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** The packages of one lockfile with their vulnerabilities and licences, or `null` when osv-scanner finds no packages there (exit 128). */
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
  if (exitCode === 128) return null;
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
  // a malicious-package advisory carries no severity label and no score
  if ([vulnerability.id, ...(vulnerability.aliases ?? [])].some((id) => id.startsWith("MAL-")))
    return "CRITICAL";
  // ponytail: any other vulnerability with no label and no score is listed, not blocked; block it if osv data proves too sparse
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

function resolveCommit(path: string, ref: string): string | null {
  const { exitCode, stdout } = spawn(
    ["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    path,
  );
  return exitCode === 0 ? stdout.toString().trim() : null;
}

function revParse(path: string, ref: string): string {
  const { exitCode, stdout, stderr } = spawn(
    ["git", "rev-parse", "--verify", `${ref}^{commit}`],
    path,
  );
  if (exitCode !== 0) throw new ArkError(`git rev-parse ${ref} failed in ${path}: ${tail(stderr)}`);
  return stdout.toString().trim();
}

function gitleaksFindings(path: string, base: string, folder: string): Finding[] {
  const work = mkdtempSync(join(folder, "gitleaks-"));
  const report = join(work, "report.json");
  // A base that is not in the object store (a recorded base of an older clone) scans the whole first-parent history of HEAD.
  const baseCommit = resolveCommit(path, base);
  const headCommit = revParse(path, "HEAD");
  const range = baseCommit === null ? headCommit : `${baseCommit}..${headCommit}`;
  // The run branch must not switch the gate off: no `gitleaks:allow` comment, and the `.gitleaks.toml` of the base (else
  // the defaults) in place of whatever the run committed. gitleaks also reads `.gitleaksignore` and `.gitattributes` (`-diff`,
  // `binary` hide a file from `git log -p`) from the working tree, so it scans a clone with no working tree.
  const config = join(work, "gitleaks.toml");
  const baseConfig = baseCommit === null ? null : gitBlob(path, `${baseCommit}:.gitleaks.toml`);
  writeFileSync(config, baseConfig ?? "[extend]\nuseDefault = true\n");
  const configSource =
    baseConfig === null ? "" : `, config: ${baseCommit!.slice(0, 8)}:.gitleaks.toml`;
  const scratch = join(work, "repo");
  const clone = spawn(["git", "clone", "--shared", "--no-checkout", path, scratch], work);
  if (clone.exitCode !== 0)
    throw new ArkError(`git clone of ${path} for gitleaks failed: ${tail(clone.stderr)}`);
  let exitCode: number;
  let stderr: string;
  try {
    ({ exitCode, stderr } = spawn(
      [
        "gitleaks",
        "git",
        `--log-opts=--first-parent --remerge-diff --text --no-textconv ${range}`,
        "--redact",
        "--no-banner",
        "--ignore-gitleaks-allow",
        "--config",
        config,
        "--report-path",
        report,
      ],
      scratch,
    ));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  let entries: GitleaksEntry[] | undefined;
  try {
    const parsed = JSON.parse(readFileSync(report, "utf8"));
    if (Array.isArray(parsed)) entries = parsed;
  } catch {
    // no report or an unreadable one falls through to the refusal
  }
  // gitleaks exits 1 for a leak and for a crash alike, and exits 0 after an `ERR` of a bad git argument (`--remerge-diff` needs git 2.36).
  const crashed =
    (exitCode !== 0 && exitCode !== 1) ||
    entries === undefined ||
    (exitCode === 1 && entries.length === 0) ||
    (exitCode === 0 && (entries.length > 0 || /\bERR\b/.test(stderr)));
  if (crashed)
    throw new ArkError(
      `gitleaks failed in ${path} (exit ${exitCode}${configSource}): ${tail(stderr) || "no readable report"}`,
    );
  return entries!.map((entry) => {
    // gitleaks keeps the `b/` of a `--remerge-diff` header in the file name
    const where = `${entry.RuleID} in ${entry.File.replace(/^b\//, "")}:${entry.StartLine}`;
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

/** Whether the head has commits past the base; an unknown base counts the whole history, and a failed `git rev-list` refuses, never reads as none. */
function hasCommitsAhead(path: string, base: string): boolean {
  const range = resolveCommit(path, base) === null ? "HEAD" : `${base}..HEAD`;
  const { exitCode, stdout, stderr } = spawn(["git", "rev-list", "--count", range], path);
  if (exitCode !== 0)
    throw new ArkError(`git rev-list ${range} failed in ${path}: ${tail(stderr)}`);
  return Number(stdout) > 0;
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
    // ponytail: a worktree directory that is already gone (a handed_off run whose branch stays in the clone) is not scanned; scan the branch in the clone if that gap matters
    const scanned = repos.filter(
      ({ path, base }) => existsSync(path) && hasCommitsAhead(path, base),
    );
    for (const { repo, path, base } of scanned) {
      const prefix = scanned.length > 1 ? `${repo}: ` : "";
      const osv = osvFindings(path, base, folder);
      const found = [...gitleaksFindings(path, base, folder), ...osv.findings];
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
