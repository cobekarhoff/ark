import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { arch, release, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { TestCase } from "./parsers/bun-test";
import { changedTestFiles, git, gitRaw, loadRepo, parsers, type RepoConfig, type Suite, suiteTestFiles } from "./repo";
import { open, record } from "./run";

type SuiteTestCase = Omit<TestCase, "status"> & { suite: string; status: TestCase["status"] | "flaky" };
type Fingerprint = { git_sha: string; base_sha?: string; bun: string; os: string; images: { suite: string; out: string; exit: number; output: string }[] };

const bad = (status: string) => status === "failure" || status === "error";
const key = (testCase: TestCase) => [testCase.file, testCase.classname, testCase.name, testCase.line].join("\0");
const label = (testCase: TestCase) => [testCase.file, testCase.classname, testCase.name].filter(Boolean).join(" > ");

// What a suite may inherit from the caller: nothing that could make a test pass on this machine and not on the recorded SHA.
// The suite's own variables come from `env.vars` in .ark/repo.yml (as committed at base_sha); ARK_OUT is always ours.
const INHERITED = ["PATH", "HOME", "TMPDIR", "LANG"];
const suiteEnvironment = (outputDirectory: string, environmentVariables: Record<string, string> = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter((environmentEntry): environmentEntry is [string, string] => environmentEntry[1] !== undefined && (INHERITED.includes(environmentEntry[0]) || environmentEntry[0].startsWith("LC_")))),
  ...environmentVariables,
  ARK_OUT: outputDirectory,
});

// Runs a shell command in cwd with that environment; stdout and stderr land in <out>/<log>.{stdout,stderr}.log.
function runShell(command: string, cwd: string, outputDirectory: string, log: string, environmentVariables?: Record<string, string>): number {
  mkdirSync(outputDirectory, { recursive: true });
  const subprocessResult = Bun.spawnSync(["sh", "-c", command], { cwd, env: suiteEnvironment(outputDirectory, environmentVariables) });
  writeFileSync(join(outputDirectory, `${log}.stdout.log`), subprocessResult.stdout);
  writeFileSync(join(outputDirectory, `${log}.stderr.log`), subprocessResult.stderr);
  return subprocessResult.exitCode;
}

// ponytail: the glob may only be in the last path segment of `junit`; widen if a runner needs more.
// `cases`: every test tagged with a selected AC, skipped ones included (a skipped test is "selected, not run", which red-green must tell from "no record").
// `tags`: every AC-shaped ID in the report, so trace-check can spot a typo'd tag no selected AC reaches.
function readJunit(suite: Suite, outputDirectory: string, ids: string[]): { cases: TestCase[]; tags: string[] } {
  const pattern = suite.junit.replace(/\$\{?ARK_OUT\}?/g, outputDirectory);
  const files = [...new Bun.Glob(basename(pattern)).scanSync({ cwd: dirname(pattern), absolute: true })].sort();
  const all = files.flatMap((f) => parsers[suite.format].parse(readFileSync(f, "utf8")));
  return {
    cases: all.filter((testCase) => testCase.acs.some((criterionId) => ids.includes(criterionId))),
    tags: all.flatMap((testCase) => testCase.acs),
  };
}

function runOnce(name: string, suite: Suite, cwd: string, outputDirectory: string, ids: string[]) {
  const exit = runShell(suite.run.replaceAll("{tags}", parsers[suite.format].tags(ids)), cwd, outputDirectory, name, suite.env?.vars);
  return { exit, ...readJunit(suite, outputDirectory, ids) };
}

// env.up, run, (on head) rerun each failing test once, env.down: down always runs.
function runSuite(name: string, suite: Suite, cwd: string, outputDirectory: string, ids: string[], rerun: boolean, fingerprint: Fingerprint) {
  try {
    if (suite.env?.up && runShell(suite.env.up, cwd, outputDirectory, `${name}.env-up`, suite.env.vars) !== 0) throw new Error(`suite '${name}': env.up failed, see ${outputDirectory}/${name}.env-up.stderr.log`);
    if (suite.env?.up || suite.env?.down) {
      let imagesResult = { exit: -1, output: "" };
      try {
        const subprocess = Bun.spawnSync(["docker", "compose", "images", "--format", "json"], { cwd, env: suiteEnvironment(outputDirectory, suite.env.vars) });
        imagesResult = { exit: subprocess.exitCode, output: (subprocess.stdout.toString() || subprocess.stderr.toString()).trim() };
      } catch (error) { imagesResult.output = (error as Error).message; }
      fingerprint.images.push({ suite: name, out: outputDirectory, ...imagesResult });
    }
    const first = runOnce(name, suite, cwd, outputDirectory, ids);
    const failing = first.cases.filter((testCase) => bad(testCase.status));
    const again = failing.length
      ? new Map(rerun ? runOnce(name, suite, cwd, join(outputDirectory, "rerun"), [...new Set(failing.flatMap((testCase) => testCase.acs.filter((criterionId) => ids.includes(criterionId))))]).cases.map((testCase) => [key(testCase), testCase]) : [])
      : new Map<string, TestCase>();
    const cases: SuiteTestCase[] = first.cases.map((testCase) => ({ ...testCase, suite: name, status: bad(testCase.status) && again.get(key(testCase))?.status === "pass" ? "flaky" : testCase.status }));
    return { exit: first.exit, cases, tags: first.tags };
  } finally {
    if (suite.env?.down) runShell(suite.env.down, cwd, outputDirectory, `${name}.env-down`, suite.env.vars);
  }
}

// Every suite runs for every selection (selecting by tag text in the files would miss a test whose name is built at run time), and each must exit 0
// and, for each selected AC its files statically carry, report a record in its own JUnit (`silent`: it did not, e.g. a command that runs nothing).
// No runner output is read to excuse a non-zero exit: a suite's `run` is a shell command, and nothing in its output says which step failed.
// `tags` also holds every tag found in the suites' files, so a mistyped tag in a suite that holds no selected AC still reaches trace-check.
function tagged(repoConfig: RepoConfig, cwd: string, outputDirectory: string, ids: string[], rerun: boolean, fingerprint: Fingerprint) {
  const runs = Object.entries(repoConfig.suites).map(([name, suite]) => ({
    name,
    held: [...new Set(suiteTestFiles(suite, cwd).flatMap((f) => parsers[suite.format].tagsIn(readFileSync(join(cwd, f), "utf8"))))],
    ...runSuite(name, suite, cwd, outputDirectory, ids, rerun, fingerprint),
  }));
  const silent = runs.flatMap((runResult) => runResult.held.filter((tag) => ids.includes(tag) && !runResult.cases.some((testCase) => testCase.acs.includes(tag))).map((criterionId) => ({ suite: runResult.name, criterionId })));
  return {
    cases: runs.flatMap((runResult) => runResult.cases),
    tags: [...runs.flatMap((runResult) => runResult.tags), ...runs.flatMap((runResult) => runResult.held)],
    exits: Object.fromEntries(runs.map((runResult) => [runResult.name, runResult.exit])),
    silent,
  };
}

function prepare(runId: string, type: string, ids: string[], repositoryName?: string, role?: "validator") {
  const { directory, state } = open(runId, type, "test");
  const unknown = ids.filter((id) => !(id in state.acs));
  if (!ids.length || unknown.length) throw new Error(`--criteria must name acceptance criteria of this run${unknown.length ? `; unknown: ${unknown.join(", ")}` : ""}`);
  const repository = repositoryName ? state.repos.find((runResult) => runResult.name === repositoryName) : state.repos.length === 1 ? state.repos[0] : undefined;
  if (!repository) throw new Error(`pick a worktree with --repo <name> (have: ${state.repos.map((runResult) => runResult.name).join(", ") || "none, run ark worktree create"})`);
  const pending = state.repos.filter((runResult) => runResult.step !== "implemented").map((runResult) => runResult.name);
  if (type !== "test.result" && pending.length) throw new Error(`${type === "test.red_green" ? "red-green" : "preservation"} runs only after every repo is implemented; no implementer.completed yet for: ${pending.join(", ")}`);

  const worktree = join(directory, "worktrees", repository.name);
  if (git(worktree, "status", "--porcelain", "--untracked-files=no")) throw new Error(`${worktree} has uncommitted changes; commit them so the run proves a commit hash`);
  const head = git(worktree, "rev-parse", "HEAD");
  const repoConfig = loadRepo(worktree, repository.base_sha); // suite commands and test globs as committed at base_sha: the implementer cannot edit its own proof rules
  for (const [name, suite] of Object.entries(repoConfig.suites)) {
    const problem = parsers[suite.format].runProblem(suite.run);
    if (problem) throw new Error(`suite '${name}': ${problem}`);
  }
  const root = join(directory, "artifacts", "test");
  mkdirSync(root, { recursive: true });
  const attempt = Math.max(0, ...readdirSync(root).map(Number).filter(Number.isInteger)) + 1;
  const outputDirectory = join(root, String(attempt));
  mkdirSync(outputDirectory);
  const fingerprint: Fingerprint = { git_sha: head, bun: Bun.version, os: `${process.platform} ${release()} ${arch()}`, images: [] };
  const unknownTags = (tags: string[]) => [...new Set(tags)].filter((tag) => tag.startsWith(`${state.ticket}-AC`) && !(tag in state.acs)).sort();
  return { directory, repo: repository, worktree, head, unknownTags, attempt, out: outputDirectory, fingerprint, repoConfig, where: relative(directory, outputDirectory), stamp: role ? { role } : {} }; // `role` is recorded: only a validator step vouches for tagged-test commits (cli/run.ts unattributed)
}

const finish = (ok: boolean, text: string) => {
  process.exitCode = ok ? 0 : 1;
  return text;
};

export type TestMode = "green" | "red-green" | "preservation";

// `role: "validator"` marks the run as a validator step. A plain run proves its result and records it, but never vouches for AC-tagged test commits.
export function runTest(runId: string, ids: string[], repositoryName: string | undefined, mode: TestMode, role?: string): string {
  if (role !== undefined && role !== "validator") throw new Error(`--as takes 'validator', not '${role}'`);
  return mode === "green" ? proveGreen(runId, ids, repositoryName, role) : proveBoth(runId, ids, repositoryName, mode, role);
}

// Why a run proves nothing: a symlink of the recorded tree reaches outside its checkout.
class Refused extends Error {}

// Writes the blobs of `sha` (all of them, or only `only`) into `destination` straight from the object database, so no smudge or eol filter,
// attribute, hook or submodule can change what the tests see. Returns the symlinks (by path) whose target leaves `destination`.
function materialize(worktree: string, sha: string, destination: string, only?: string[]): string[] {
  let entries = gitRaw(worktree, "ls-tree", "-r", "-z", "--full-tree", sha).split("\0").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t");
    const [mode, , oid] = line.slice(0, tab).split(" ");
    return { mode, oid, path: line.slice(tab + 1) };
  });
  // Fail closed: a submodule's files are not in this tree, yet bun in the worktree would run them. Not materialized (yet).
  const gitlinks = entries.filter((entry) => entry.mode === "160000").map((entry) => entry.path);
  if (!only && gitlinks.length) throw new Refused(`submodules are not supported by ark test yet: ${gitlinks.join(", ")}`);
  entries = entries.filter((entry) => !only || only.includes(entry.path));
  const blobContents = Bun.spawnSync(["git", "-C", worktree, "cat-file", "--batch"], { stdin: Buffer.from(`${entries.map((entry) => entry.oid).join("\n")}\n`) });
  if (blobContents.exitCode !== 0) throw new Error(`git cat-file failed in ${worktree}: ${blobContents.stderr.toString().trim()}`);
  const destinationRoot = realpathSync(destination);
  const links: string[] = [];
  let offset = 0;
  for (const entry of entries) {
    const newlineOffset = blobContents.stdout.indexOf(10, offset);
    const size = Number(blobContents.stdout.subarray(offset, newlineOffset).toString().split(" ")[2]);
    const body = blobContents.stdout.subarray(newlineOffset + 1, newlineOffset + 1 + size);
    offset = newlineOffset + 1 + size + 1;
    const file = join(destinationRoot, entry.path);
    if (relative(destinationRoot, file).startsWith("..")) throw new Refused(`${entry.path} leaves the checkout`);
    mkdirSync(dirname(file), { recursive: true });
    // An overlay path may run through a symlink of the base tree: never write through one.
    if (only && relative(destinationRoot, realpathSync(dirname(file))).startsWith("..")) throw new Refused(`${entry.path} would be written through a symlink out of the checkout`);
    rmSync(file, { recursive: true, force: true });
    if (entry.mode === "120000") {
      symlinkSync(body.toString(), file);
      links.push(entry.path);
    } else {
      writeFileSync(file, body);
      chmodSync(file, entry.mode === "100755" ? 0o755 : 0o644);
    }
  }
  return links.filter((link) => {
    const file = join(destinationRoot, link);
    const target = readlinkSync(file);
    if (relative(destinationRoot, resolve(dirname(file), target)).startsWith("..")) return true;
    try { return relative(destinationRoot, realpathSync(file)).startsWith(".."); } catch { return false; } // dangling inside the checkout reads nothing
  });
}

// Runs `operation` in a clean temporary copy of `sha`, so neither uncommitted nor untracked files of the agent's worktree take part in the proof.
// `overlay`: files to take from `from` (red: the head's test files on the base source). `commands.build` runs first (dependencies are not checked in).
function inCheckout<T>(worktree: string, sha: string, repoConfig: RepoConfig, outputDirectory: string, where: string, operation: (directory: string) => T, overlay: string[] = [], from = sha): T {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ark-proof-"));
  try {
    const links = [...materialize(worktree, sha, temporaryDirectory), ...(overlay.length ? materialize(worktree, from, temporaryDirectory, overlay) : [])];
    if (links.length) throw new Refused(`symlink${links.length > 1 ? "s" : ""} to a path outside the checkout: ${[...new Set(links)].sort().join(", ")}`);
    if (repoConfig.commands?.build && runShell(repoConfig.commands.build, temporaryDirectory, outputDirectory, "build") !== 0) throw new Error(`commands.build failed in the checkout of ${sha.slice(0, 12)}, see ${join(where, "build.stderr.log")}`);
    return operation(temporaryDirectory);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

// Records a run that cannot prove anything (every selected AC inconclusive, with the reason) and fails.
function refused(directory: string, type: string, ids: string[], reason: string, extra: Record<string, unknown>, text: string): string {
  const criteriaOutcomes = Object.fromEntries(ids.map((id) => [id, "inconclusive"]));
  record(directory, type, { ...extra, acs: criteriaOutcomes, tests: [], reason, unknown_tags: [], ...(type !== "test.result" ? { ok: false } : {}) });
  return finish(false, `${text}${ids.map((id) => `${id}: inconclusive\n`).join("")}  ${reason}\n`);
}

function proveGreen(runId: string, ids: string[], repositoryName?: string, role?: "validator"): string {
  const { directory, repo: repository, worktree, head, attempt, out: outputDirectory, fingerprint, repoConfig, where, unknownTags, stamp } = prepare(runId, "test.result", ids, repositoryName, role);
  let result;
  try {
    result = inCheckout(worktree, head, repoConfig, outputDirectory, where, (checkoutDirectory) => tagged(repoConfig, checkoutDirectory, outputDirectory, ids, true, fingerprint));
  } catch (error) {
    if (error instanceof Refused) return refused(directory, "test.result", ids, error.message, { repo: repository.name, head_sha: head, attempt, out: where, ...stamp }, `test attempt ${attempt} on ${head.slice(0, 12)}\n`);
    throw error;
  } finally { writeFileSync(join(outputDirectory, "fingerprint.json"), `${JSON.stringify(fingerprint, null, 2)}\n`); }
  const cases = result.cases.filter((testCase) => testCase.status !== "skipped");
  const criteriaOutcomes = Object.fromEntries(ids.map((id) => {
    const selectedTests = cases.filter((testCase) => testCase.acs.includes(id));
    return [id, result.silent.some((missingRecord) => missingRecord.criterionId === id) ? "fail" : !selectedTests.length ? "missing" : selectedTests.some((testCase) => bad(testCase.status)) ? "fail" : selectedTests.some((testCase) => testCase.status === "flaky") ? "flaky" : broken(result) ? "fail" : "pass"];
  }));
  const tests = cases.map((testCase) => ({ suite: testCase.suite, test: label(testCase), acs: testCase.acs, status: testCase.status }));
  record(directory, "test.result", { repo: repository.name, head_sha: head, attempt, out: where, acs: criteriaOutcomes, tests, exits: result.exits, unknown_tags: unknownTags(result.tags), ...stamp });
  return finish(Object.values(criteriaOutcomes).every((outcome) => outcome === "pass"), `test attempt ${attempt} on ${head.slice(0, 12)}\n${Object.entries(criteriaOutcomes).map(([id, outcome]) => `${id}: ${outcome}\n`).join("")}${exitNote(result)}`);
}

// A suite that exits non-zero without a failing selected test broke somewhere the tags do not show: a file that fails to load, a runner that never started, a failing step.
// ponytail: when a selected test also failed, the exit code is not told apart from that failure; per-file results would be needed.
type TestRun = { cases: SuiteTestCase[]; exits: Record<string, number>; silent: { suite: string; criterionId: string }[] };
const brokenSuites = (runResult: TestRun) =>
  Object.entries(runResult.exits).filter(([suiteName, exitCode]) => exitCode && !runResult.cases.some((testCase) => testCase.suite === suiteName && (bad(testCase.status) || testCase.status === "flaky"))).map(([suiteName]) => suiteName);
const broken = (runResult: TestRun) => brokenSuites(runResult).length > 0;
const silentSuites = (runResult: TestRun) => [...new Set(runResult.silent.map((missingRecord) => missingRecord.suite))];
const exitNote = (runResult: TestRun, side = "") =>
  brokenSuites(runResult).map((suiteName) => `suite '${suiteName}' exited ${runResult.exits[suiteName]}${side} with no failing selected test\n`).join("") +
  silentSuites(runResult).map((suiteName) => `suite '${suiteName}' holds tagged tests for ${runResult.silent.filter((missingRecord) => missingRecord.suite === suiteName).map((missingRecord) => missingRecord.criterionId).join(", ")} but reported none${side}\n`).join("");

// Per AC, over every selected test (identified by suite, file, describe path, name and line, on either side):
// red-green: a test passing on red is `no-red`, even when it is skipped (or absent) on green; `proven` needs every selected test to fail or error on red AND pass on green.
// preservation: a test failing or erroring on base is `not-preserved` (the behavior was not there before: the AC is new); `preserved` needs every selected test to pass on base AND on head.
// Either way a test failing or erroring on green is `green-failed`, and anything else (no record on a side, skipped on either side) is `inconclusive`.
function verdict(id: string, red: Map<string, SuiteTestCase["status"]>, green: Map<string, SuiteTestCase["status"]>, criteriaByTest: Map<string, string[]>, ambiguous: Set<string>, preservation: boolean): string {
  const mine = [...criteriaByTest].filter(([, criteriaOutcomes]) => criteriaOutcomes.includes(id)).map(([testKey]) => testKey);
  if (!mine.length) return "missing";
  const [runResult, greenStatuses] = [red, green].map((statuses) => mine.map((testKey) => statuses.get(testKey) ?? "missing"));
  if (greenStatuses.some((status) => status !== "pass" && status !== "skipped" && status !== "missing")) return "green-failed";
  if (runResult.some((status) => (preservation ? bad(status) : status === "pass"))) return preservation ? "not-preserved" : "no-red";
  if (!greenStatuses.includes("pass")) return "missing";
  if (mine.some((testKey) => ambiguous.has(testKey))) return "inconclusive";
  return mine.every((_, i) => (preservation ? runResult[i] === "pass" : bad(runResult[i])) && greenStatuses[i] === "pass") ? (preservation ? "preserved" : "proven") : "inconclusive";
}

// Red-green proves a new-behavior AC (fails on base, passes on head); preservation proves a preserved-behavior AC (passes on base and on head). Both run the head's tests on the base source, then on head.
function proveBoth(runId: string, ids: string[], repositoryName: string | undefined, mode: "red-green" | "preservation", role?: "validator"): string {
  const preservation = mode === "preservation";
  const type = preservation ? "test.preservation" : "test.red_green";
  const { directory, repo: repository, worktree, head, attempt, out: outputDirectory, fingerprint, repoConfig, where, unknownTags, stamp } = prepare(runId, type, ids, repositoryName, role);
  fingerprint.base_sha = repository.base_sha;
  const overlay = changedTestFiles(worktree, repository.base_sha, repoConfig, head);
  let red, green;
  try {
    red = inCheckout(worktree, repository.base_sha, repoConfig, join(outputDirectory, "red"), join(where, "red"), (checkoutDirectory) => tagged(repoConfig, checkoutDirectory, join(outputDirectory, "red"), ids, false, fingerprint), overlay, head);
    green = inCheckout(worktree, head, repoConfig, join(outputDirectory, "green"), join(where, "green"), (checkoutDirectory) => tagged(repoConfig, checkoutDirectory, join(outputDirectory, "green"), ids, true, fingerprint));
  } catch (error) {
    if (error instanceof Refused) return refused(directory, type, ids, error.message, { repo: repository.name, base_sha: repository.base_sha, head_sha: head, attempt, out: where, overlay, ...stamp }, `${mode} attempt ${attempt}: base ${repository.base_sha.slice(0, 12)} head ${head.slice(0, 12)}\n`);
    throw error;
  } finally {
    writeFileSync(join(outputDirectory, "fingerprint.json"), `${JSON.stringify(fingerprint, null, 2)}\n`);
  }

  const id = (testCase: SuiteTestCase) => `${testCase.suite}\0${key(testCase)}`;
  const [redOf, greenOf] = [red, green].map((runResult) => new Map(runResult.cases.map((testCase) => [id(testCase), testCase.status])));
  const duplicates = (runResult: typeof red) => runResult.cases.map(id).filter((testKey, i, all) => all.indexOf(testKey) !== i); // identical identity twice in one report: results cannot be told apart
  const ambiguous = new Set([...duplicates(red), ...duplicates(green)]);
  const byId = new Map([...green.cases, ...red.cases].map((testCase) => [id(testCase), testCase]));
  const tests = [...byId.values()].map((testCase) => ({ suite: testCase.suite, test: label(testCase), line: testCase.line, acs: testCase.acs, red: redOf.get(id(testCase)) ?? "missing", green: greenOf.get(id(testCase)) ?? "missing" }));
  const criteriaByTest = new Map([...byId].map(([testKey, testCase]) => [testKey, testCase.acs]));
  const [good, off] = preservation ? ["preserved", "not-preserved"] : ["proven", "no-red"];
  const criteriaOutcomes = Object.fromEntries(ids.map((criterionId) => {
    const outcome = verdict(criterionId, redOf, greenOf, criteriaByTest, ambiguous, preservation);
    const silent = (runResult: TestRun) => runResult.silent.some((missingRecord) => missingRecord.criterionId === criterionId);
    if (silent(green) || (outcome === good && broken(green))) return [criterionId, "green-failed"];
    return [criterionId, (outcome === good && broken(red)) || (outcome !== off && silent(red)) ? "inconclusive" : outcome];
  }));
  const ok = Object.values(criteriaOutcomes).every((outcome) => outcome === good);
  record(directory, type, { repo: repository.name, base_sha: repository.base_sha, head_sha: head, attempt, out: where, overlay, acs: criteriaOutcomes, tests, ambiguous: [...ambiguous].map((testKey) => testKey.replaceAll("\0", " > ")), exits: { red: red.exits, green: green.exits }, unknown_tags: unknownTags(green.tags), ok, ...stamp });
  return finish(ok, `${mode} attempt ${attempt}: base ${repository.base_sha.slice(0, 12)} head ${head.slice(0, 12)}\n${Object.entries(criteriaOutcomes).map(([id, outcome]) => `${id}: ${outcome}\n`).join("")}${tests.map((testCase) => `  red=${testCase.red} green=${testCase.green}  ${testCase.test}\n`).join("")}${[...ambiguous].map((testKey) => `  ambiguous duplicate test identity: ${testKey.replaceAll("\0", " > ")}\n`).join("")}${exitNote(red, " on red")}${exitNote(green)}`);
}
