import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, release, tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import type { Case } from "./parsers/bun-test";
import { changedTestFiles, git, loadRepo, parsers, type RepoConfig, type Suite } from "./repo";
import { open, record } from "./run";

type Tc = Omit<Case, "status"> & { suite: string; status: Case["status"] | "flaky" };
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
// `tags`: every AC-shaped ID in the report, skipped tests included, so trace-check can spot a typo'd tag no selected AC reaches.
function readJunit(s: Suite, out: string, ids: string[]): { cases: Case[]; tags: string[] } {
  const pat = s.junit.replace(/\$\{?ARK_OUT\}?/g, out);
  const files = [...new Bun.Glob(basename(pat)).scanSync({ cwd: dirname(pat), absolute: true })].sort();
  const all = files.flatMap((f) => parsers[s.format].parse(readFileSync(f, "utf8")));
  return {
    cases: all.filter((c) => c.status !== "skipped" && c.acs.some((a) => ids.includes(a))), // bun reports every unselected test as skipped
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
  return { dir, repo, wt, head, unknownTags, attempt, out, fp, cfg: loadRepo(wt), where: relative(dir, out) };
}

const finish = (ok: boolean, text: string) => {
  process.exitCode = ok ? 0 : 1;
  return text;
};

export function runTest(runId: string, ids: string[], repoName?: string, redGreen = false): string {
  return redGreen ? proveRedGreen(runId, ids, repoName) : proveGreen(runId, ids, repoName);
}

function proveGreen(runId: string, ids: string[], repoName?: string): string {
  const { dir, repo, wt, head, attempt, out, fp, cfg, where, unknownTags } = prepare(runId, "test.result", ids, repoName);
  let res;
  try { res = tagged(cfg, wt, out, ids, true, fp); } finally { writeFileSync(join(out, "fingerprint.json"), `${JSON.stringify(fp, null, 2)}\n`); }
  const acs = Object.fromEntries(ids.map((id) => {
    const ts = res.cases.filter((c) => c.acs.includes(id));
    return [id, !ts.length ? "missing" : ts.some((c) => bad(c.status)) ? "fail" : ts.some((c) => c.status === "flaky") ? "flaky" : "pass"];
  }));
  const tests = res.cases.map((c) => ({ suite: c.suite, test: label(c), acs: c.acs, status: c.status }));
  record(dir, "test.result", { repo: repo.name, head_sha: head, attempt, out: where, acs, tests, unknown_tags: unknownTags(res.tags) });
  return finish(Object.values(acs).every((v) => v === "pass"), `test attempt ${attempt} on ${head.slice(0, 12)}\n${Object.entries(acs).map(([id, v]) => `${id}: ${v}\n`).join("")}`);
}

function proveRedGreen(runId: string, ids: string[], repoName?: string): string {
  const { dir, repo, wt, head, attempt, out, fp, cfg, where, unknownTags } = prepare(runId, "test.red_green", ids, repoName);
  fp.base_sha = repo.base_sha;
  const overlay = changedTestFiles(wt, repo.base_sha, cfg);
  const tmp = mkdtempSync(join(tmpdir(), "ark-red-"));
  let red, green;
  try {
    git(wt, "worktree", "add", "--detach", tmp, repo.base_sha);
    try {
      if (overlay.length) git(tmp, "checkout", head, "--", ...overlay);
      if (cfg.commands?.build && sh(cfg.commands.build, tmp, join(out, "red"), "build") !== 0) throw new Error(`commands.build failed on the base worktree, see ${join(where, "red", "build.stderr.log")}`);
      red = tagged(cfg, tmp, join(out, "red"), ids, false, fp);
    } finally {
      git(wt, "worktree", "remove", "--force", tmp);
    }
    green = tagged(cfg, wt, join(out, "green"), ids, true, fp);
  } finally {
    writeFileSync(join(out, "fingerprint.json"), `${JSON.stringify(fp, null, 2)}\n`);
  }

  const redOf = new Map(red.cases.map((c) => [`${c.suite}\0${key(c)}`, c.status]));
  const tests = green.cases.map((g) => {
    // A test with no red result errored if its suite exited non-zero (e.g. the file failed to load); otherwise it never ran.
    const r = redOf.get(`${g.suite}\0${key(g)}`) ?? (red.exits[g.suite] !== 0 ? "error" : "missing");
    return { suite: g.suite, test: label(g), acs: g.acs, red: r, green: g.status };
  });
  const acs = Object.fromEntries(ids.map((id) => {
    const ts = tests.filter((t) => t.acs.includes(id));
    return [id, !ts.length ? "missing" : ts.some((t) => t.green !== "pass") ? "green-failed" : ts.some((t) => !bad(t.red)) ? "no-red" : "proven"];
  }));
  const ok = Object.values(acs).every((v) => v === "proven");
  record(dir, "test.red_green", { repo: repo.name, base_sha: repo.base_sha, head_sha: head, attempt, out: where, overlay, acs, tests, unknown_tags: unknownTags(green.tags), ok });
  return finish(ok, `red-green attempt ${attempt}: base ${repo.base_sha.slice(0, 12)} head ${head.slice(0, 12)}\n${Object.entries(acs).map(([id, v]) => `${id}: ${v}\n`).join("")}${tests.map((t) => `  red=${t.red} green=${t.green}  ${t.test}\n`).join("")}`);
}
