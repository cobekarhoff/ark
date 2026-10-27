import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OMP_CONFIG } from "./omp-config";

setDefaultTimeout(90_000);
const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "cli", "ark.ts");
const helper = (secret: string) => `"!f() { echo username=human; echo password=${secret}; }; f"`;
const FILL = `printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill`;

// ---- real omp: `ark launch --mode rpc` starts the real omp with no model call; rpc `get_state` lists the active tools and rpc `bash` runs a
// command in omp's own process environment (it is the user's bash, which the tool allowlist does not affect). ----
type Frame = { id?: string; type: string; data?: any };
async function rpc(argv: string[], commands: object[], opt: { cwd: string; env: Record<string, string> }): Promise<Record<string, Frame>> {
  const p = Bun.spawn(argv, { cwd: opt.cwd, env: opt.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  commands.forEach((c, i) => p.stdin.write(`${JSON.stringify({ id: String(i), ...c })}\n`));
  p.stdin.flush();
  const got: Record<string, Frame> = {};
  let buf = "";
  const deadline = Date.now() + 60_000;
  const reader = p.stdout.getReader();
  while (Object.keys(got).length < commands.length && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    for (const line of buf.split("\n").slice(0, -1)) {
      if (!line.startsWith("{")) continue;
      const f = JSON.parse(line) as Frame;
      if (f.type === "response" && f.id) got[f.id] = f;
    }
    buf = buf.slice(buf.lastIndexOf("\n") + 1);
  }
  p.kill();
  expect(Object.keys(got), `omp answered ${Object.keys(got).length}/${commands.length}: ${await new Response(p.stderr).text()}`).toHaveLength(commands.length);
  return got;
}
const toolNames = (f: Frame) => (f.data.dumpTools as { name: string }[]).map((t) => t.name);

let root: string;
const HERE = () => ({
  PATH: process.env.PATH!,
  HOME: join(root, "home"),
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR!,
  ARK_HOME: join(root, "ark-home"),
  ANTHROPIC_API_KEY: "sk-not-used", // omp wants a model it can name; no request is ever made
  GH_TOKEN: "ghp_human",
  GITHUB_TOKEN: "ghp_human",
});
const MODEL = ["--model", "anthropic/claude-haiku", "--no-session"];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ark-launch-"));
  mkdirSync(join(root, "home"));
  mkdirSync(join(root, "empty")); // a folder that is no project and has no .omp/tools
});

describe("ARK-118-AC1 real omp", () => {
  test("ark launch from an empty folder starts omp with the typed ark tools and without bash, eval, lsp, find and any gate-answer tool", async () => {
    const r = await rpc([process.execPath, CLI, "launch", "--mode", "rpc", ...MODEL], [{ type: "get_state" }], { cwd: join(root, "empty"), env: HERE() });
    const names = toolNames(r["0"]);
    for (const wanted of ["read", "write", "edit", "task", "ark_run_start", "ark_advance", "ark_mr"]) expect(names).toContain(wanted);
    for (const banned of ["bash", "eval", "lsp", "find", "ark_gate_answer"]) expect(names).not.toContain(banned);
  });

  test("an ark_* tool exists only where --tools names it: unlisted ones are absent from a session that loads the same package", async () => {
    const r = await rpc(["omp", "-e", ROOT, "--tools", "read,ark_mr", "--no-lsp", "--mode", "rpc", ...MODEL], [{ type: "get_state" }], { cwd: join(root, "empty"), env: HERE() });
    expect(toolNames(r["0"]).filter((n) => n === "read" || n.startsWith("ark_")).sort()).toEqual(["ark_mr", "read"]);
  });
});

describe("ARK-118-AC2 real omp", () => {
  // The human's credentials sit in every config layer git reads: system, global, the repo, and the worktree's own config.
  function fixture(layers: ("system" | "global" | "local" | "worktree")[]) {
    const repo = join(root, "repo");
    const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: repo, env: { ...process.env, HOME: join(root, "home"), GIT_CONFIG_NOSYSTEM: "1" } });
    mkdirSync(repo);
    git("init", "-q");
    if (layers.includes("local")) git("config", "credential.helper", helper("SECRET_LOCAL").slice(1, -1));
    if (layers.includes("worktree")) {
      git("config", "extensions.worktreeConfig", "true");
      git("config", "--worktree", "credential.helper", helper("SECRET_WORKTREE").slice(1, -1));
    }
    if (layers.includes("global")) writeFileSync(join(root, "home", ".gitconfig"), `[credential]\n\thelper = ${helper("SECRET_GLOBAL")}\n`);
    const env: Record<string, string> = { ...HERE() };
    if (layers.includes("system")) {
      writeFileSync(join(root, "system.gitconfig"), `[credential]\n\thelper = ${helper("SECRET_SYSTEM")}\n`);
      env.GIT_CONFIG_SYSTEM = join(root, "system.gitconfig");
    }
    return { repo, env };
  }
  const bash = (command: string) => ({ type: "bash", command });
  const LAUNCH = [process.execPath, CLI, "launch", "--mode", "rpc", ...MODEL];

  test("control: the same fixture hands git the human's credential when omp is not launched credential-free", () => {
    const { repo, env } = fixture(["system", "global", "local", "worktree"]);
    const r = Bun.spawnSync(["sh", "-c", FILL], { cwd: repo, env: { ...env, GIT_TERMINAL_PROMPT: "0" } });
    expect(r.stdout.toString()).toMatch(/password=SECRET_/);
  });

  test("a helper only the repository or its worktree configures is reset too (config precedence puts them after the global file)", async () => {
    const { repo, env } = fixture(["local", "worktree"]);
    const r = await rpc(LAUNCH, [bash(FILL)], { cwd: repo, env });
    expect(r["0"].data.output).not.toContain("SECRET");
    expect(r["0"].data.exitCode).not.toBe(0);
    expect(r["0"].data.output).toContain("terminal prompts disabled");
  });

  test("with a helper in every layer git yields nothing, reads no system config at all, and no token or logged-in gh reaches the session", async () => {
    const { repo, env } = fixture(["system", "global", "local", "worktree"]);
    const r = await rpc(LAUNCH, [bash(FILL), bash("git config --show-scope --get-all credential.helper"), bash("env | grep -E '^(GH_TOKEN|GITHUB_TOKEN)=' ; ls \"$GH_CONFIG_DIR\" | wc -l; gh auth status 2>&1")], { cwd: repo, env });
    expect(r["0"].data.output).not.toContain("SECRET");
    expect(r["1"].data.output).not.toMatch(/^system\s/m); // GIT_CONFIG_NOSYSTEM: the system file is not even read
    expect(r["2"].data.output).not.toContain("ghp_human");
    expect(r["2"].data.output).toContain("not logged into any GitHub hosts"); // GH_CONFIG_DIR is empty
  });
});

// ---- stand-in omp: it drives the real typed tools the way omp does, once as the launched process and once through each tool's child. ----
// The stand-in `bun` records which ark verb ran and what git and gh can see in that child's environment.
const PROBE = `${FILL}`;
const FAKE_BUN = `#!/bin/sh
verb="$2" # $1 is the CLI path
{ env; echo "ARGV=$*"; } > "$OUT/child-$verb.env"
${PROBE} > "$OUT/child-$verb.fill" 2>/dev/null
echo $? > "$OUT/child-$verb.rc"
gh auth status > "$OUT/child-$verb.gh" 2>&1
git config user.name > "$OUT/child-$verb.name" 2>/dev/null
`;
const FAKE_GH = `#!/bin/sh
cat "$GH_CONFIG_DIR/hosts.yml" 2>/dev/null || echo "not logged into any GitHub hosts"
`;
const FAKE_OMP = `#!${process.execPath}
import { writeFileSync } from "node:fs";
const out = process.env.OUT!;
writeFileSync(out + "/argv", process.argv.slice(2).join("\\n"));
writeFileSync(out + "/env", Object.entries(process.env).map(([k, v]) => k + "=" + v).join("\\n"));
const probe = Bun.spawnSync(["sh", "-c", ${JSON.stringify(PROBE)}], { stdout: "pipe", stderr: "pipe" });
writeFileSync(out + "/omp.fill", probe.stdout.toString());
writeFileSync(out + "/omp.rc", String(probe.exitCode));
const z: any = new Proxy(function () {}, { get: () => z, apply: () => z }); // the schema builder omp injects; the argument shapes are not under test here
const tools = (await import(${JSON.stringify(join(ROOT, "tools", "ark.ts"))})).default({ zod: z });
writeFileSync(out + "/tools", tools.map((t: any) => t.name).join("\\n"));
const ctx = { sessionManager: { getSessionId: () => "session-118" } };
const call = (name: string, params: object) => tools.find((t: any) => t.name === name).execute("id", params, undefined, ctx);
await call("ark_advance", { run_id: "2026-10-27-DEMO-1", event: "analysis.completed" });
await call("ark_mr", { run_id: "2026-10-27-DEMO-1" });
`;

let out: string;
const read = (f: string) => readFileSync(join(out, f), "utf8");
const envOf = (f: string) => Object.fromEntries(read(f).split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

function standIn(...args: string[]) {
  out = join(root, "out");
  mkdirSync(out);
  mkdirSync(join(root, "bin"));
  for (const [name, body] of [["omp", FAKE_OMP], ["bun", FAKE_BUN], ["gh", FAKE_GH]]) {
    writeFileSync(join(root, "bin", name), body);
    chmodSync(join(root, "bin", name), 0o755);
  }
  // The human's setup: an identity and a credential helper that has the password, a gh login in their own config dir, and an identity set through GIT_CONFIG_COUNT.
  writeFileSync(join(root, "home", ".gitconfig"), `[credential]\n\thelper = ${helper("SECRET")}\n`);
  mkdirSync(join(root, "human-gh"));
  writeFileSync(join(root, "human-gh", "hosts.yml"), "github.com: human-login\n");
  const env = {
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    HOME: join(root, "home"),
    ARK_HOME: join(root, "ark-home"),
    OUT: out,
    GH_TOKEN: "ghp_human", GITHUB_TOKEN: "ghp_human",
    GH_CONFIG_DIR: join(root, "human-gh"),
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Human",
  };
  const r = Bun.spawnSync([process.execPath, CLI, "launch", ...args], { env, cwd: root });
  return { code: r.exitCode, err: r.stderr.toString() };
}

describe("ARK-118-AC1", () => {
  test("the orchestrator session is launched without bash, eval and lsp, from the package directory, with every typed ark tool", () => {
    const r = standIn();
    expect(r.err).toBe("");
    const argv = read("argv").split("\n");
    const offered = argv[argv.indexOf("--tools") + 1].split(",");
    for (const banned of ["bash", "eval", "lsp", "find"]) expect(offered).not.toContain(banned);
    expect(argv).toContain("--no-lsp");
    expect(argv[argv.indexOf("-e") + 1]).toBe(ROOT); // a directory: omp scans only a directory's tools/, and package.json brings the hook
    expect(offered).toContain("read");
    expect(offered).toContain("ask"); // the orchestrator shows the human the fixed answers with it
    expect(offered.filter((t) => t.startsWith("ark_")).sort()).toEqual(read("tools").split("\n").sort()); // omp refuses a --tools name it does not know, and offers nothing a tool file forgot
  });

  test("print and rpc modes drop ask, which omp has no UI for; extra omp arguments pass through", () => {
    standIn("-p", "--model", "m", "hello");
    const argv = read("argv").split("\n");
    expect(argv[argv.indexOf("--tools") + 1].split(",")).not.toContain("ask");
    expect(argv.slice(-4)).toEqual(["-p", "--model", "m", "hello"]);
  });

  test("a typed tool runs the CLI with the session id the bash tool would have exported", () => {
    standIn();
    expect(read("child-advance.env")).toContain("PI_SESSION_ID=session-118");
    expect(read("child-advance.env")).toContain(`ARGV=${CLI} advance 2026-10-27-DEMO-1 analysis.completed`);
  });
});

describe("ARK-118-AC2", () => {
  test("under ark launch the session has no token, no helper and no gh login", () => {
    standIn();
    expect(read("omp.rc").trim()).not.toBe("0");
    expect(read("omp.fill")).not.toContain("SECRET");
    const env = envOf("env");
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_CONFIG_DIR).not.toBe(join(root, "human-gh"));
  });

  test("ark mr alone gets the human's values back: credential helper, gh login and their own GIT_CONFIG_COUNT identity; every other ark tool stays credential-free", () => {
    standIn();
    const mr = envOf("child-mr.env");
    expect(read("child-mr.fill")).toContain("password=SECRET");
    expect(read("child-mr.rc").trim()).toBe("0");
    expect(read("child-mr.gh")).toContain("human-login"); // gh sees the human's config dir, not the empty one
    expect(mr.GH_CONFIG_DIR).toBe(join(root, "human-gh"));
    expect(mr.GIT_CONFIG_COUNT).toBe("1"); // the human's own value, not launch's
    expect(read("child-mr.name").trim()).toBe("Human");
    expect(mr.GIT_CONFIG_NOSYSTEM).toBeUndefined();
    expect(mr.ARK_LAUNCH_HUMAN_ENV).toBeUndefined();
    expect(mr.GH_TOKEN).toBeUndefined(); // tokens are dropped for good: ark mr uses gh's keyring login

    expect(read("child-advance.fill")).not.toContain("SECRET");
    expect(read("child-advance.rc").trim()).not.toBe("0");
    expect(read("child-advance.gh")).not.toContain("human-login");
    expect(read("child-advance.name").trim()).toBe("Human"); // the human's identity still applies to the agent's commits
  });
});

// The tool files are loaded by omp's real schema builder; here only that each verb's argv is one the real CLI accepts.
describe("ARK-118-AC1 tools against the real CLI", () => {
  let proj: string;
  let cwd: string;
  const saved = { ...process.env };
  beforeEach(() => {
    proj = join(root, "proj");
    mkdirSync(join(proj, ".omp"), { recursive: true });
    writeFileSync(join(proj, "ark.yml"), "project: demo\n");
    writeFileSync(join(proj, ".omp", "config.yml"), OMP_CONFIG);
    mkdirSync(join(root, "ark-home", "projects", "demo", "tickets"), { recursive: true });
    writeFileSync(join(root, "ark-home", "projects", "demo", "tickets", "DEMO-1.md"), `---\nid: DEMO-1\ntitle: "t"\nstatus: ready\nacceptance_criteria:\n  - id: DEMO-1-AC1\n    text: "a"\n---\nBody.\n`);
    cwd = process.cwd();
    process.chdir(proj);
    process.env.ARK_HOME = join(root, "ark-home");
  });
  afterEach(() => {
    process.chdir(cwd);
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  const z: any = new Proxy(function () {}, { get: () => z, apply: () => z });
  const tool = async (name: string) => (await import("../tools/ark")).default({ zod: z }).find((t: { name: string }) => t.name === name);
  const ctx = { sessionManager: { getSessionId: () => "session-118" } };

  test("ark_run_start starts the run and binds the session, so the tool_call hook sees it", async () => {
    const res = await (await tool("ark_run_start")).execute("id", { ticket: "DEMO-1" }, undefined, ctx);
    expect(res.content[0].text).toMatch(/^started \d{4}-\d{2}-\d{2}-DEMO-1\n/);
    const runId = res.content[0].text.split("\n")[0].split(" ")[1];
    expect(readFileSync(join(root, "ark-home", "bindings", "session-118"), "utf8").trim()).toBe(join(root, "ark-home", "projects", "demo", "runs", runId));
  });

  test("every ark tool builds a command line the CLI accepts (never 'unknown command or bad arguments')", async () => {
    const run = "2026-10-27-DEMO-9";
    const params: Record<string, object> = {
      ark_log_route: { run_id: run, playbook: "ticket", why: "w" },
      ark_advance: { run_id: run, event: "analysis.completed", data: { repo: "demo" } },
      ark_ws_create: { run_id: run, repo: "." },
      ark_gate_packet: { run_id: run, gate: "G1" },
      ark_findings_record: { run_id: run, file: "f.json" },
      ark_artifact_record: { run_id: run, agent: "implementer", file: "f.json" },
      ark_trace_check: { run_id: run },
      ark_mr: { run_id: run },
    };
    for (const [name, p] of Object.entries(params)) {
      const err = await (await tool(name)).execute("id", p, undefined, ctx).then(() => "", (e: Error) => e.message);
      expect(err, name).not.toContain("unknown command or bad arguments");
      expect(err, name).toContain("no such run"); // reached the command, which looked the run up
    }
  });
});
