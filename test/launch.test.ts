import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OMP_CONFIG } from "./omp-config";

setDefaultTimeout(60_000);
const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "cli", "ark.ts");

// `ark launch` starts `omp`; a stand-in on PATH records what omp would have been given, then drives the typed ark tools the way omp does
// (the real tool module, a session id in ctx) and asks git for the human's credential, once as the launched process and once through each tool's child.
const PROBE = `printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill`;
// Stand-in `bun` for the tools' children: records which ark verb ran and whether git can still get the human's credential in that environment.
const FAKE_BUN = `#!/bin/sh
verb="$2" # $1 is the CLI path
{ env; echo "ARGV=$*"; } > "$OUT/child-$verb.env"
${PROBE} > "$OUT/child-$verb.fill" 2>/dev/null
echo $? > "$OUT/child-$verb.rc"
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

let root: string;
let out: string;
const read = (f: string) => readFileSync(join(out, f), "utf8");
const envOf = (f: string) => Object.fromEntries(read(f).split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

function launch(...args: string[]) {
  const env = {
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    HOME: join(root, "home"),
    ARK_HOME: join(root, "ark-home"),
    OUT: out,
    GH_TOKEN: "ghp_human", GITHUB_TOKEN: "ghp_human",
  };
  const r = Bun.spawnSync([process.execPath, CLI, "launch", ...args], { env, cwd: root });
  return { code: r.exitCode, err: r.stderr.toString() };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ark-launch-"));
  out = join(root, "out");
  mkdirSync(out);
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "home"));
  // The human's setup: an identity and a credential helper that has the password.
  writeFileSync(join(root, "home", ".gitconfig"), `[user]\n\tname = Human\n\temail = human@example.com\n[credential]\n\thelper = "!f() { echo username=human; echo password=SECRET; }; f"\n`);
  for (const [name, body] of [["omp", FAKE_OMP], ["bun", FAKE_BUN]]) {
    writeFileSync(join(root, "bin", name), body);
    chmodSync(join(root, "bin", name), 0o755);
  }
});

describe("ARK-118-AC1", () => {
  test("the orchestrator session is launched without bash, eval and lsp, and with every typed ark tool", () => {
    const r = launch();
    expect(r.err).toBe("");
    const argv = read("argv").split("\n");
    const offered = argv[argv.indexOf("--tools") + 1].split(",");
    for (const banned of ["bash", "eval", "lsp"]) expect(offered).not.toContain(banned);
    expect(argv).toContain("--no-lsp");
    expect(argv[argv.indexOf("-e") + 1]).toBe(join(ROOT, "extensions", "index.ts")); // the hook that confines write and edit, even when the plugin is not installed
    expect(offered).toContain("read");
    expect(offered.filter((t) => t.startsWith("ark_")).sort()).toEqual(read("tools").split("\n").sort()); // omp refuses a --tools name it does not know, and offers nothing a tool file forgot
  });

  test("print mode drops ask, which omp has no UI for; extra omp arguments pass through", () => {
    launch("-p", "--model", "m", "hello");
    const argv = read("argv").split("\n");
    expect(argv[argv.indexOf("--tools") + 1].split(",")).not.toContain("ask");
    expect(argv.slice(-4)).toEqual(["-p", "--model", "m", "hello"]);
  });

  test("a typed tool runs the CLI with the session id the bash tool would have exported", () => {
    launch();
    expect(read("child-advance.env")).toContain("PI_SESSION_ID=session-118");
    expect(read("child-advance.env")).toContain(`ARGV=${CLI} advance 2026-10-27-DEMO-1 analysis.completed`);
  });
});

describe("ARK-118-AC2", () => {
  test("control: without ark launch the agent's git gets the human's credential", () => {
    const r = Bun.spawnSync([join(root, "bin", "omp")], { env: { PATH: `${join(root, "bin")}:${process.env.PATH}`, HOME: join(root, "home"), OUT: out } });
    expect(r.exitCode).toBe(0);
    expect(read("omp.fill")).toContain("password=SECRET");
  });

  test("under ark launch, git has no credential helper and no token reaches the session", () => {
    launch();
    expect(read("omp.rc")).not.toBe("0");
    expect(read("omp.fill")).not.toContain("SECRET");
    const env = envOf("env");
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(readdirSync(env.GH_CONFIG_DIR)).toEqual([]); // gh finds no hosts.yml: logged out
    expect(readFileSync(env.GIT_CONFIG_GLOBAL, "utf8")).toContain("name = Human"); // the agent can still commit
  });

  test("ark mr alone gets the human's credentials back; every other ark tool stays credential-free", () => {
    launch();
    expect(read("child-mr.fill")).toContain("password=SECRET");
    expect(read("child-mr.rc").trim()).toBe("0");
    expect(read("child-advance.fill")).not.toContain("SECRET");
    expect(read("child-advance.rc").trim()).not.toBe("0");
    expect(envOf("child-mr.env").GH_TOKEN).toBeUndefined(); // tokens are dropped for good: ark mr uses gh's keyring login
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
      ark_gate_answer: { run_id: run, gate: "G1", answer: "approve", packet: "sha256:0" },
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
