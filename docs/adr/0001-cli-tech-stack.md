# Architecture decision record (ADR) 0001: TypeScript on Bun for the Ark command-line interface (CLI)

Status: accepted, 2026-10-21
Evidence: ARK-101 spike (plugin install from Git, CLI on PATH, typed tools)

## Context

Ark has four code surfaces: the `ark` CLI, the Oh My Pi (OMP) hook shim, typed OMP tools, and the Ark Console. They share the same JSON Schemas: ticket, acceptance criteria (`ac`), state, ledger event and agent outputs. Ark ships as one OMP plugin installed from Git (functional requirement, FR-24). The CLI must be deterministic (non-functional requirement, NFR-01) and must contain no harness-specific logic (NFR-03).

## Decision

All four surfaces are written in TypeScript and run on Bun. The CLI is a `#!/usr/bin/env bun` `.ts` file with no build step.

## Why

- **OMP forces TypeScript for half of Ark.** Extensions, hooks and `tools/` modules are TypeScript or JavaScript modules loaded by OMP's embedded Bun. Any other CLI language means maintaining two languages and duplicating the schema types.
- **Git install with no build.** ARK-101 showed that `omp plugin install github:…` copies the tree and links `bin`, and the `.ts` bin runs as-is. Nothing is compiled per platform and there is no release pipeline before dogfooding.
- **Typed tools can run the CLI in-process or by path** (`import.meta.dir`), so agents get schema-checked calls rather than raw bash.
- **Fast enough.** A cold Bun shim ran in about 20 ms (ARK-101), which is fine for a hook on every tool call.
- **Determinism is a property of the code, not the language.** Sorted keys, no wall-clock reads in projections, and fixture tests apply in any language.

## Alternatives

| Option | For | Against |
| --- | --- | --- |
| Python (uv) | The team's product stacks (CLARA: pytest, Behave) are Python; quality assurance (QA) and engineers read it easily | Hooks and tools still have to be TypeScript, so there are two languages and two schema bindings. It also needs a second install path (`uv tool install`) beside the plugin, plus a Python runtime on every machine |
| Rust | Single static binary, fastest startup, strong correctness | A per-platform build and release pipeline before the first run. A Git plugin install cannot ship a binary without a build step. Slower iteration for the agents writing it, and hooks and tools are still TypeScript |
| Go | Static binary, simple | Same packaging and two-language costs as Rust, with less benefit |

## Consequences

- `bun` must be on PATH for the shebang, and `ark doctor` checks for it (ARK-101-AC4).
- The plugin install does not put `ark` on PATH, so setup creates a symlink. Developers use `bun link` (ARK-101-AC2).
- Revisit this if Ark is ported off OMP (NFR-03) or if hook latency becomes measurable. The CLI core has no OMP imports, so a rewrite of the CLI alone stays possible.
