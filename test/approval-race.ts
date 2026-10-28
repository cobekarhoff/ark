import { closeSync, openSync, unlinkSync, writeFileSync, writeSync } from "node:fs";

// A first-in, first-out (FIFO) transcript rendezvous, not a replacement for an Ark service.
// Confirmation reads the transcript twice. Its subsequent verification reread opens the
// third pipe only after the real gate command has checked trace evidence and attribution.
const [transcriptFile, transcript, worktree] = process.argv.slice(2);
for (let readNumber = 1; readNumber <= 3; readNumber++) {
  const descriptor = openSync(transcriptFile, "w");
  try {
    unlinkSync(transcriptFile);
    if (readNumber === 3) {
      const result = Bun.spawnSync(["git", "-C", worktree, "commit", "--allow-empty", "-qm", "unproven concurrent commit"]);
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      writeFileSync(transcriptFile, transcript);
    } else {
      const result = Bun.spawnSync(["mkfifo", transcriptFile]);
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    }
    writeSync(descriptor, transcript);
  } finally {
    closeSync(descriptor);
  }
}
