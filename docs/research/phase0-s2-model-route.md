# Phase 0 S2: model route

Date: 2026-10-08. Result: **settled by operator decision.**

- Model route approval is environment policy. The pilot environment approved the engineer's existing Anthropic account (as used by Claude Code and OMP today) for Phases 0–1.
- S1 already proved one call through each harness on that account (Claude Code `claude-sonnet-5`, OMP `claude-opus-5-5`).
- Role manifests record the approved provider route. Adapters pass `--model` explicitly; no harness default is trusted.
- Bedrock is not required for Phases 0–1. Revisit if the approval changes or when a second environment onboards.
