import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { AbsPath, GitSha, Glob, RepoId, Sha256 } from "../core/ids.ts";
import { git } from "./git.ts";
import { changedPaths, descendsFrom, evidenceDigest, hashLocked, inspectLocks, inspectMaterialized, pathsOutside } from "./guard.ts";
import { commit, must, newRepo, put, rejects, withTmp } from "./repo-fixture.ts";

const REPO = "app" as RepoId;
const digest = (s: string): Sha256 => `sha256:${createHash("sha256").update(s).digest("hex")}` as Sha256;
const globs = (...g: string[]): Glob[] => g as Glob[];

/** A repo with an approved locked tree; returns the approved set measured at the base head. */
async function lockedRepo(root: AbsPath) {
  const dir = await newRepo(root);
  const base = await commit(dir, {
    "locked/check.sh": "assert 1\n",
    "locked/fixtures/data.json": "{}\n",
    "src/app.txt": "app\n",
    "outside/note.txt": "note\n",
  });
  const approved = await hashLocked(dir, REPO, base, ["locked"]);
  return { dir, base, approved };
}

test("pathsOutside: globs, dotfiles, and an empty allow-list", () => {
  const allowed = globs("src/**", "docs/*.md", "**/*.test.ts");
  assert.deepEqual(pathsOutside(["src/a.ts", "src/deep/er/b.ts", "src/.hidden", "docs/x.md", "pkg/a.test.ts", "a.test.ts"], allowed), []);
  assert.deepEqual(pathsOutside(["srcx/a.ts", "docs/sub/x.md", "docs/x.mdx", "src", "lib/a.ts", ".gitattributes"], allowed), ["srcx/a.ts", "docs/sub/x.md", "docs/x.mdx", "src", "lib/a.ts", ".gitattributes"]);
  assert.deepEqual(pathsOutside(["a"], []), ["a"]);
  assert.deepEqual(pathsOutside(["a+b.txt", "axb.txt"], globs("a+b.txt")), ["axb.txt"], "regex metacharacters are literal");
});

test("hashLocked measures every file under the roots by content hash; a missing root yields nothing", async () => {
  await withTmp(async (root) => {
    const { dir, base, approved } = await lockedRepo(root);
    assert.deepEqual(approved, {
      repo: REPO, roots: ["locked"],
      files: [{ path: "locked/check.sh", blob: digest("assert 1\n") }, { path: "locked/fixtures/data.json", blob: digest("{}\n") }],
    });
    assert.deepEqual((await hashLocked(dir, REPO, base, ["locked/check.sh"])).files.map((f) => f.path), ["locked/check.sh"], "a root may be one file");
    assert.deepEqual((await hashLocked(dir, REPO, base, ["nope"])).files, []);
    assert.deepEqual((await hashLocked(dir, REPO, base, [])).files, [], "no roots must not lock the whole repo");
    await rejects(hashLocked(dir, REPO, "0".repeat(40) as GitSha, ["locked"]), /ls-tree/);
  });
});

test("inspectLocks: untouched locks and ordinary source edits are clean", async () => {
  await withTmp(async (root) => {
    const { dir, approved } = await lockedRepo(root);
    const head = await commit(dir, { "src/app.txt": "edited\n", "src/new.txt": "n\n" });
    assert.deepEqual(await inspectLocks(dir, head, approved), []);
  });
});

test("inspectLocks: edited locked file => changed", async () => {
  await withTmp(async (root) => {
    const { dir, approved } = await lockedRepo(root);
    const head = await commit(dir, { "locked/check.sh": "assert 1  # weakened\n" });
    assert.deepEqual(await inspectLocks(dir, head, approved), [{ kind: "changed", repo: REPO, path: "locked/check.sh" }]);
  });
});

test("inspectLocks: deleted locked file => missing", async () => {
  await withTmp(async (root) => {
    const { dir, approved } = await lockedRepo(root);
    const head = await commit(dir, { "locked/fixtures/data.json": null });
    assert.deepEqual(await inspectLocks(dir, head, approved), [{ kind: "missing", repo: REPO, path: "locked/fixtures/data.json" }]);
  });
});

test("inspectLocks: file ADDED under a locked root => added, even though no approved file changed", async () => {
  await withTmp(async (root) => {
    const { dir, approved } = await lockedRepo(root);
    const head = await commit(dir, { "locked/fixtures/shadow.json": "{\"shadow\":1}\n" });
    assert.deepEqual(await inspectLocks(dir, head, approved), [{ kind: "added", repo: REPO, path: "locked/fixtures/shadow.json" }]);
  });
});

test("inspectLocks: a locked file renamed away is missing; a file renamed in from outside is added", async () => {
  await withTmp(async (root) => {
    const { dir, approved } = await lockedRepo(root);
    await must(dir, ["mv", "locked/check.sh", "src/check.sh"]);
    await must(dir, ["mv", "outside/note.txt", "locked/note.txt"]);
    const head = await commit(dir, {});
    assert.deepEqual(await inspectLocks(dir, head, approved), [
      { kind: "missing", repo: REPO, path: "locked/check.sh" },
      { kind: "added", repo: REPO, path: "locked/note.txt" },
    ]);
  });
});

test("changedPaths lists BOTH sides of a rename, so a file moved into scope from outside is caught", async () => {
  await withTmp(async (root) => {
    const dir = await newRepo(root);
    const base = await commit(dir, { "outside/secret.txt": "x\nx\nx\nx\n", "scope/keep.txt": "k\n" });
    await must(dir, ["mv", "outside/secret.txt", "scope/secret.txt"]);
    const head = await commit(dir, {});
    const changed = await changedPaths(dir, base, head);
    assert.deepEqual([...changed], ["outside/secret.txt", "scope/secret.txt"]);
    assert.deepEqual(pathsOutside(changed, globs("scope/**")), ["outside/secret.txt"]);

    // Why the flag matters: with rename detection on, only the destination is listed and the move slips through.
    const detected = (await git(dir, ["diff", "-M", "--name-only", "-z", base, head])).stdout.split("\0").filter(Boolean);
    assert.deepEqual(detected, ["scope/secret.txt"]);
    assert.deepEqual(pathsOutside(detected, globs("scope/**")), []);
  });
});

test("changedPaths is NUL-safe for awkward names", async () => {
  await withTmp(async (root) => {
    const dir = await newRepo(root);
    const base = await commit(dir, { "a.txt": "a\n" });
    const head = await commit(dir, { "dir with space/new\nline.txt": "n\n", "ünï.txt": "u\n" });
    assert.deepEqual([...(await changedPaths(dir, base, head))].sort(), ["dir with space/new\nline.txt", "ünï.txt"]);
  });
});

test("descendsFrom: a fast-forward descends; a rewritten history does not", async () => {
  await withTmp(async (root) => {
    const dir = await newRepo(root);
    const c1 = await commit(dir, { "a.txt": "1\n" });
    const base = await commit(dir, { "a.txt": "2\n" });
    const fwd = await commit(dir, { "a.txt": "3\n" });
    assert.equal(await descendsFrom(dir, base, fwd), true);
    assert.equal(await descendsFrom(dir, base, base), true);

    await must(dir, ["reset", "-q", "--hard", c1]); //     the agent rewinds and rebuilds on the older commit
    const rewritten = await commit(dir, { "a.txt": "rewritten\n" });
    assert.equal(await descendsFrom(dir, base, rewritten), false);
    assert.equal(await descendsFrom(dir, rewritten, base), false);
    await rejects(descendsFrom(dir, "0".repeat(40) as GitSha, rewritten), /merge-base/);
  });
});

/** Materialize `head` exactly as verify does: `git archive` into a clean directory. */
async function materialize(root: AbsPath, dir: AbsPath, head: GitSha, name: string): Promise<AbsPath> {
  const out = join(root, name) as AbsPath;
  await mkdir(out);
  const tar = join(root, `${name}.tar`);
  const r = await git(dir, ["archive", "--format=tar", `--output=${tar}`, head]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(spawnSync("tar", ["-xf", tar, "-C", out]).status, 0);
  return out;
}

test("inspectMaterialized: clean archive passes; .gitattributes export-ignore on a locked file is invisible to inspectLocks but caught", async () => {
  await withTmp(async (root) => {
    const { dir, base, approved } = await lockedRepo(root);
    assert.deepEqual(await inspectMaterialized(await materialize(root, dir, base, "clean"), approved), []);

    const head = await commit(dir, { ".gitattributes": "locked/check.sh export-ignore\n" });
    assert.deepEqual(await inspectLocks(dir, head, approved), [], "the git objects are unchanged: the object-level check cannot see it");
    const out = await materialize(root, dir, head, "ignored");
    assert.deepEqual(await inspectMaterialized(out, approved), [{ kind: "missing", repo: REPO, path: "locked/check.sh" }]);
  });
});

test("inspectMaterialized: export-subst rewrites bytes (changed); an extra file (added); a symlink is hashed, not followed", async () => {
  await withTmp(async (root) => {
    const dir = await newRepo(root);
    const base = await commit(dir, { "locked/stamp.txt": "rev $Format:%H$\n", "locked/a.txt": "a\n" });
    const approved = await hashLocked(dir, REPO, base, ["locked"]);
    const head = await commit(dir, { ".gitattributes": "locked/stamp.txt export-subst\n" });
    const out = await materialize(root, dir, head, "subst");
    assert.deepEqual(await inspectMaterialized(out, approved), [{ kind: "changed", repo: REPO, path: "locked/stamp.txt" }]);

    await put(out, "locked/extra.sh", "evil\n");
    await symlink("/etc", join(out, "locked", "etc-link"));
    const v = await inspectMaterialized(out, approved);
    assert.deepEqual(v.map((x) => `${x.kind}:${x.path}`), ["added:locked/etc-link", "added:locked/extra.sh", "changed:locked/stamp.txt"]);

    await rejects(inspectMaterialized(out, { ...approved, roots: ["../escape"] }), /invalid locked root/);
  });
});

/** An evidence bundle the way verify writes it. */
async function bundle(dir: AbsPath, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) await put(dir, rel, content);
  await put(dir, "SHA256SUMS", Object.entries(files).map(([rel, c]) => `${digest(c).slice("sha256:".length)}  ${rel}\n`).join(""));
}

test("evidenceDigest: verified bundle yields sha256 of SHA256SUMS; missing, rewritten or unlisted-escape yield null", async () => {
  await withTmp(async (root) => {
    const dir = join(root, "ev") as AbsPath;
    await bundle(dir, { "verification.json": "{\"outcome\":\"fail\"}\n", "logs/check.log": "boom\n" });
    const ok = await evidenceDigest(dir);
    assert.match(ok ?? "", /^sha256:[0-9a-f]{64}$/);

    await put(dir, "logs/check.log", "boom (edited by QE)\n");
    assert.equal(await evidenceDigest(dir), null, "a rewritten file");
    await put(dir, "logs/check.log", "boom\n");
    assert.equal(await evidenceDigest(dir), ok, "restored bytes verify again, same digest");

    await put(dir, "SHA256SUMS", `${"0".repeat(64)}  ghost.log\n`);
    assert.equal(await evidenceDigest(dir), null, "a listed file that does not exist");
    await put(dir, "SHA256SUMS", `${digest("x").slice(7)}  ../outside.txt\n`);
    assert.equal(await evidenceDigest(dir), null, "a path that escapes the bundle");
    await put(dir, "SHA256SUMS", "not a sums line\n");
    assert.equal(await evidenceDigest(dir), null, "a malformed line");
    assert.equal(await evidenceDigest(join(root, "no-such-dir") as AbsPath), null, "no SHA256SUMS");
  });
});

test("evidenceDigest changes when SHA256SUMS itself is rewritten consistently", async () => {
  await withTmp(async (root) => {
    const dir = join(root, "ev") as AbsPath;
    await bundle(dir, { "a.log": "one\n" });
    const first = await evidenceDigest(dir);
    await bundle(dir, { "a.log": "two\n" }); // a consistent rewrite verifies, but the ledger-held digest no longer matches
    const second = await evidenceDigest(dir);
    assert.ok(first !== null && second !== null && first !== second);
  });
});
