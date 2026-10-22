#!/usr/bin/env bun
import pkg from "../package.json" with { type: "json" };

const usage = `ark ${pkg.version}

Usage: ark <command> [options]

Commands:
  --version   Print the version
  --help      Print this help
`;

const [cmd] = process.argv.slice(2);

if (cmd === "--version") {
  console.log(pkg.version);
} else if (cmd === "--help" || cmd === "-h") {
  process.stdout.write(usage);
} else {
  process.stderr.write(`ark: unknown command '${cmd ?? ""}'\n\n${usage}`);
  process.exit(2);
}
