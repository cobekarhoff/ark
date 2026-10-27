import { beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "cli", "ark.ts");

// A fake gh serving the two GitHub API reads `ark doctor` makes. The protection answer is the file the test wrote, or GitHub's 404 for an unprotected branch.
const FAKE_GH = `#!/bin/sh
echo "$*" >> "$GH_LOG"
[ "$1" = api ] || { echo "fake gh: unexpected $*" >&2; exit 1; }
case "$2" in
  repos/acme/demo) echo '{"default_branch":"trunk","name":"demo"}' ;;
  repos/acme/demo/branches/trunk/protection)
    [ -f "$GH_PROTECTION" ] || { echo "gh: Branch not protected (HTTP 404)" >&2; exit 1; }
    cat "$GH_PROTECTION" ;;
  *) echo "fake gh: unexpected $*" >&2; exit 1 ;;
esac
`;

// What GitHub returns for a branch with every protection on (the shape the real cobekarhoff/ark main returns).
const PROTECTED = {
  required_status_checks: { strict: false, contexts: ["test"], checks: [{ context: "test", app_id: 15368 }] },
  required_pull_request_reviews: { required_approving_review_count: 0 },
  enforce_admins: { enabled: true },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
};

let root: string;
const ark = (protection?: unknown) => {
  const file = join(root, "protection.json");
  if (protection !== undefined) writeFileSync(file, JSON.stringify(protection));
  const r = Bun.spawnSync([process.execPath, CLI, "doctor"], {
    cwd: join(root, "proj"),
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, GH_LOG: join(root, "gh.log"), GH_PROTECTION: file },
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ark-doctor-"));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "gh"), FAKE_GH);
  chmodSync(join(root, "bin", "gh"), 0o755);
  mkdirSync(join(root, "proj"));
  writeFileSync(join(root, "proj", "ark.yml"), "project: demo\n");
  Bun.spawnSync(["git", "init", "-q"], { cwd: join(root, "proj") });
  Bun.spawnSync(["git", "remote", "add", "origin", "https://github.com/acme/demo.git"], { cwd: join(root, "proj") });
});

describe("ARK-118-AC3", () => {
  test("passes when the host's default branch includes admins, requires a PR and checks, and forbids force pushes", () => {
    const r = ark(PROTECTED);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("acme/demo trunk protected");
    // the default branch is read from the host (here 'trunk', not the local 'main'), and its protection from the documented endpoint
    expect(readFileSync(join(root, "gh.log"), "utf8").trim().split("\n")).toEqual(["api repos/acme/demo", "api repos/acme/demo/branches/trunk/protection"]);
  });

  const weakened: [string, (p: typeof PROTECTED) => unknown, string][] = [
    ["admins are not included", (p) => ({ ...p, enforce_admins: { enabled: false } }), "administrators are not included"],
    ["no PR is required", ({ required_pull_request_reviews, ...p }) => p, "pull requests are not required"],
    ["no check is required", (p) => ({ ...p, required_status_checks: { strict: false, contexts: [], checks: [] } }), "no status check is required"],
    ["status checks are absent", ({ required_status_checks, ...p }) => p, "no status check is required"],
    ["force pushes are allowed", (p) => ({ ...p, allow_force_pushes: { enabled: true } }), "force pushes are allowed"],
  ];
  for (const [name, weaken, reason] of weakened) {
    test(`fails when ${name}`, () => {
      const r = ark(weaken(PROTECTED));
      expect(r.code).toBe(1);
      expect(r.err).toContain(reason);
      expect(r.out).toBe("");
    });
  }

  test("names every missing protection at once", () => {
    const r = ark({ enforce_admins: { enabled: false }, allow_force_pushes: { enabled: true } });
    expect(r.code).toBe(1);
    for (const reason of ["administrators", "pull requests", "status check", "force pushes"]) expect(r.err).toContain(reason);
  });

  test("fails when the default branch has no protection at all (GitHub answers 404)", () => {
    const r = ark(); // no protection file
    expect(r.code).toBe(1);
    expect(r.err).toContain("Branch not protected");
  });
});
