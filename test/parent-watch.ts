// ARK-569: thread of a `bun test` worker (started by tmpdir-preload.ts). It runs on its own thread so that a worker blocked
// in a synchronous call (readFileSync of a pipe) still ends when its coordinator is gone. process.exit in a thread
// ends only the thread, so the whole process is killed.
import { workerData } from "node:worker_threads";

const parentAtStart: number = workerData;
setInterval(() => {
  if (process.ppid !== parentAtStart) process.kill(process.pid, "SIGKILL");
}, 2000);
