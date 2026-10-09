# Phase 0 S1: headless harness launch

Date: 2026-10-08. Method: pstack Prototype playbook. Throwaway scripts in `/tmp/ark-spikes/s1/` (not kept). Prompt contained no product data. Unsandboxed, per decision 44.

Result: **pass for both harnesses.** Ark can drive Claude Code and OMP as role attempts with the same adapter shape.

## Observations

| Check | Claude Code 2.1.261 | OMP 18.8.5 |
|---|---|---|
| Command | `claude -p "<prompt>" --output-format stream-json --verbose --permission-mode bypassPermissions` | `omp -p "<prompt>" --mode json --no-title` |
| Runs in given cwd, writes output file | Yes, `out.json` exact content | Yes, `out.json` exact content |
| Exit code on success | 0 | 0 |
| Wall time, trivial task | 7.8 s | 4.1 s |
| Event stream | JSONL; types `system` (init), `assistant`, `user`, `result`, `rate_limit_event` | JSONL; `session`, `agent_start/end`, `turn_*`, `message_*`, `tool_execution_*` |
| Session id | `system.init.session_id` and `result.session_id` | `session.id` (first line) |
| Model reported | `system.init.model`, `result.modelUsage` keys | `message_end.message.model` per assistant message |
| Usage and cost | `result.usage` tokens, `result.total_cost_usd` (run total) | Per assistant message: `usage` tokens and `usage.cost.total`; sum for run total |
| Tool calls visible | `assistant` content `tool_use` blocks | `tool_execution_start/end` with name and args |
| SIGTERM to harness pid | Exited in ≤2 s, status 143 | Exited in ≤2 s, status 143 |
| Shell child after SIGTERM | `sleep 97` child killed; no late write after 97 s | No late write after 97 s |

## Findings that change the design

1. **Long shell commands behave differently.** OMP auto-backgrounded `sleep 97` as an async job and ended the tool call immediately. Claude Code ran it in the foreground. The adapter must not treat "tool call ended" as "work done"; completion is the process exit plus a valid output file.
2. **Headless runs inherit the engineer's global config.** OMP loaded the user's MCP servers (Atlassian failed with 401 and logged a warning), extensions, and skills. Claude Code loaded installed plugins (112 tools, including pstack). Role attempts are therefore not reproducible from the manifest alone. Phase 1 adapter options: OMP `--no-extensions --no-skills --no-rules` or `--profile <ark-role>`; Claude Code `--settings`/`--strict-mcp-config`/`--allowedTools` (not yet verified). Record the effective config hash in the manifest either way.
3. **Model defaults differ by harness and come from user config** (Claude Code chose `claude-sonnet-5`, OMP `claude-opus-5-5`). Adapters must always pass `--model` explicitly from the role manifest.
4. **Cost is reported by both**, in different shapes (run total vs per message). The adapter normalizes to `agent.usage` events with `basis: reported`.
5. **Permissions:** headless Claude Code needs `--permission-mode bypassPermissions` (or an allowlist) to write files without prompting. OMP wrote without prompting by default. Both are unsandboxed; tamper detection after each attempt is the only control in Phases 0–1.

## Not tested here

- Enterprise model route (S2). Both runs used the engineer's current provider config.
- Reattach after ark restart. Neither CLI was tested for resume of a killed headless session; Phase 1 treats a dead attempt as interrupted and restarts it from validated inputs.
