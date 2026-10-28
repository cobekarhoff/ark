// Test support: runs a command with a real controlling terminal (a pty) and types a line when the command asks to confirm, the way a human answers
// `ark gate answer` or `ark run close` (ADR 0002). The command's own stdout and stderr go to the two files, so the terminal carries only the prompt.
// Usage: bun test/pty.ts <typed> <stdout-file> <stderr-file> <command> [args...]
import { existsSync, writeFileSync } from "node:fs";

const [typed, output, error, ...command] = process.argv.slice(2);
let seen = "";
let sent = false;
const childProcess = Bun.spawn(["sh", "-c", 'exec "$@" >"$ARK_PTY_OUT" 2>"$ARK_PTY_ERR"', "sh", ...command], {
  env: { ...process.env, ARK_PTY_OUT: output, ARK_PTY_ERR: error },
  terminal: {
    cols: 120,
    rows: 24,
    data(terminal, data) {
      seen += Buffer.from(data).toString();
      if (!sent && seen.includes("to confirm: ")) {
        const waiting = process.env.ARK_PTY_WAIT_FILE;
        const release = process.env.ARK_PTY_RELEASE_FILE;
        if (waiting && release) {
          sent = true;
          writeFileSync(waiting, "waiting\n");
          const timer = setInterval(() => {
            if (existsSync(release)) {
              clearInterval(timer);
              terminal.write(`${typed}\n`);
            }
          }, 10);
        } else {
          sent = true;
          terminal.write(`${typed}\n`);
        }
      }
    },
  },
});
process.exit(await childProcess.exited);
