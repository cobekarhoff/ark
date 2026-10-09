# Strands Box assessment for ark

Status: documentation assessment only. No installation, runtime smoke, or backend adoption has occurred.

## Primary sources

- [Overview and platform support](https://strandsagents.com/docs/user-guide/box/)
- [Security model and residual risks](https://strandsagents.com/docs/user-guide/box/security/index.md)
- [Configuration reference](https://strandsagents.com/docs/user-guide/box/reference/configuration/index.md)
- [Claude Code integration guide](https://strandsagents.com/docs/user-guide/box/guides/run-claude-code/index.md)

## Fit

The overview documents a harness-agnostic local workload runner using macOS Seatbelt filesystem enforcement, a deny-by-default Dogwood policy engine, an egress gateway, credential placeholder injection, and MCP brokering. This fits ark's requirement to enforce role permissions outside the harness without importing the Strands agent framework into the orchestrator.

The Claude Code guide demonstrates CLI integration with Bedrock and policy-controlled shell access. It is upstream documentation, not proof of ark's own integration. OMP compatibility has not been established here.

## Constraints that affect the design

| Documented property | Ark implication |
| --- | --- |
| Pre-release 0.1.x; policy/configuration/CLI vocabulary may change | Pin binary version/digest and generated configuration/policy hashes per run. Upgrade deliberately. |
| Supports macOS 15+ on Apple silicon; Linux not yet supported; Windows unsupported | A Box-only implementation initially limits the supported host platform. Keep OS scope explicit; do not claim portable execution. |
| Direct native file tools follow OS grants but bypass Dogwood decisions/records | Enforce protected checks with filesystem grants, not only policy. Never infer a complete file-access audit from Box telemetry. |
| Every process inside a box can use every credential binding | Separate each role/attempt into its own box. Do not mix inference, forge publication, and cloud provisioning credentials in one box. |
| `aws://PROFILE` refuses SSO, role_arn, and credential_process profiles | Establish the approved enterprise auth route. `credsd://` is documented as another route, but its compatibility with the actual corporate setup remains unverified. |
| `network.contain_egress = false` bypasses gateway policy and injection | No permissive native-egress fallback to make a harness work. Evaluate exceptions explicitly under environment policy. |
| Box records are best-effort, unsigned, not an audit trail | Import them as attributed observational telemetry only. Ark's ledger and trusted verification output remain authoritative for orchestration/evidence. |
| Box imposes no process/CPU/memory/disk limits | Ark still owns deadlines and concurrency limits. Do not claim Box supplies resource containment comparable to configured container limits. |
| SIGINT/SIGTERM/SIGHUP are handled; documentation warns against SIGKILL on box run | Implement backend-specific cancellation and reconcile completion before releasing worktree/resource ownership. |
| Sandbox write grants cannot restore file timestamps | Smoke package installation, archive extraction, build tooling, and git/worktree interactions before adoption. |
| Policy history persists in a box directory across runs | Use attempt-scoped boxes to avoid hidden cross-role/history state; record any deliberate reuse. |

## Recommended integration, not yet selected

Box can be the first macOS sandbox backend for role jobs. Keep project services on their existing Compose/emulator tasks, managed by the trusted verification runner. Keep the ark orchestrator and approval state independent of Box. Do not require Box or the Strands agent SDK from every harness adapter.

Before claiming either initial harness works: smoke real Claude Code and OMP jobs through the actual enterprise inference route, exercise native and shell-based attempts to modify protected checks, inspect denied egress, and confirm cancellation/recovery. These are ordinary integration/security checks, not the factory eval program removed during Q42.
