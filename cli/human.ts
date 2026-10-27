import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { userInfo } from "node:os";

// A human's answer counts only when typed on the controlling terminal (ADR 0002): a process without one, such as an agent's bash tool, cannot open /dev/tty.
// Opened first, so an agent is refused before anything else happens, and closed by `withTerminal`.
export function withTerminal<T>(what: string, fn: (confirm: (prompt: string, expected: string) => void) => T): T {
  let fd: number;
  try { fd = openSync("/dev/tty", "r+"); } catch {
    throw new Error(`${what} needs a human at a terminal (the name typed on /dev/tty); this process has no controlling terminal, so nothing was recorded (ADR 0002)`);
  }
  try {
    return fn((prompt, expected) => {
      writeSync(fd, prompt);
      const byte = Buffer.alloc(1);
      let typed = "";
      while (readSync(fd, byte, 0, 1, null) === 1 && byte[0] !== 10) typed += String.fromCharCode(byte[0]);
      if (typed.trim() !== expected) throw new Error(`typed '${typed.trim()}', expected '${expected}'; nothing was recorded`);
    });
  } finally { closeSync(fd); }
}

const git = (key: string) => Bun.spawnSync(["git", "config", key]).stdout.toString().trim();

// Who answered: the OS user and the git identity of the process the human typed in.
export function approver() {
  const [os_user, git_name, git_email] = [userInfo().username, git("user.name"), git("user.email")];
  if (!git_name || !git_email) throw new Error("git config user.name and user.email must be set to record the approver");
  return { by: `${git_name} <${git_email}> (${os_user})`, os_user, git_name, git_email };
}
