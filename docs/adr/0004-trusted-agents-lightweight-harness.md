---
status: accepted
---

# Agents are trusted; the only hard line is that only a human merges

Ark's first design treated agents as possibly hostile. It ran the main session without a shell, stripped git credentials, confined writes with a tool-call hook, hash-chained the event log, and accepted a gate answer only with proof from the session transcript (ADRs 0002 and 0003). That machinery took most of the code and blocked most of the backlog, and it protected nothing that mattered: agents act on our behalf and we are responsible for what they do. The product repos are regulated, not Ark. They keep their own E2E tests and validation documents.

So agents get normal tools and normal credentials. Ark keeps one hard line, and the git host enforces it, not Ark: branch protection means only a human merges. Gate answers are whatever the human says in Master Chief's session or in Plannotator, recorded with `ark gate record`. The event log is a plain append-only file.

## Consequences

- `ark launch`, the hook, credential scans, human-proof checks, packet hashing and the hash chain are deleted (ARK-157).
- If Ark ever runs unattended on a shared machine, or must itself produce regulated records, this decision needs revisiting.
