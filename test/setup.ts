import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `ark preflight` reads the effective OMP config, which includes the machine's global ~/.omp/agent/config.yml.
// Point every test (and the ark processes it spawns) at an empty agent dir so a developer's own settings cannot change a result.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "ark-omp-agent-"));
// A test run started from inside an OMP session must not bind that session: each spawnArk call exports the fixture's own main session (test/tty.ts).
delete process.env.PI_SESSION_ID;
delete process.env.PI_SESSION_FILE;
