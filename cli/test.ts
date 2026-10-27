import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { arch, release, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { Case } from "./parsers/bun-test";
import { changedTestFiles, git, gitRaw, loadRepo, parsers, type RepoConfig, type Suite, suiteTestFiles } from "./repo";
import { open, record } from "./run";

type Tc = Omit<Case, "status"> & { suite: string; status: Case["status"] | "flaky" };
type Fp = { git_sha: string; base_sha?: string; bun: string; os: string; images: { suite: string; out: string; exit: number; output: string }[] };

const bad = (s: string) => s === "failure" || s === "error";
const key = (c: Case) => [c.file, c.classname, c.name, c.line].join("\0");
const label = (c: Case) => [c.file, c.classname, c.name].filter(Boolean).join(" > ");

// What a suite may inherit from the caller: nothing that could make a test pass on this machine and not on the recorded SHA.
// The suite's own variables come from `env.vars` in .ark/repo.yml (as committed at base_sha); ARK_OUT is always ours.
const INHERITED = ["PATH", "HOME", "TMPDIR", "LANG"];
const suiteEnv = (out: string, vars: Record<string, string> = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && (INHERITED.includes(e[0]) || e[0].startsWith("LC_")))),
  ...vars,
  ARK_OUT: out,
});

// Runs a shell command in cwd with that environment; stdout and stderr land in <out>/<log>.{stdout,stderr}.log.
function sh(cmd: string, cwd: string, out: string, log: string, vars?: Record<string, string>): number {
  mkdirSync(out, { recursive: true });
  const r = Bun.spawnSync(["sh", "-c", cmd], { cwd, env: suiteEnv(out, vars) });
  writeFileSync(join(out, `${log}.stdout.log`), r.stdout);
  writeFileSync(join(out, `${log}.stderr.log`), r.stderr);
  return r.exitCode;
}

// ponytail: the glob may only be in the last path segment of `junit`; widen if a runner needs more.
// `cases`: every test tagged with a selected AC, skipped ones included (a skipped test is "selected, not run", which red-green must tell from "no record").
// `tags`: every AC-shaped ID in the report, so trace-check can spot a typo'd tag no selected AC reaches.
function readJunit(s: Suite, out: string, ids: string[]): { cases: Case[]; tags: string[] } {
  const pat = s.junit.replace(/\$\{?ARK_OUT\}?/g, out);
  const files = [...new Bun.Glob(basename(pat)).scanSync({ cwd: dirname(pat), absolute: true })].sort();
  const all = files.flatMap((f) => parsers[s.format].parse(readFileSync(f, "utf8")));
  return {
    cases: all.filter((c) => c.acs.some((a) => ids.includes(a))),
    tags: all.flatMap((c) => c.acs),
  };
}

function runOnce(name: string, s: Suite, cwd: string, out: string, ids: string[]) {
  const exit = sh(s.run.replaceAll("{tags}", parsers[s.format].tags(ids)), cwd, out, name, s.env?.vars);
  return { exit, ...readJunit(s, out, ids) };
}

// env.up, run, (on head) rerun each failing test once, env.down: down always runs.
function runSuite(name: string, s: Suite, cwd: string, out: string, ids: string[], rerun: boolean, fp: Fp) {
  try {
    if (s.env?.up && sh(s.env.up, cwd, out, `${name}.env-up`, s.env.vars) !== 0) throw new Error(`suite '${name}': env.up failed, see ${out}/${name}.env-up.stderr.log`);
    if (s.env?.up || s.env?.down) {
      let r = { exit: -1, output: "" };
      try {
        const p = Bun.spawnSync(["docker", "compose", "images", "--format", "json"], { cwd, env: suiteEnv(out, s.env.vars) });
        r = { exit: p.exitCode, output: (p.stdout.toString() || p.stderr.toString()).trim() };
      } catch (e) { r.output = (e as Error).message; }
      fp.images.push({ suite: name, out, ...r });
    }
    const first = runOnce(name, s, cwd, out, ids);
    const failing = first.cases.filter((c) => bad(c.status));
    const again = failing.length
      ? new Map(rerun ? runOnce(name, s, cwd, join(out, "rerun"), [...new Set(failing.flatMap((c) => c.acs.filter((a) => ids.includes(a))))]).cases.map((c) => [key(c), c]) : [])
      : new Map<string, Case>();
    const cases: Tc[] = first.cases.map((c) => ({ ...c, suite: name, status: bad(c.status) && again.get(key(c))?.status === "pass" ? "flaky" : c.status }));
    return { exit: first.exit, cases, tags: first.tags };
  } finally {
    if (s.env?.down) sh(s.env.down, cwd, out, `${name}.env-down`, s.env.vars);
  }
}

// Every suite runs for every selection (selecting by tag text in the files would miss a test whose name is built at run time), and each must exit 0
// and, for each selected AC its files statically carry, report a record in its own JUnit (`silent`: it did not, e.g. a command that runs nothing).
// No runner output is read to excuse a non-zero exit: a suite's `run` is a shell command, and nothing in its output says which step failed.
// `tags` also holds every tag found in the suites' files, so a mistyped tag in a suite that holds no selected AC still reaches trace-check.
function tagged(cfg: RepoConfig, cwd: string, out: string, ids: string[], rerun: boolean, fp: Fp) {
  const runs = Object.entries(cfg.suites).map(([name, s]) => ({
    name,
    held: [...new Set(suiteTestFiles(s, cwd).flatMap((f) => parsers[s.format].tagsIn(readFileSync(join(cwd, f), "utf8"))))],
    ...runSuite(name, s, cwd, out, ids, rerun, fp),
  }));
  const silent = runs.flatMap((r) => r.held.filter((t) => ids.includes(t) && !r.cases.some((c) => c.acs.includes(t))).map((ac) => ({ suite: r.name, ac })));
  return {
    cases: runs.flatMap((r) => r.cases),
    tags: [...runs.flatMap((r) => r.tags), ...runs.flatMap((r) => r.held)],
    exits: Object.fromEntries(runs.map((r) => [r.name, r.exit])),
    silent,
  };
}

function prepare(runId: string, type: string, ids: string[], repoName?: string, role?: "validator") {
  const { dir, state } = open(runId, type, "test");
  const unknown = ids.filter((id) => !(id in state.acs));
  if (!ids.length || unknown.length) throw new Error(`--acs must name ACs of this run${unknown.length ? `; unknown: ${unknown.join(", ")}` : ""}`);
  const repo = repoName ? state.repos.find((r) => r.name === repoName) : state.repos.length === 1 ? state.repos[0] : undefined;
  if (!repo) throw new Error(`pick a worktree with --repo <name> (have: ${state.repos.map((r) => r.name).join(", ") || "none, run ark ws create"})`);
  const pending = state.repos.filter((r) => r.step !== "implemented").map((r) => r.name);
  if (type !== "test.result" && pending.length) throw new Error(`${type === "test.red_green" ? "red-green" : "preservation"} runs only after every repo is implemented; no implementer.completed yet for: ${pending.join(", ")}`);

  const wt = join(dir, "ws", repo.name);
  if (git(wt, "status", "--porcelain", "--untracked-files=no")) throw new Error(`${wt} has uncommitted changes; commit them so the run proves a SHA`);
  const head = git(wt, "rev-parse", "HEAD");
  const cfg = loadRepo(wt, repo.base_sha); // suite commands and test globs as committed at base_sha: the implementer cannot edit its own proof rules
  for (const [name, suite] of Object.entries(cfg.suites)) {
    const problem = parsers[suite.format].runProblem(suite.run);
    if (problem) throw new Error(`suite '${name}': ${problem}`);
  }
  const root = join(dir, "artifacts", "test");
  mkdirSync(root, { recursive: true });
  const attempt = Math.max(0, ...readdirSync(root).map(Number).filter(Number.isInteger)) + 1;
  const out = join(root, String(attempt));
  mkdirSync(out);
  const fp: Fp = { git_sha: head, bun: Bun.version, os: `${process.platform} ${release()} ${arch()}`, images: [] };
  const unknownTags = (tags: string[]) => [...new Set(tags)].filter((t) => t.startsWith(`${state.ticket}-AC`) && !(t in state.acs)).sort();
  return { dir, repo, wt, head, unknownTags, attempt, out, fp, cfg, where: relative(dir, out), stamp: role ? { role } : {} }; // `role` is recorded: only a validator step vouches for tagged-test commits (cli/run.ts unattributed)
}

const finish = (ok: boolean, text: string) => {
  process.exitCode = ok ? 0 : 1;
  return text;
};

export type TestMode = "green" | "red-green" | "preservation";

// `role: "validator"` marks the run as a validator step. A plain run proves its result and records it, but never vouches for AC-tagged test commits.
export function runTest(runId: string, ids: string[], repoName: string | undefined, mode: TestMode, role?: string): string {
  if (role !== undefined && role !== "validator") throw new Error(`--as takes 'validator', not '${role}'`);
  return mode === "green" ? proveGreen(runId, ids, repoName, role) : proveBoth(runId, ids, repoName, mode, role);
}

// Why a run proves nothing: a symlink of the recorded tree reaches outside its checkout.
class Refused extends Error {}

// Writes the blobs of `sha` (all of them, or only `only`) into `dest` straight from the object database, so no smudge or eol filter,
// attribute, hook or submodule can change what the tests see. Returns the symlinks (by path) whose target leaves `dest`.
function materialize(wt: string, sha: string, dest: string, only?: string[]): string[] {
  let entries = gitRaw(wt, "ls-tree", "-r", "-z", "--full-tree", sha).split("\0").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t");
    const [mode, , oid] = line.slice(0, tab).split(" ");
    return { mode, oid, path: line.slice(tab + 1) };
  });
  // Fail closed: a submodule's files are not in this tree, yet bun in the worktree would run them. Not materialized (yet).
  const gitlinks = entries.filter((e) => e.mode === "160000").map((e) => e.path);
  if (!only && gitlinks.length) throw new Refused(`submodules are not supported by ark test yet: ${gitlinks.join(", ")}`);
  entries = entries.filter((e) => !only || only.includes(e.path));
  const cat = Bun.spawnSync(["git", "-C", wt, "cat-file", "--batch"], { stdin: Buffer.from(`${entries.map((e) => e.oid).join("\n")}\n`) });
  if (cat.exitCode !== 0) throw new Error(`git cat-file failed in ${wt}: ${cat.stderr.toString().trim()}`);
  const real = realpathSync(dest);
  const links: string[] = [];
  let at = 0;
  for (const e of entries) {
    const nl = cat.stdout.indexOf(10, at);
    const size = Number(cat.stdout.subarray(at, nl).toString().split(" ")[2]);
    const body = cat.stdout.subarray(nl + 1, nl + 1 + size);
    at = nl + 1 + size + 1;
    const file = join(real, e.path);
    if (relative(real, file).startsWith("..")) throw new Refused(`${e.path} leaves the checkout`);
    mkdirSync(dirname(file), { recursive: true });
    // An overlay path may run through a symlink of the base tree: never write through one.
    if (only && relative(real, realpathSync(dirname(file))).startsWith("..")) throw new Refused(`${e.path} would be written through a symlink out of the checkout`);
    rmSync(file, { recursive: true, force: true });
    if (e.mode === "120000") {
      symlinkSync(body.toString(), file);
      links.push(e.path);
    } else {
      writeFileSync(file, body);
      chmodSync(file, e.mode === "100755" ? 0o755 : 0o644);
    }
  }
  return links.filter((l) => {
    const file = join(real, l);
    const target = readlinkSync(file);
    if (relative(real, resolve(dirname(file), target)).startsWith("..")) return true;
    try { return relative(real, realpathSync(file)).startsWith(".."); } catch { return false; } // dangling inside the checkout reads nothing
  });
}

// Runs `fn` in a clean temporary copy of `sha`, so neither uncommitted nor untracked files of the agent's worktree take part in the proof.
// `overlay`: files to take from `from` (red: the head's test files on the base source). `commands.build` runs first (dependencies are not checked in).
function inCheckout<T>(wt: string, sha: string, cfg: RepoConfig, out: string, where: string, fn: (dir: string) => T, overlay: string[] = [], from = sha): T {
  const tmp = mkdtempSync(join(tmpdir(), "ark-proof-"));
  try {
    const links = [...materialize(wt, sha, tmp), ...(overlay.length ? materialize(wt, from, tmp, overlay) : [])];
    if (links.length) throw new Refused(`symlink${links.length > 1 ? "s" : ""} to a path outside the checkout: ${[...new Set(links)].sort().join(", ")}`);
    if (cfg.commands?.build && sh(cfg.commands.build, tmp, out, "build") !== 0) throw new Error(`commands.build failed in the checkout of ${sha.slice(0, 12)}, see ${join(where, "build.stderr.log")}`);
    return fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Records a run that cannot prove anything (every selected AC inconclusive, with the reason) and fails.
function refused(dir: string, type: string, ids: string[], reason: string, extra: Record<string, unknown>, text: string): string {
  const acs = Object.fromEntries(ids.map((id) => [id, "inconclusive"]));
  record(dir, type, { ...extra, acs, tests: [], reason, unknown_tags: [], ...(type !== "test.result" ? { ok: false } : {}) });
  return finish(false, `${text}${ids.map((id) => `${id}: inconclusive\n`).join("")}  ${reason}\n`);
}

function proveGreen(runId: string, ids: string[], repoName?: string, role?: "validator"): string {
  const { dir, repo, wt, head, attempt, out, fp, cfg, where, unknownTags, stamp } = prepare(runId, "test.result", ids, repoName, role);
  let res;
  try {
    res = inCheckout(wt, head, cfg, out, where, (d) => tagged(cfg, d, out, ids, true, fp));
  } catch (e) {
    if (e instanceof Refused) return refused(dir, "test.result", ids, e.message, { repo: repo.name, head_sha: head, attempt, out: where, ...stamp }, `test attempt ${attempt} on ${head.slice(0, 12)}\n`);
    throw e;
  } finally { writeFileSync(join(out, "fingerprint.json"), `${JSON.stringify(fp, null, 2)}\n`); }
  const cases = res.cases.filter((c) => c.status !== "skipped");
  const acs = Object.fromEntries(ids.map((id) => {
    const ts = cases.filter((c) => c.acs.includes(id));
    return [id, res.silent.some((x) => x.ac === id) ? "fail" : !ts.length ? "missing" : ts.some((c) => bad(c.status)) ? "fail" : ts.some((c) => c.status === "flaky") ? "flaky" : broken(res) ? "fail" : "pass"];
  }));
  const tests = cases.map((c) => ({ suite: c.suite, test: label(c), acs: c.acs, status: c.status }));
  record(dir, "test.result", { repo: repo.name, head_sha: head, attempt, out: where, acs, tests, exits: res.exits, unknown_tags: unknownTags(res.tags), ...stamp });
  return finish(Object.values(acs).every((v) => v === "pass"), `test attempt ${attempt} on ${head.slice(0, 12)}\n${Object.entries(acs).map(([id, v]) => `${id}: ${v}\n`).join("")}${exitNote(res)}`);
}

// A suite that exits non-zero without a failing selected test broke somewhere the tags do not show: a file that fails to load, a runner that never started, a failing step.
// ponytail: when a selected test also failed, the exit code is not told apart from that failure; per-file results would be needed.
type Ran = { cases: Tc[]; exits: Record<string, number>; silent: { suite: string; ac: string }[] };
const brokenSuites = (r: Ran) =>
  Object.entries(r.exits).filter(([s, c]) => c && !r.cases.some((t) => t.suite === s && (bad(t.status) || t.status === "flaky"))).map(([s]) => s);
const broken = (r: Ran) => brokenSuites(r).length > 0;
const silentSuites = (r: Ran) => [...new Set(r.silent.map((x) => x.suite))];
const exitNote = (r: Ran, side = "") =>
  brokenSuites(r).map((s) => `suite '${s}' exited ${r.exits[s]}${side} with no failing selected test\n`).join("") +
  silentSuites(r).map((s) => `suite '${s}' holds tagged tests for ${r.silent.filter((x) => x.suite === s).map((x) => x.ac).join(", ")} but reported none${side}\n`).join("");

// Per AC, over every selected test (identified by suite, file, describe path, name and line, on either side):
// red-green: a test passing on red is `no-red`, even when it is skipped (or absent) on green; `proven` needs every selected test to fail or error on red AND pass on green.
// preservation: a test failing or erroring on base is `not-preserved` (the behavior was not there before: the AC is new); `preserved` needs every selected test to pass on base AND on head.
// Either way a test failing or erroring on green is `green-failed`, and anything else (no record on a side, skipped on either side) is `inconclusive`.
function verdict(id: string, red: Map<string, Tc["status"]>, green: Map<string, Tc["status"]>, acsOf: Map<string, string[]>, ambiguous: Set<string>, preservation: boolean): string {
  const mine = [...acsOf].filter(([, acs]) => acs.includes(id)).map(([k]) => k);
  if (!mine.length) return "missing";
  const [r, g] = [red, green].map((m) => mine.map((k) => m.get(k) ?? "missing"));
  if (g.some((x) => x !== "pass" && x !== "skipped" && x !== "missing")) return "green-failed";
  if (r.some((x) => (preservation ? bad(x) : x === "pass"))) return preservation ? "not-preserved" : "no-red";
  if (!g.includes("pass")) return "missing";
  if (mine.some((k) => ambiguous.has(k))) return "inconclusive";
  return mine.every((_, i) => (preservation ? r[i] === "pass" : bad(r[i])) && g[i] === "pass") ? (preservation ? "preserved" : "proven") : "inconclusive";
}

// Red-green proves a new-behavior AC (fails on base, passes on head); preservation proves a preserved-behavior AC (passes on base and on head). Both run the head's tests on the base source, then on head.
function proveBoth(runId: string, ids: string[], repoName: string | undefined, mode: "red-green" | "preservation", role?: "validator"): string {
  const preservation = mode === "preservation";
  const type = preservation ? "test.preservation" : "test.red_green";
  const { dir, repo, wt, head, attempt, out, fp, cfg, where, unknownTags, stamp } = prepare(runId, type, ids, repoName, role);
  fp.base_sha = repo.base_sha;
  const overlay = changedTestFiles(wt, repo.base_sha, cfg, head);
  let red, green;
  try {
    red = inCheckout(wt, repo.base_sha, cfg, join(out, "red"), join(where, "red"), (d) => tagged(cfg, d, join(out, "red"), ids, false, fp), overlay, head);
    green = inCheckout(wt, head, cfg, join(out, "green"), join(where, "green"), (d) => tagged(cfg, d, join(out, "green"), ids, true, fp));
  } catch (e) {
    if (e instanceof Refused) return refused(dir, type, ids, e.message, { repo: repo.name, base_sha: repo.base_sha, head_sha: head, attempt, out: where, overlay, ...stamp }, `${mode} attempt ${attempt}: base ${repo.base_sha.slice(0, 12)} head ${head.slice(0, 12)}\n`);
    throw e;
  } finally {
    writeFileSync(join(out, "fingerprint.json"), `${JSON.stringify(fp, null, 2)}\n`);
  }

  const id = (c: Tc) => `${c.suite}\0${key(c)}`;
  const [redOf, greenOf] = [red, green].map((r) => new Map(r.cases.map((c) => [id(c), c.status])));
  const dupes = (r: typeof red) => r.cases.map(id).filter((k, i, all) => all.indexOf(k) !== i); // identical identity twice in one report: results cannot be told apart
  const ambiguous = new Set([...dupes(red), ...dupes(green)]);
  const byId = new Map([...green.cases, ...red.cases].map((c) => [id(c), c]));
  const tests = [...byId.values()].map((c) => ({ suite: c.suite, test: label(c), line: c.line, acs: c.acs, red: redOf.get(id(c)) ?? "missing", green: greenOf.get(id(c)) ?? "missing" }));
  const acsOf = new Map([...byId].map(([k, c]) => [k, c.acs]));
  const [good, off] = preservation ? ["preserved", "not-preserved"] : ["proven", "no-red"];
  const acs = Object.fromEntries(ids.map((ac) => {
    const v = verdict(ac, redOf, greenOf, acsOf, ambiguous, preservation);
    const silent = (r: Ran) => r.silent.some((x) => x.ac === ac);
    if (silent(green) || (v === good && broken(green))) return [ac, "green-failed"];
    return [ac, (v === good && broken(red)) || (v !== off && silent(red)) ? "inconclusive" : v];
  }));
  const ok = Object.values(acs).every((v) => v === good);
  record(dir, type, { repo: repo.name, base_sha: repo.base_sha, head_sha: head, attempt, out: where, overlay, acs, tests, ambiguous: [...ambiguous].map((k) => k.replaceAll("\0", " > ")), exits: { red: red.exits, green: green.exits }, unknown_tags: unknownTags(green.tags), ok, ...stamp });
  return finish(ok, `${mode} attempt ${attempt}: base ${repo.base_sha.slice(0, 12)} head ${head.slice(0, 12)}\n${Object.entries(acs).map(([id, v]) => `${id}: ${v}\n`).join("")}${tests.map((t) => `  red=${t.red} green=${t.green}  ${t.test}\n`).join("")}${[...ambiguous].map((k) => `  ambiguous duplicate test identity: ${k.replaceAll("\0", " > ")}\n`).join("")}${exitNote(red, " on red")}${exitNote(green)}`);
}
