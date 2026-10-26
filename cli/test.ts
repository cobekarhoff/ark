import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, release, tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import type { Case } from "./parsers/bun-test";
import { changedTestFiles, git, loadRepo, parsers, type RepoConfig, type Suite } from "./repo";
import { open, record } from "./run";

type Tc = Omit<Case, "status"> & { suite: string; status: Case["status"] | "flaky" };
type Row = { suite: string; c: Tc };
type Fp = { git_sha: string; base_sha?: string; bun: string; os: string; images: { suite: string; out: string; exit: number; output: string }[] };

const bad = (s: string) => s === "failure" || s === "error";
const key = (c: Case) => [c.file, c.classname, c.name].join("\0");
const label = (c: Case) => [c.file, c.classname, c.name].filter(Boolean).join(" > ");

// Runs a shell command in cwd with ARK_OUT set; stdout and stderr land in <out>/<log>.{stdout,stderr}.log.
function sh(cmd: string, cwd: string, out: string, log: string): number {
  mkdirSync(out, { recursive: true });
  const r = Bun.spawnSync(["sh", "-c", cmd], { cwd, env: { ...process.env, ARK_OUT: out } });
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
  const exit = sh(s.run.replaceAll("{tags}", parsers[s.format].tags(ids)), cwd, out, name);
  return { exit, ...readJunit(s, out, ids) };
}

// env.up, run, (on head) rerun each failing test once, env.down: down always runs.
function runSuite(name: string, s: Suite, cwd: string, out: string, ids: string[], rerun: boolean, fp: Fp) {
  try {
    if (s.env?.up && sh(s.env.up, cwd, out, `${name}.env-up`) !== 0) throw new Error(`suite '${name}': env.up failed, see ${out}/${name}.env-up.stderr.log`);
    if (s.env) {
      let r = { exit: -1, output: "" };
      try {
        const p = Bun.spawnSync(["docker", "compose", "images", "--format", "json"], { cwd });
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
    if (s.env?.down) sh(s.env.down, cwd, out, `${name}.env-down`);
  }
}

// ponytail: every suite runs for every AC set; add `collect`-based suite selection when env.up cost bites.
function tagged(cfg: RepoConfig, cwd: string, out: string, ids: string[], rerun: boolean, fp: Fp) {
  const runs = Object.entries(cfg.suites).map(([name, s]) => ({ name, ...runSuite(name, s, cwd, out, ids, rerun, fp) }));
  return { cases: runs.flatMap((r) => r.cases), tags: runs.flatMap((r) => r.tags), exits: Object.fromEntries(runs.map((r) => [r.name, r.exit])) };
}

function prepare(runId: string, type: string, ids: string[], repoName?: string) {
  const { dir, state } = open(runId, type, "test");
  const unknown = ids.filter((id) => !(id in state.acs));
  if (!ids.length || unknown.length) throw new Error(`--acs must name ACs of this run${unknown.length ? `; unknown: ${unknown.join(", ")}` : ""}`);
  const repo = repoName ? state.repos.find((r) => r.name === repoName) : state.repos.length === 1 ? state.repos[0] : undefined;
  if (!repo) throw new Error(`pick a worktree with --repo <name> (have: ${state.repos.map((r) => r.name).join(", ") || "none, run ark ws create"})`);
  const pending = state.repos.filter((r) => r.step !== "implemented").map((r) => r.name);
  if (type === "test.red_green" && pending.length) throw new Error(`red-green runs only after every repo is implemented; no implementer.completed yet for: ${pending.join(", ")}`);

  const wt = join(dir, "ws", repo.name);
  if (git(wt, "status", "--porcelain", "--untracked-files=no")) throw new Error(`${wt} has uncommitted changes; commit them so the run proves a SHA`);
  const head = git(wt, "rev-parse", "HEAD");
  const root = join(dir, "artifacts", "test");
  mkdirSync(root, { recursive: true });
  const attempt = Math.max(0, ...readdirSync(root).map(Number).filter(Number.isInteger)) + 1;
  const out = join(root, String(attempt));
  mkdirSync(out);
  const fp: Fp = { git_sha: head, bun: Bun.version, os: `${process.platform} ${release()} ${arch()}`, images: [] };
  const unknownTags = (tags: string[]) => [...new Set(tags)].filter((t) => t.startsWith(`${state.ticket}-AC`) && !(t in state.acs)).sort();
  return { dir, repo, wt, head, unknownTags, attempt, out, fp, cfg: loadRepo(wt, repo.base_sha), where: relative(dir, out) }; // suite commands and test globs as committed at base_sha: the implementer cannot edit its own proof rules
}

const finish = (ok: boolean, text: string) => {
  process.exitCode = ok ? 0 : 1;
  return text;
};

export function runTest(runId: string, ids: string[], repoName?: string, redGreen = false): string {
  return redGreen ? proveRedGreen(runId, ids, repoName) : proveGreen(runId, ids, repoName);
}

// Runs `fn` in a clean temporary checkout of `sha`, so neither uncommitted nor untracked files of the agent's worktree take part in the proof.
// `overlay`: files to take from `from` (red: the head's test files on the base source). `commands.build` runs first (dependencies are not checked in).
function inCheckout<T>(wt: string, sha: string, cfg: RepoConfig, out: string, where: string, fn: (dir: string) => T, overlay: string[] = [], from = sha): T {
  const tmp = mkdtempSync(join(tmpdir(), "ark-proof-"));
  try {
    git(wt, "worktree", "add", "--detach", tmp, sha);
    if (overlay.length) git(tmp, "checkout", from, "--", ...overlay);
    if (cfg.commands?.build && sh(cfg.commands.build, tmp, out, "build") !== 0) throw new Error(`commands.build failed in the checkout of ${sha.slice(0, 12)}, see ${join(where, "build.stderr.log")}`);
    return fn(tmp);
  } finally {
    Bun.spawnSync(["git", "-C", wt, "worktree", "remove", "--force", tmp]);
    rmSync(tmp, { recursive: true, force: true });
  }
}

function proveGreen(runId: string, ids: string[], repoName?: string): string {
  const { dir, repo, wt, head, attempt, out, fp, cfg, where, unknownTags } = prepare(runId, "test.result", ids, repoName);
  let res;
  try { res = inCheckout(wt, head, cfg, out, where, (d) => tagged(cfg, d, out, ids, true, fp)); } finally { writeFileSync(join(out, "fingerprint.json"), `${JSON.stringify(fp, null, 2)}\n`); }
  const cases = res.cases.filter((c) => c.status !== "skipped");
  const acs = Object.fromEntries(ids.map((id) => {
    const ts = cases.filter((c) => c.acs.includes(id));
    return [id, !ts.length ? "missing" : ts.some((c) => bad(c.status)) ? "fail" : ts.some((c) => c.status === "flaky") ? "flaky" : broken(res) ? "fail" : "pass"];
  }));
  const tests = cases.map((c) => ({ suite: c.suite, test: label(c), acs: c.acs, status: c.status }));
  record(dir, "test.result", { repo: repo.name, head_sha: head, attempt, out: where, acs, tests, exits: res.exits, unknown_tags: unknownTags(res.tags) });
  return finish(Object.values(acs).every((v) => v === "pass"), `test attempt ${attempt} on ${head.slice(0, 12)}\n${Object.entries(acs).map(([id, v]) => `${id}: ${v}\n`).join("")}${exitNote(res)}`);
}

// A suite that exits non-zero while none of its selected tests failed broke somewhere the tags do not show (a file that fails to load).
// ponytail: when a selected test also failed, the exit code is not told apart from that failure; per-file results would be needed.
const brokenSuites = (r: { cases: Tc[]; exits: Record<string, number> }) =>
  Object.entries(r.exits).filter(([s, c]) => c && !r.cases.some((t) => t.suite === s && (bad(t.status) || t.status === "flaky"))).map(([s]) => s);
const broken = (r: Parameters<typeof brokenSuites>[0]) => brokenSuites(r).length > 0;
const exitNote = (r: Parameters<typeof brokenSuites>[0]) => brokenSuites(r).map((s) => `suite '${s}' exited ${r.exits[s]} with no failing selected test\n`).join("");

// Per AC: `proven` needs every passing green test to have a red record that failed or errored; a test passing on red is `no-red`
// even when it is skipped (or absent) on green; a skipped, missing or never-started red is `inconclusive`, never red.
function verdict(id: string, red: Row[], green: Row[]): string {
  const [r, g] = [red, green].map((xs) => xs.filter((x) => x.c.acs.includes(id)));
  if (!r.length && !g.length) return "missing";
  if (g.some((x) => x.c.status !== "pass" && x.c.status !== "skipped")) return "green-failed";
  if (r.some((x) => x.c.status === "pass")) return "no-red";
  const passing = g.filter((x) => x.c.status === "pass");
  if (!passing.length) return "missing";
  return passing.every((p) => r.some((x) => x.suite === p.suite && key(x.c) === key(p.c) && bad(x.c.status))) ? "proven" : "inconclusive";
}

function proveRedGreen(runId: string, ids: string[], repoName?: string): string {
  const { dir, repo, wt, head, attempt, out, fp, cfg, where, unknownTags } = prepare(runId, "test.red_green", ids, repoName);
  fp.base_sha = repo.base_sha;
  const overlay = changedTestFiles(wt, repo.base_sha, cfg);
  let red, green;
  try {
    red = inCheckout(wt, repo.base_sha, cfg, join(out, "red"), join(where, "red"), (d) => tagged(cfg, d, join(out, "red"), ids, false, fp), overlay, head);
    green = inCheckout(wt, head, cfg, join(out, "green"), join(where, "green"), (d) => tagged(cfg, d, join(out, "green"), ids, true, fp));
  } finally {
    writeFileSync(join(out, "fingerprint.json"), `${JSON.stringify(fp, null, 2)}\n`);
  }

  const rows = (r: typeof red): Row[] => r.cases.map((c) => ({ suite: c.suite, c }));
  const [redCases, greenCases] = [rows(red), rows(green)];
  const id = ({ suite, c }: Row) => `${suite}\0${key(c)}`;
  const [redOf, greenOf] = [redCases, greenCases].map((xs) => new Map(xs.map((x) => [id(x), x.c.status])));
  const tests = [...new Map([...greenCases, ...redCases].map((x) => [id(x), x])).values()].map((x) => ({ suite: x.suite, test: label(x.c), acs: x.c.acs, red: redOf.get(id(x)) ?? "missing", green: greenOf.get(id(x)) ?? "missing" }));
  const acs = Object.fromEntries(ids.map((ac) => {
    const v = verdict(ac, redCases, greenCases);
    return [ac, v === "proven" && broken(green) ? "green-failed" : v];
  }));
  const ok = Object.values(acs).every((v) => v === "proven");
  record(dir, "test.red_green", { repo: repo.name, base_sha: repo.base_sha, head_sha: head, attempt, out: where, overlay, acs, tests, exits: { red: red.exits, green: green.exits }, unknown_tags: unknownTags(green.tags), ok });
  return finish(ok, `red-green attempt ${attempt}: base ${repo.base_sha.slice(0, 12)} head ${head.slice(0, 12)}\n${Object.entries(acs).map(([id, v]) => `${id}: ${v}\n`).join("")}${tests.map((t) => `  red=${t.red} green=${t.green}  ${t.test}\n`).join("")}${exitNote(green)}`);
}
