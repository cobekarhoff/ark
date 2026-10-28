import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OMP_CONFIG } from "./omp-config";

setDefaultTimeout(90_000);
const ROOT = join(import.meta.dir, "..");
const COMMAND_LINE_FILE = join(ROOT, "cli", "ark.ts");
const helper = (secret: string) => `"!f() { echo username=human; echo password=${secret}; }; f"`;
const FILL = `printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill`;

// ---- real omp: `ark launch --mode rpc` starts the real omp with no model call; rpc `get_state` lists the active tools and rpc `bash` runs a
// command in omp's own process environment (it is the user's bash, which the tool allowlist does not affect). ----
type Frame = { id?: string; type: string; data?: any };
async function remoteProcedureCall(commandArguments: string[], commands: object[], options: { cwd: string; env: Record<string, string> }): Promise<Record<string, Frame>> {
  const childProcess = Bun.spawn(commandArguments, { cwd: options.cwd, env: options.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  commands.forEach((command, i) => childProcess.stdin.write(`${JSON.stringify({ id: String(i), ...command })}\n`));
  childProcess.stdin.flush();
  const responses: Record<string, Frame> = {};
  let buffer = "";
  const deadline = Date.now() + 60_000;
  const reader = childProcess.stdout.getReader();
  while (Object.keys(responses).length < commands.length && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += new TextDecoder().decode(value);
    for (const line of buffer.split("\n").slice(0, -1)) {
      if (!line.startsWith("{")) continue;
      const frame = JSON.parse(line) as Frame;
      if (frame.type === "response" && frame.id) responses[frame.id] = frame;
    }
    buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
  }
  childProcess.kill();
  expect(Object.keys(responses), `omp answered ${Object.keys(responses).length}/${commands.length}: ${await new Response(childProcess.stderr).text()}`).toHaveLength(commands.length);
  return responses;
}
const toolNames = (frame: Frame) => (frame.data.dumpTools as { name: string }[]).map((tool) => tool.name);

let root: string;
let extraConfig = ""; // appended to the human's ~/.gitconfig in the stand-in tests
let launchDirectory = ""; // the directory the stand-in tests launch from (default: root)
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
  extraConfig = "";
  launchDirectory = "";
  root = mkdtempSync(join(tmpdir(), "ark-launch-"));
  mkdirSync(join(root, "home"));
  mkdirSync(join(root, "empty")); // a folder that is no project and has no .omp/tools
});

describe("ARK-118-AC1 real omp", () => {
  test("ark launch from an empty folder starts omp with the typed ark tools and without bash, eval, lsp and find", async () => {
    const result = await remoteProcedureCall([process.execPath, COMMAND_LINE_FILE, "launch", "--mode", "rpc", ...MODEL], [{ type: "get_state" }], { cwd: join(root, "empty"), env: HERE() });
    const names = toolNames(result["0"]);
    for (const wanted of ["read", "write", "edit", "task", "ark_run_start", "ark_advance", "ark_merge_request_open", "ark_gate_answer", "ark_run_close"]) expect(names).toContain(wanted);
    for (const banned of ["bash", "eval", "lsp", "find"]) expect(names).not.toContain(banned);
  });

  test("an ark_* tool exists only where --tools names it: unlisted ones are absent from a session that loads the same package", async () => {
    const result = await remoteProcedureCall(["omp", "-e", ROOT, "--tools", "read,ark_merge_request_open", "--no-lsp", "--mode", "rpc", ...MODEL], [{ type: "get_state" }], { cwd: join(root, "empty"), env: HERE() });
    expect(toolNames(result["0"]).filter((number) => number === "read" || number.startsWith("ark_")).sort()).toEqual(["ark_merge_request_open", "read"]);
  });
});

describe("ARK-118-AC2 real omp", () => {
  // The human's credentials sit in every config layer git reads: system, global, the repo, and the worktree's own config.
  function fixture(layers: ("system" | "global" | "local" | "worktree")[]) {
    const repository = join(root, "repo");
    const git = (...argumentsList: string[]) => Bun.spawnSync(["git", ...argumentsList], { cwd: repository, env: { ...process.env, HOME: join(root, "home"), GIT_CONFIG_NOSYSTEM: "1" } });
    mkdirSync(repository);
    git("init", "-q");
    if (layers.includes("local")) git("config", "credential.helper", helper("SECRET_LOCAL").slice(1, -1));
    if (layers.includes("worktree")) {
      git("config", "extensions.worktreeConfig", "true");
      git("config", "--worktree", "credential.helper", helper("SECRET_WORKTREE").slice(1, -1));
    }
    if (layers.includes("global")) writeFileSync(join(root, "home", ".gitconfig"), `[credential]\n\thelper = ${helper("SECRET_GLOBAL")}\n`);
    const environment: Record<string, string> = { ...HERE() };
    if (layers.includes("system")) {
      writeFileSync(join(root, "system.gitconfig"), `[credential]\n\thelper = ${helper("SECRET_SYSTEM")}\n`);
      environment.GIT_CONFIG_SYSTEM = join(root, "system.gitconfig");
    }
    return { repository, environment };
  }
  const bash = (command: string) => ({ type: "bash", command });
  const LAUNCH = [process.execPath, COMMAND_LINE_FILE, "launch", "--mode", "rpc", ...MODEL];

  test("control: the same fixture hands git the human's credential when omp is not launched credential-free", () => {
    const { repository, environment } = fixture(["system", "global", "local", "worktree"]);
    const result = Bun.spawnSync(["sh", "-c", FILL], { cwd: repository, env: { ...environment, GIT_TERMINAL_PROMPT: "0" } });
    expect(result.stdout.toString()).toMatch(/password=SECRET_/);
  });

  test("a helper only the repository or its worktree configures is reset too (config precedence puts them after the global file)", async () => {
    const { repository, environment } = fixture(["local", "worktree"]);
    const result = await remoteProcedureCall(LAUNCH, [bash(FILL)], { cwd: repository, env: environment });
    expect(result["0"].data.output).not.toContain("SECRET");
    expect(result["0"].data.exitCode).not.toBe(0);
    expect(result["0"].data.output).toContain("terminal prompts disabled");
  });

  test("a helper passed through GIT_CONFIG_PARAMETERS (what `git -c` sets) is dropped too: git reads it after the command-line reset", async () => {
    const { repository, environment } = fixture([]);
    environment.GIT_CONFIG_PARAMETERS = `'credential.helper'='${helper("SECRET_PARAMS").slice(1, -1)}'`;
    const result = await remoteProcedureCall(LAUNCH, [bash(FILL)], { cwd: repository, env: environment });
    expect(result["0"].data.output).not.toContain("SECRET");
    expect(result["0"].data.exitCode).not.toBe(0);
  });

  test("with a helper in every layer git yields nothing, reads no system config at all, and no token or logged-in gh reaches the session", async () => {
    const { repository, environment } = fixture(["system", "global", "local", "worktree"]);
    const result = await remoteProcedureCall(LAUNCH, [bash(FILL), bash("git config --show-scope --get-all credential.helper"), bash("env | grep -E '^(GH_TOKEN|GITHUB_TOKEN)=' ; ls \"$GH_CONFIG_DIR\" | wc -l; gh auth status 2>&1")], { cwd: repository, env: environment });
    expect(result["0"].data.output).not.toContain("SECRET");
    expect(result["1"].data.output).not.toMatch(/^system\s/m); // GIT_CONFIG_NOSYSTEM: the system file is not even read
    expect(result["2"].data.output).not.toContain("ghp_human");
    expect(result["2"].data.output).toContain("not logged into any GitHub hosts"); // GH_CONFIG_DIR is empty
  });
});

// A git credential can also be an `Authorization` header in http.extraHeader / http.<url>.extraHeader: a helper reset does not touch those.
describe("ARK-118-AC2 real omp: http authentication headers", () => {
  let seen: (string | null)[];
  let server: ReturnType<typeof Bun.serve>;
  beforeEach(() => {
    seen = [];
    server = Bun.serve({ port: 0, fetch: (request) => (seen.push(request.headers.get("authorization")), new Response("no", { status: 401 })) });
  });
  afterEach(() => server.stop(true));
  const url = () => `http://127.0.0.1:${server.port}/x.git`;
  const fixture = () => {
    const repository = join(root, "repo");
    mkdirSync(repository);
    // the human's config sets the header generically, for the server's URL, and (the most specific, so the one git would send) in this repository
    writeFileSync(join(root, "home", ".gitconfig"), `[http]\n\textraHeader = Authorization: Basic HEADER_GENERIC\n[http "http://127.0.0.1:${server.port}/"]\n\textraHeader = Authorization: Basic HEADER_URL\n`);
    const environment = { ...HERE() };
    Bun.spawnSync(["git", "init", "-q"], { cwd: repository, env: environment });
    Bun.spawnSync(["git", "config", `http.${url()}.extraHeader`, "Authorization: Basic HEADER_LOCAL"], { cwd: repository, env: environment });
    return { repository, environment };
  };

  test("control: the human's header reaches the server when omp is not launched credential-free", async () => {
    const { repository, environment } = fixture();
    await Bun.spawn(["git", "ls-remote", url()], { cwd: repository, env: { ...environment, GIT_TERMINAL_PROMPT: "0" }, stdout: "pipe", stderr: "pipe" }).exited; // async: this process serves the request
    for (const packetHash of ["HEADER_GENERIC", "HEADER_URL", "HEADER_LOCAL"]) expect(seen.join()).toContain(packetHash); // git sends every layer's header
  });

  test("under ark launch an agent's plain git ls-remote sends no Authorization header, whichever layer sets it", async () => {
    const { repository, environment } = fixture();
    const result = await remoteProcedureCall([process.execPath, COMMAND_LINE_FILE, "launch", "--mode", "rpc", ...MODEL], [{ type: "bash", command: `git ls-remote ${url()}` }], { cwd: repository, env: environment });
    expect(result["0"].data.output).toContain("could not read Username"); // the server answered 401: the request was made and refused
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((packetHash) => packetHash !== null)).toEqual([]);
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
const outputDirectory = process.env.OUT!;
writeFileSync(outputDirectory + "/argv", process.argv.slice(2).join("\\n"));
writeFileSync(outputDirectory + "/env", Object.entries(process.env).map(([key, value]) => key + "=" + value).join("\\n"));
const probe = Bun.spawnSync(["sh", "-c", ${JSON.stringify(PROBE)}], { stdout: "pipe", stderr: "pipe" });
writeFileSync(outputDirectory + "/omp.fill", probe.stdout.toString());
writeFileSync(outputDirectory + "/omp.rc", String(probe.exitCode));
const schemaBuilder: unknown = new Proxy(function () {}, { get: () => schemaBuilder, apply: () => schemaBuilder }); // schema shape is not under test; real omp covers it above
// Load the plugin inside the launched process so its environment boundary is exercised.
const tools = (await import(${JSON.stringify(join(ROOT, "tools", "ark.ts"))})).default({ zod: schemaBuilder });
writeFileSync(outputDirectory + "/tools", tools.map((tool) => tool.name).join("\\n"));
const context = { sessionManager: { getSessionId: () => "session-118", getSessionFile: () => undefined } };
const call = (name: string, parameters: object) => tools.find((tool) => tool.name === name).execute("id", parameters, undefined, context);
await call("ark_advance", { run_id: "2026-10-27-DEMO-1", event: "analysis.completed" });
await call("ark_merge_request_open", { run_id: "2026-10-27-DEMO-1" });
`;

let output: string;
const read = (file: string) => readFileSync(join(output, file), "utf8");
const environmentOf = (file: string) => Object.fromEntries(read(file).split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));

function standIn(...argumentsList: string[]) {
  output = join(root, "out");
  mkdirSync(output, { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  for (const [name, body] of [["omp", FAKE_OMP], ["bun", FAKE_BUN], ["gh", FAKE_GH]]) {
    writeFileSync(join(root, "bin", name), body);
    chmodSync(join(root, "bin", name), 0o755);
  }
  // The human's setup: an identity and a credential helper that has the password, a gh login in their own config dir, and an identity set through GIT_CONFIG_COUNT.
  writeFileSync(join(root, "home", ".gitconfig"), `[credential]\n\thelper = ${helper("SECRET")}\n${extraConfig}`);
  mkdirSync(join(root, "human-gh"), { recursive: true });
  writeFileSync(join(root, "human-gh", "hosts.yml"), "github.com: human-login\n");
  const environment = {
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    HOME: join(root, "home"),
    ARK_HOME: join(root, "ark-home"),
    OUT: output,
    GH_TOKEN: "ghp_human", GITHUB_TOKEN: "ghp_human",
    GH_CONFIG_DIR: join(root, "human-gh"),
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Human",
  };
  const result = Bun.spawnSync([process.execPath, COMMAND_LINE_FILE, "launch", ...argumentsList], { env: environment, cwd: launchDirectory || root });
  return { code: result.exitCode, err: result.stderr.toString() };
}

describe("ARK-118-AC1", () => {
  test("the orchestrator session is launched without bash, eval and lsp, from the package directory, with every typed ark tool", () => {
    const result = standIn();
    expect(result.err).toBe("");
    const commandArguments = read("argv").split("\n");
    const offered = commandArguments[commandArguments.indexOf("--tools") + 1].split(",");
    for (const banned of ["bash", "eval", "lsp", "find"]) expect(offered).not.toContain(banned);
    expect(commandArguments).toContain("--no-lsp");
    expect(commandArguments[commandArguments.indexOf("-e") + 1]).toBe(ROOT); // a directory: omp scans only a directory's tools/, and package.json brings the hook
    expect(offered).toContain("read");
    expect(offered).toContain("ask"); // the orchestrator shows the human the fixed answers with it
    expect(offered.filter((tool) => tool.startsWith("ark_")).sort()).toEqual(read("tools").split("\n").sort()); // omp refuses a --tools name it does not know, and offers nothing a tool file forgot
  });

  test("print and rpc modes drop ask, which omp has no UI for; extra omp arguments pass through", () => {
    standIn("-p", "--model", "m", "hello");
    const commandArguments = read("argv").split("\n");
    expect(commandArguments[commandArguments.indexOf("--tools") + 1].split(",")).not.toContain("ask");
    expect(commandArguments.slice(-4)).toEqual(["-p", "--model", "m", "hello"]);
  });

  test("a credential inside a remote URL or a url.<x>.insteadOf rewrite refuses the launch, naming the key and redacting the secret; clean URLs launch", () => {
    const repository = join(root, "repo");
    mkdirSync(repository);
    const git = (...argumentsList: string[]) => Bun.spawnSync(["git", ...argumentsList], { cwd: repository, env: { ...process.env, HOME: join(root, "home") } });
    git("init", "-q");
    launchDirectory = repository;
    git("config", "remote.origin.url", "https://github.com/acme/demo.git");
    git("config", "remote.backup.url", "ssh://git@github.com/acme/demo.git"); // a user name without a secret in an ssh URL is no credential
    expect(standIn().code).toBe(0);

    for (const [key, value] of [["remote.origin.url", "https://user:tok-secret@github.com/acme/demo.git"], ["remote.origin.pushurl", "https://tok-secret@github.com/acme/demo.git"]]) {
      git("config", key, value);
      rmSync(output, { recursive: true, force: true });
      rmSync(join(root, "bin"), { recursive: true, force: true });
      const result = standIn();
      expect(result.code, key).toBe(1);
      expect(result.err).toContain(key);
      expect(result.err).toContain("***@");
      expect(result.err).not.toContain("tok-secret");
      expect(existsSync(join(output, "argv")), "omp was not started").toBe(false);
      git("config", "--unset", key);
    }
    extraConfig = '[url "https://user:tok-secret@github.com/"]\n\tinsteadOf = https://github.com/\n'; // the human's global config
    rmSync(output, { recursive: true, force: true });
    rmSync(join(root, "bin"), { recursive: true, force: true });
    const result = standIn();
    expect(result.code).toBe(1);
    expect(result.err).toContain("url.https://***@github.com/.insteadof");
    expect(result.err).not.toContain("tok-secret");
  });

  test("a typed tool runs the CLI with the session id the bash tool would have exported", () => {
    standIn();
    expect(read("child-advance.env")).toContain("PI_SESSION_ID=session-118");
    expect(read("child-advance.env")).toContain(`ARGV=${COMMAND_LINE_FILE} advance 2026-10-27-DEMO-1 analysis.completed`);
  });
});

describe("ARK-118-AC2", () => {
  test("under ark launch the session has no token, no helper and no gh login", () => {
    standIn();
    expect(read("omp.rc").trim()).not.toBe("0");
    expect(read("omp.fill")).not.toContain("SECRET");
    const environment = environmentOf("env");
    expect(environment.GH_TOKEN).toBeUndefined();
    expect(environment.GITHUB_TOKEN).toBeUndefined();
    expect(environment.GH_CONFIG_DIR).not.toBe(join(root, "human-gh"));
  });

  test("ark merge-request open alone gets the human's values back: credential helper, gh login and their own GIT_CONFIG_COUNT identity; every other ark tool stays credential-free", () => {
    extraConfig = '[http]\n\textraHeader = Authorization: Basic H1\n[http "https://example.com/"]\n\textraHeader = Authorization: Basic H2\n';
    standIn();
    const mergeRequestEnvironment = environmentOf("child-merge-request.env");
    expect(read("child-merge-request.fill")).toContain("password=SECRET");
    expect(read("child-merge-request.rc").trim()).toBe("0");
    expect(read("child-merge-request.gh")).toContain("human-login"); // gh sees the human's config dir, not the empty one
    expect(mergeRequestEnvironment.GH_CONFIG_DIR).toBe(join(root, "human-gh"));
    expect(mergeRequestEnvironment.GIT_CONFIG_COUNT).toBe("1"); // the human's own value, not launch's
    expect(mergeRequestEnvironment.GIT_CONFIG_KEY_1).toBeUndefined(); // and none of the resets launch appended (credential.helper, http.extraHeader and each http.<url>.extraHeader)
    expect(environmentOf("env").GIT_CONFIG_COUNT).toBe("4"); // the human's one entry, plus those three resets
    expect(read("child-merge-request.name").trim()).toBe("Human");
    expect(mergeRequestEnvironment.GIT_CONFIG_NOSYSTEM).toBeUndefined();
    expect(mergeRequestEnvironment.ARK_LAUNCH_HUMAN_ENV).toBeUndefined();
    expect(mergeRequestEnvironment.GH_TOKEN).toBeUndefined(); // tokens are dropped for good: ark merge-request open uses gh's keyring login

    expect(read("child-advance.fill")).not.toContain("SECRET");
    expect(read("child-advance.rc").trim()).not.toBe("0");
    expect(read("child-advance.gh")).not.toContain("human-login");
    expect(read("child-advance.name").trim()).toBe("Human"); // the human's identity still applies to the agent's commits
  });
});

// The tool files are loaded by omp's real schema builder; here only that each verb's argv is one the real CLI accepts.
describe("ARK-118-AC1 tools against the real CLI", () => {
  let projectDirectory: string;
  let workingDirectory: string;
  const saved = { ...process.env };
  beforeEach(() => {
    projectDirectory = join(root, "proj");
    mkdirSync(join(projectDirectory, ".omp"), { recursive: true });
    writeFileSync(join(projectDirectory, "ark.yml"), "project: demo\n");
    writeFileSync(join(projectDirectory, ".omp", "config.yml"), OMP_CONFIG);
    mkdirSync(join(root, "ark-home", "projects", "demo", "tickets"), { recursive: true });
    writeFileSync(join(root, "ark-home", "projects", "demo", "tickets", "DEMO-1.md"), `---\nid: DEMO-1\ntitle: "t"\nstatus: ready\nacceptance_criteria:\n  - id: DEMO-1-AC1\n    text: "a"\n---\nBody.\n`);
    workingDirectory = process.cwd();
    process.chdir(projectDirectory);
    process.env.ARK_HOME = join(root, "ark-home");
  });
  afterEach(() => {
    process.chdir(workingDirectory);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  const schemaBuilder: unknown = new Proxy(function () {}, { get: () => schemaBuilder, apply: () => schemaBuilder });
  // Load tools after the fixture installs the project and session environment.
  const tool = async (name: string) => (await import("../tools/ark")).default({ zod: schemaBuilder }).find((tool: { name: string }) => tool.name === name)!;
  const context = { sessionManager: { getSessionId: () => "session-118", getSessionFile: () => join(root, "session-118.jsonl") } };

  test("ark_run_start starts the run and binds the session, so the tool_call hook sees it", async () => {
    const result = await (await tool("ark_run_start")).execute("id", { ticket: "DEMO-1" }, undefined, context);
    expect(result.content[0].text).toMatch(/^started \d{4}-\d{2}-\d{2}-DEMO-1-1\n/);
    const runId = result.content[0].text.split("\n")[0].split(" ")[1];
    expect(readFileSync(join(root, "ark-home", "bindings", "session-118"), "utf8").trim()).toBe(join(root, "ark-home", "projects", "demo", "runs", runId));
  });

  test("every ark tool builds a command line the CLI accepts (never 'unknown command or bad arguments')", async () => {
    const run = "2026-10-27-DEMO-9-1";
    const parameters: Record<string, object> = {
      ark_log_route: { run_id: run, playbook: "ticket", why: "w" },
      ark_advance: { run_id: run, event: "analysis.completed", data: { repo: "demo" } },
      ark_worktree_create: { run_id: run, repo: "." },
      ark_gate_packet: { run_id: run, gate: "plan" },
      ark_acceptance_criteria_update: { run_id: run },
      ark_findings_record: { run_id: run, file: "f.json" },
      ark_artifact_record: { run_id: run, agent: "implementer", file: "f.json" },
      ark_trace_check: { run_id: run },
      ark_merge_request_open: { run_id: run },
    };
    for (const [name, toolParameters] of Object.entries(parameters)) {
      const error = await (await tool(name)).execute("id", toolParameters, undefined, context).then(() => "", (error: Error) => error.message);
      expect(error, name).not.toContain("unknown command or bad arguments");
      expect(error, name).toContain("no such run"); // reached the command, which looked the run up
    }
  });
});
