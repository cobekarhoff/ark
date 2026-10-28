import { beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COMMAND_LINE_FILE = join(import.meta.dir, "..", "cli", "ark.ts");

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
  required_pull_request_reviews: { required_approving_review_count: 0, bypass_pull_request_allowances: { users: [], teams: [], apps: [] } },
  enforce_admins: { enabled: true },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
};

let root: string;
const ark = (protection?: unknown) => {
  const file = join(root, "protection.json");
  if (protection !== undefined) writeFileSync(file, JSON.stringify(protection));
  const result = Bun.spawnSync([process.execPath, COMMAND_LINE_FILE, "doctor"], {
    cwd: join(root, "proj"),
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, GH_LOG: join(root, "gh.log"), GH_PROTECTION: file },
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
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
    const result = ark(PROTECTED);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(result.out).toContain("acme/demo trunk protected");
    expect(result.out).toContain("no bypass allowances"); // the success line claims only what was checked
    // the default branch is read from the host (here 'trunk', not the local 'main'), and its protection from the documented endpoint
    expect(readFileSync(join(root, "gh.log"), "utf8").trim().split("\n")).toEqual(["api repos/acme/demo", "api repos/acme/demo/branches/trunk/protection"]);
  });

  const weakened: [string, (protection: typeof PROTECTED) => unknown, string][] = [
    ["admins are not included", (protection) => ({ ...protection, enforce_admins: { enabled: false } }), "administrators are not included"],
    ["no PR is required", ({ required_pull_request_reviews, ...protection }) => protection, "pull requests are not required"],
    ["no check is required", (protection) => ({ ...protection, required_status_checks: { strict: false, contexts: [], checks: [] } }), "no status check is required"],
    ["status checks are absent", ({ required_status_checks, ...protection }) => protection, "no status check is required"],
    ["a user may bypass the PR requirement", (protection) => ({ ...protection, required_pull_request_reviews: { ...protection.required_pull_request_reviews, bypass_pull_request_allowances: { users: [{ login: "operator" }], teams: [], apps: [] } } }), "bypass the pull request requirement: user operator"],
    ["a team may bypass the PR requirement", (protection) => ({ ...protection, required_pull_request_reviews: { ...protection.required_pull_request_reviews, bypass_pull_request_allowances: { users: [], teams: [{ slug: "admins" }], apps: [] } } }), "team admins"],
    ["an app may bypass the PR requirement", (protection) => ({ ...protection, required_pull_request_reviews: { ...protection.required_pull_request_reviews, bypass_pull_request_allowances: { users: [], teams: [], apps: [{ slug: "release-bot" }] } } }), "app release-bot"],
    ["deleting the branch is allowed", (protection) => ({ ...protection, allow_deletions: { enabled: true } }), "deleting the branch is allowed"],
    ["force pushes are allowed", (protection) => ({ ...protection, allow_force_pushes: { enabled: true } }), "force pushes are allowed"],
  ];
  for (const [name, weaken, reason] of weakened) {
    test(`fails when ${name}`, () => {
      const result = ark(weaken(PROTECTED));
      expect(result.code).toBe(1);
      expect(result.err).toContain(reason);
      expect(result.out).toBe("");
    });
  }

  test("names every missing protection at once", () => {
    const result = ark({ enforce_admins: { enabled: false }, allow_force_pushes: { enabled: true } });
    expect(result.code).toBe(1);
    for (const reason of ["administrators", "pull requests", "status check", "force pushes"]) expect(result.err).toContain(reason);
  });

  test("fails when the default branch has no protection at all (GitHub answers 404)", () => {
    const result = ark(); // no protection file
    expect(result.code).toBe(1);
    expect(result.err).toContain("Branch not protected");
  });
});
