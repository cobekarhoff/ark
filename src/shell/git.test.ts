import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { env } from "node:process";
import type { AbsPath } from "../core/ids.ts";
import { git, gitFingerprint } from "./git.ts";
import { commit, initRepo, must, newRepo, put, withTmp } from "./repo-fixture.ts";

test("git() returns nonzero exits instead of throwing, and pipes stdin", async () => {
  await withTmp(async (dir) => {
    await initRepo(dir);
    const bad = await git(dir, ["rev-parse", "--verify", "nope"]);
    assert.notEqual(bad.code, 0);
    assert.ok(bad.stderr.length > 0);
    const h = await git(dir, ["hash-object", "--stdin"], { input: "hello\n" });
    assert.equal(h.stdout.trim(), "ce013625030ba8dba906f756967f9e9ca394464a");
  });
});

/** Raw git, deliberately NOT via git.ts: the control that proves a planted program really does run without the hardening. */
const rawGit = (dir: string, cmd: string): void => {
  const r = spawnSync("sh", ["-c", `git -c user.name=t -c user.email=t@example.invalid ${cmd}`], {
    cwd: dir, env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  assert.equal(r.status, 0);
};

const script = (marker: string): string => `#!/bin/sh\necho "$0" >> '${marker}'\nexit 0\n`;

const HOOKS = ["pre-commit", "post-commit", "post-checkout", "reference-transaction"];

const channels: readonly [string, (root: AbsPath, dir: AbsPath, marker: string) => Promise<void>][] = [
  ["core.hooksPath in .git/config", async (root, dir, marker) => {
    for (const h of HOOKS) await put(root, `hooks/${h}`, script(marker), 0o755);
    await must(dir, ["config", "core.hooksPath", join(root, "hooks")]);
  }],
  ["default .git/hooks", async (_root, dir, marker) => {
    for (const h of HOOKS) await put(dir, `.git/hooks/${h}`, script(marker), 0o755);
  }],
  ["core.fsmonitor in .git/config", async (_root, dir, marker) => {
    await put(dir, ".git/fsmon", script(marker), 0o755);
    await must(dir, ["config", "core.fsmonitor", join(dir, ".git", "fsmon")]);
  }],
];

for (const [name, plant] of channels) {
  test(`planted program (${name}) runs under bare git but never under git()`, async () => {
    await withTmp(async (root) => {
      const dir = await newRepo(root);
      await commit(dir, { "a.txt": "a\n" });
      const marker = join(root, "marker");
      await plant(root, dir, marker);

      rawGit(dir, "commit -q --allow-empty -m raw");
      rawGit(dir, "status --porcelain");
      assert.ok(existsSync(marker), "control: the planted program must fire under bare git, or this test proves nothing");
      await rm(marker);

      await commit(dir, { "b.txt": "b\n" });
      await must(dir, ["checkout", "-q", "-b", "other"]);
      await must(dir, ["status", "--porcelain"]);
      await must(dir, ["update-ref", "refs/heads/x", "HEAD"]);
      await gitFingerprint(dir);
      assert.equal(existsSync(marker), false, "a planted program ran during an ark git call");
    });
  });
}

test("gitFingerprint moves on config, hook, info/attributes and committed .gitattributes edits, not on ordinary work", async () => {
  await withTmp(async (root) => {
    const dir = await newRepo(root);
    await commit(dir, { "src/a.txt": "a\n" });
    const base = await gitFingerprint(dir);
    assert.equal(await gitFingerprint(dir), base);

    await commit(dir, { "src/a.txt": "changed\n", "src/new.txt": "n\n" });
    assert.equal(await gitFingerprint(dir), base, "ordinary commits do not move the fingerprint");

    const seen = new Set([base]);
    const expectNew = async (why: string): Promise<void> => {
      const fp = await gitFingerprint(dir);
      assert.ok(!seen.has(fp), `${why} must change the fingerprint`);
      seen.add(fp);
    };
    await must(dir, ["config", "filter.x.clean", "cat"]);
    await expectNew("a .git/config edit");
    await put(dir, ".git/hooks/pre-push", "#!/bin/sh\n", 0o755);
    await expectNew("a new hook");
    await put(dir, ".git/info/attributes", "*.txt export-ignore\n");
    await expectNew("info/attributes");
    await commit(dir, { "src/.gitattributes": "*.txt -text\n" });
    await expectNew("a committed .gitattributes");
    await commit(dir, { "src/.gitattributes": "*.txt text\n" });
    await expectNew("an edited .gitattributes");
  });
});

test("gitFingerprint reports planted symlinks (dangling, to a directory) as changes instead of throwing", async () => {
  await withTmp(async (root) => {
    const dir = await newRepo(root);
    await commit(dir, { "a.txt": "a\n" });
    const base = await gitFingerprint(dir);
    await symlink(join(root, "nowhere"), join(dir, ".git", "hooks", "post-merge"));
    const dangling = await gitFingerprint(dir);
    assert.notEqual(dangling, base);
    await symlink(root, join(dir, ".git", "hooks", "pre-push"));
    assert.notEqual(await gitFingerprint(dir), dangling);
  });
});
