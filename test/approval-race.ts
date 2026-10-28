#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Git invokes this real filesystem-monitor hook for each status check. The first
// two checks validate attribution and capture the trace head. The third is the
// final attribution status check, after the trace has already validated its head.
const counterFile = process.env.ARK_RACE_COUNTER!;
const worktree = process.env.ARK_RACE_WORKTREE!;
const count = Number(existsSync(counterFile) ? readFileSync(counterFile, "utf8") : "0") + 1;
writeFileSync(counterFile, String(count));
if (count === 3) {
  const git = (...argumentsList: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "core.fsmonitor=false", "-C", worktree, ...argumentsList]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  const provenHead = git("rev-parse", "HEAD");
  const unprovenHead = git("commit-tree", `${provenHead}^{tree}`, "-p", provenHead, "-m", "unproven concurrent commit");
  git("update-ref", "HEAD", unprovenHead, provenHead);
}
// Version two of Git's filesystem-monitor protocol: a token and a full rescan.
process.stdout.write(`approval-race-${count}\0/\0`);
