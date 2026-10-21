import { appendFileSync } from "node:fs";

// Spike: prove the extension factory loads and session_start fires.
export default function ark(pi: any) {
  pi.on("session_start", async () => {
    appendFileSync("/tmp/ark-spike-ext.log", `session_start pid=${process.pid} cwd=${process.cwd()}\n`);
  });
}
