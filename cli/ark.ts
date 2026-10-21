#!/usr/bin/env bun
console.log(JSON.stringify({
  ok: true,
  argv: process.argv.slice(2),
  bun: Bun.version,
  script: import.meta.path,
  cwd: process.cwd(),
}));
