import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../extensions/index";
import { OMP_CONFIG } from "./omp-config";

const CLI = join(import.meta.dir, "..", "cli", "ark.ts");
const GIT_IDENTITY = { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "t", GIT_CONFIG_KEY_1: "user.email", GIT_CONFIG_VALUE_1: "t@t" };
const ticket = (id: string) => `---\nid: ${id}\ntitle: "Fixture"\nstatus: ready\nacceptance_criteria:\n  - id: ${id}-AC1\n    text: "one"\n---\nBody.\n`;

let home: string;
let proj: string;
const baseEnv = () => {
  const env: Record<string, string | undefined> = { ...process.env, ...GIT_IDENTITY, ARK_HOME: home };
  delete env.PI_SESSION_ID; // the test process may itself run inside an OMP session
  return env as Record<string, string>;
};
const ark = (args: string[], stdin?: string, env: Record<string, string> = {}) => {
  const r = Bun.spawnSync(["bun", CLI, ...args], { cwd: proj, env: { ...baseEnv(), ...env }, stdin: stdin === undefined ? undefined : Buffer.from(stdin) });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const runsDir = () => join(home, "projects", "demo", "runs");
const runOf = (id: string) => readdirSync(runsDir()).find((r) => r.includes(`-${id}-`))!;
const dirOf = (id: string) => join(runsDir(), runOf(id));
// `session`: the id of the OMP session the extension reports with the call (ctx.sessionManager.getSessionId()).
const call = (tool: string, input: Record<string, unknown>, o: { session?: string; cwd?: string } = {}) => ark(["hook", "tool_call"], JSON.stringify({ tool, input, cwd: o.cwd ?? proj, session: o.session }));
const asSession = (id: string) => ({ PI_SESSION_ID: id }); // what a bash tool call of that session exports, and so what `ark run start` sees
const product = () => join(proj, "src.ts");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ark-home-"));
  proj = mkdtempSync(join(tmpdir(), "ark-proj-"));
  writeFileSync(join(proj, "ark.yml"), "project: demo\n");
  mkdirSync(join(proj, ".omp"));
  writeFileSync(join(proj, ".omp", "config.yml"), OMP_CONFIG);
  mkdirSync(join(home, "projects", "demo", "tickets"), { recursive: true });
  for (const id of ["DEMO-7", "DEMO-8"]) writeFileSync(join(home, "projects", "demo", "tickets", `${id}.md`), ticket(id));
  expect(ark(["run", "start", "DEMO-7"], undefined, asSession("S1")).err).toBe("");
});

describe("ARK-115-AC10", () => {
  test("eval is blocked, and lsp only for the actions that can rewrite files", () => {
    expect(call("eval", { code: "1" }).err).toContain("eval can write any file");
    for (const action of ["rename", "rename_file", "code_actions", "request", "reload"]) {
      const input = { action, file: "src.ts", ...(action === "code_actions" ? { apply: true } : {}) };
      expect(call("lsp", input).code).toBe(1);
    }
    expect(call("lsp", { action: "rename", file: "src.ts", apply: false }).code).toBe(0); // a preview changes nothing
    expect(call("lsp", { action: "rename", file: "src.ts" }).code).toBe(1); // rename applies by default
    expect(call("lsp", { action: "code_actions", file: "src.ts" }).code).toBe(0); // lists by default
    expect(call("lsp", { action: "invented_future_action" }).code).toBe(1);
    expect(call("lsp", {}).code).toBe(1);
    expect(call("lsp", { action: "diagnostics", file: "*" }).code).toBe(0);
    expect(call("lsp", { action: "references", file: "src.ts", symbol: "x" }).code).toBe(0);
  });

  test("writable URLs that reach a file are blocked: conflict://, tool devices that run a guarded tool, and any other scheme; scratch and coordination URLs pass", () => {
    expect(call("write", { path: "conflict://1", content: "@ours" }).err).toContain("conflict");
    expect(call("write", { path: `${product()}:conflict://1`, content: "@ours" }).code).toBe(1);
    expect(call("write", { path: "xd://eval", content: JSON.stringify({ code: "1" }) }).code).toBe(1); // eval through the device transport
    expect(call("write", { path: "xd://write", content: JSON.stringify({ path: product(), content: "x" }) }).err).toContain("outside the active run folder");
    expect(call("write", { path: "xd://write", content: "not json" }).code).toBe(1);
    expect(call("write", { path: "vault://note.md", content: "x" }).code).toBe(1);
    expect(call("write", { path: "ssh://host/etc/x", content: "x" }).code).toBe(1);
    expect(call("write", { path: "local://scratch.md", content: "x" }).code).toBe(0);
    expect(call("write", { path: "[conflict://1#AB12]", content: "@ours" }).code).toBe(1); // hashline header around a conflict URL
    expect(call("write", { path: "cfg://tools.enabled", content: "x" }).code).toBe(1);
    expect(call("write", { path: "proc://job1", content: "rm -rf x\n" }).code).toBe(1); // stdin to a background job is exec
    expect(call("write", { path: "proc://job1/kill" }).code).toBe(0);
    expect(call("write", { path: "agent://Peer", content: "hi" }).code).toBe(0);
    expect(call("write", { path: "xd://report_issue", content: JSON.stringify({}) }).code).toBe(0);
  });

  test("an archive selector is resolved to its container: a symlink out of the run folder is caught, a plain container inside it is not", () => {
    const outside = join(proj, "outside.zip");
    writeFileSync(outside, "");
    symlinkSync(outside, join(dirOf("DEMO-7"), "linked.zip"));
    expect(call("write", { path: join(dirOf("DEMO-7"), "linked.zip:entry.txt"), content: "x" }).err).toContain("outside the active run folder");
    expect(call("write", { path: join(dirOf("DEMO-7"), "notes.zip:entry.txt"), content: "x" }).code).toBe(0);
    expect(call("edit", { path: `${product()}:10-20` }).code).toBe(1); // a line selector on a product file
    expect(call("write", { path: `[${product()}#AB12]`, content: "x" }).code).toBe(1); // hashline header around a product path
  });

  test("a session is bound to the run it started: stale, closed or missing pointers cannot free it, and another session's run does not bind a session with no run", () => {
    const pointer = join(home, "projects", "demo", "active-run");
    expect(call("write", { path: product() }, { session: "S1" }).err).toContain("outside the active run folder");

    writeFileSync(pointer, "2026-01-01-NOPE-1\n"); // stale pointer
    expect(call("write", { path: product() }, { session: "S1" }).code).toBe(1);

    expect(ark(["run", "start", "DEMO-8"], undefined, asSession("S2")).code).toBe(0); // another session starts and aborts a run: the pointer follows it
    expect(ark(["advance", runOf("DEMO-8"), "abort"]).code).toBe(0);
    expect(call("write", { path: product() }, { session: "S1" }).code).toBe(1); // pointer names a closed run

    rmSync(pointer);
    expect(call("write", { path: product() }, { session: "S1" }).code).toBe(1); // pointer missing
    expect(call("write", { path: join(dirOf("DEMO-7"), "plan.md") }, { session: "S1" }).code).toBe(0);
    expect(call("write", { path: product() }, { session: "S3" }).code).toBe(0); // a session with no binding and no pointer is not an Ark session

    const elsewhere = mkdtempSync(join(tmpdir(), "ark-away-")); // cwd outside any Ark project does not free a bound session either
    expect(call("write", { path: product() }, { session: "S1", cwd: elsewhere }).code).toBe(1);
    expect(call("write", { path: product() }, { session: "S3", cwd: elsewhere }).code).toBe(0);
  });

  test("a binding whose run is missing or has an unreadable state fails closed; a closed run frees the session until it starts another", () => {
    writeFileSync(join(dirOf("DEMO-7"), "state.json"), "{not json");
    expect(call("write", { path: product() }, { session: "S1" }).code).toBe(1);
    expect(ark(["run", "replay", runOf("DEMO-7")]).code).toBe(0); // repair the projection

    expect(ark(["run", "start", "DEMO-8"], undefined, asSession("S2")).code).toBe(0); // the pointer now names an open run of another session
    expect(ark(["advance", runOf("DEMO-7"), "abort"]).code).toBe(0);
    expect(call("write", { path: product() }, { session: "S1" }).code).toBe(0); // S1's run is closed; the pointer is not S1's
    expect(ark(["run", "start", "DEMO-8"], undefined, asSession("S1")).out).toContain("resumed"); // S1 takes DEMO-8
    expect(call("write", { path: product() }, { session: "S1" }).err).toContain("outside the active run folder");

    rmSync(dirOf("DEMO-8"), { recursive: true });
    expect(call("write", { path: product() }, { session: "S1" }).err).toContain("blocked");
  });

  test("with no session binding, a pointer to a missing run fails closed but still lets bash repair it; a closed run frees the session", () => {
    const pointer = join(home, "projects", "demo", "active-run");
    writeFileSync(pointer, "2026-01-01-NOPE-1\n");
    expect(call("write", { path: product() }).err).toContain("no such run");
    expect(call("eval", { code: "1" }).code).toBe(1);
    expect(call("bash", { command: "ark run start DEMO-7" }).code).toBe(0);
    expect(call("bash", { command: `echo x >> ${join(dirOf("DEMO-7"), "ledger.ndjson")}` }).code).toBe(1);

    writeFileSync(pointer, `${runOf("DEMO-7")}\n`);
    expect(ark(["advance", runOf("DEMO-7"), "abort"]).code).toBe(0);
    expect(call("write", { path: product() }).code).toBe(0);
  });

  test("ast_edit and edit are checked for directories, globs and rename targets, not only literal file paths", () => {
    const run = dirOf("DEMO-7");
    expect(call("ast_edit", { paths: [run] }).code).toBe(1); // the run folder itself reaches ws/ and the ledger
    expect(call("ast_edit", { paths: [join(run, "**/*.ts")] }).code).toBe(1);
    expect(call("ast_edit", { paths: [join(run, "*/demo/src/*.ts")] }).code).toBe(1);
    expect(call("ast_edit", { paths: [join(proj, "src/**/*.ts")] }).code).toBe(1);
    expect(call("ast_edit", { paths: [join(run, "inbox/*.json")] }).code).toBe(0); // a glob confined to a run subfolder
    expect(call("edit", { path: join(run, "plan.md"), edits: [{ rename: product() }] }).err).toContain("outside the active run folder");
    expect(call("edit", { path: join(run, "plan.md"), edits: [{ rename: join(run, "ws/demo/a.ts") }] }).code).toBe(1);
    expect(call("edit", { path: join(run, "plan.md"), edits: [{ rename: join(run, "plan2.md") }] }).code).toBe(0);
  });

  test("the extension reports the session id with every main-session call, and leaves subagents alone", () => {
    type Ctx = { cwd: string; agent: { kind: string }; sessionManager: { getSessionId(): string } };
    let handler!: (e: { toolName: string; input: unknown }, c: Ctx) => unknown;
    extension({ on: (_event, h) => { handler = h; } });
    const saved = process.env.ARK_HOME;
    process.env.ARK_HOME = home;
    const ctx = (kind: string, id: string): Ctx => ({ cwd: proj, agent: { kind }, sessionManager: { getSessionId: () => id } });
    try {
      expect(handler({ toolName: "eval", input: { code: "1" } }, ctx("main", "S1"))).toMatchObject({ block: true, reason: expect.stringContaining("eval") });
      expect(handler({ toolName: "lsp", input: { action: "rename", file: "src.ts" } }, ctx("main", "S1"))).toMatchObject({ block: true });
      rmSync(join(home, "projects", "demo", "active-run"));
      expect(handler({ toolName: "write", input: { path: product() } }, ctx("main", "S1"))).toMatchObject({ block: true }); // bound by the session id alone
      expect(handler({ toolName: "write", input: { path: product() } }, ctx("main", "S3"))).toBeUndefined(); // another session, nothing bound
      expect(handler({ toolName: "eval", input: { code: "1" } }, ctx("sub", "S1"))).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.ARK_HOME; else process.env.ARK_HOME = saved;
    }
  });
});
