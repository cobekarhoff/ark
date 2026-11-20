import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One row of the fake process table. */
export interface FakeProcess {
  pid: number;
  parentPid: number;
  rssKilobytes?: number;
  command: string;
  /** What `lsof -d cwd` reports for the pid; absent means `lsof` knows nothing of it. */
  workingFolder?: string;
}

const psScript = `#!/bin/sh
# Fake ps (ARK-569): answers from $ARK_FAKE_PS_DIR/table, one "<pid> <ppid> <rss KB> <command>" row each.
# Prints the columns of every -o in the order asked (pid, ppid, rss, command); -p <pid[,pid]> filters, and a file
# recheck-<pid> replaces the command of a -p answer.
dir="$ARK_FAKE_PS_DIR"
[ -e "$dir/ps-fails" ] && exit 1
filter=""
columns=""
while [ $# -gt 0 ]; do
  case "$1" in
    -p) filter=$2; shift ;;
    -o) columns="$columns,$2"; shift ;;
  esac
  shift
done
found=1
while read -r pid parent rss command; do
  [ -n "$pid" ] || continue
  if [ -n "$filter" ]; then
    case ",$filter," in *",$pid,"*) ;; *) continue ;; esac
    [ -e "$dir/recheck-$pid" ] && command=$(cat "$dir/recheck-$pid")
  fi
  line=""
  for column in $(echo "$columns" | tr ',' ' '); do
    case "\${column%=}" in
      pid) value=$pid ;;
      ppid) value=$parent ;;
      rss) value=$rss ;;
      command|args|comm) value=$command ;;
      *) value="" ;;
    esac
    line="$line $value"
  done
  echo "$line"
  found=0
done < "$dir/table"
[ -n "$filter" ] && exit $found
exit 0
`;

const lsofScript = `#!/bin/sh
# Fake lsof (ARK-569): the -F output of \`lsof -a -d cwd -Fn -p <pid[,pid]>\`, from $ARK_FAKE_PS_DIR/cwd-<pid>.
dir="$ARK_FAKE_PS_DIR"
[ -e "$dir/lsof-fails" ] && exit 1
list=""
while [ $# -gt 0 ]; do
  case "$1" in -p) list=$2; shift ;; esac
  shift
done
status=1
for pid in $(echo "$list" | tr ',' ' '); do
  [ -e "$dir/cwd-$pid" ] || continue
  printf 'p%s\\nfcwd\\nn%s\\n' "$pid" "$(cat "$dir/cwd-$pid")"
  status=0
done
exit $status
`;

/**
 * A fake `ps` and `lsof` over a table the test sets. Put `bin` first on PATH and pass `environment` to the process
 * that reads them. The real host has live orphaned bun test workers, so a test of a reader of them never reads the real `ps`.
 */
export function fakeProcesses() {
  const directory = mkdtempSync(join(tmpdir(), "ark-fake-ps-"));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  for (const [name, script] of [
    ["ps", psScript],
    ["lsof", lsofScript],
  ] as const) {
    writeFileSync(join(bin, name), script);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(directory, "table"), "");
  const flag = (name: string, on: boolean) =>
    on ? writeFileSync(join(directory, name), "") : rmSync(join(directory, name), { force: true });
  return {
    bin,
    environment: { ARK_FAKE_PS_DIR: directory },
    /** Replaces the table. */
    set(processes: FakeProcess[]) {
      writeFileSync(
        join(directory, "table"),
        processes
          .map(
            ({ pid, parentPid, rssKilobytes = 1024, command }) =>
              `${pid} ${parentPid} ${rssKilobytes} ${command}`,
          )
          .join("\n") + "\n",
      );
      for (const { pid, workingFolder } of processes)
        if (workingFolder === undefined) rmSync(join(directory, `cwd-${pid}`), { force: true });
        else writeFileSync(join(directory, `cwd-${pid}`), workingFolder);
    },
    /** `ps` exits 1 and prints nothing. */
    psFails: (on = true) => flag("ps-fails", on),
    /** `lsof` exits 1 and prints nothing. */
    lsofFails: (on = true) => flag("lsof-fails", on),
    /** A `ps -p <pid>` answer names `command` instead of the table's, as a pid that another process took over. */
    recheckAs(pid: number, command: string | null) {
      if (command === null) rmSync(join(directory, `recheck-${pid}`), { force: true });
      else writeFileSync(join(directory, `recheck-${pid}`), command);
    },
  };
}
