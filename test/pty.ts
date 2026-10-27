// Test support: runs a command with a real controlling terminal (a pty) and types a line when the command asks to confirm, the way a human answers
// `ark gate answer` or `ark run close` (ADR 0002). The command's own stdout and stderr go to the two files, so the terminal carries only the prompt.
// Usage: bun test/pty.ts <typed> <stdout-file> <stderr-file> <command> [args...]
const [typed, out, err, ...cmd] = process.argv.slice(2);
let seen = "";
let sent = false;
const proc = Bun.spawn(["sh", "-c", 'exec "$@" >"$ARK_PTY_OUT" 2>"$ARK_PTY_ERR"', "sh", ...cmd], {
  env: { ...process.env, ARK_PTY_OUT: out, ARK_PTY_ERR: err },
  terminal: {
    cols: 120,
    rows: 24,
    data(terminal, data) {
      seen += Buffer.from(data).toString();
      if (!sent && seen.includes("to confirm: ")) {
        sent = true;
        terminal.write(`${typed}\n`);
      }
    },
  },
});
process.exit(await proc.exited);
