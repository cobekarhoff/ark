# ARK-293 AC4: live check of a real prompt wait

The run lead started one throwaway agent outside a run worktree, in a temp folder whose `.omp/config.yml` sets `tools.approvalMode: always-ask`, with the prompt `Run exactly one shell command: echo hi. Nothing else.` The agent stopped at the approval prompt (`Allow tool: bash Command: echo hi`). While it waited, `orca worktree ps --agent-wait --json` listed it. The run lead never approved the prompt and killed the agent.

Raw JSON of the agent entry (also `test/fixtures/orca-agent-wait.json`, byte for byte):

```json
{
  "paneKey": "c6e5df18-78a6-48a8-8d00-af2f0b5e87d0:8bb78def-a219-4f62-9994-79b0523a21c1",
  "parentPaneKey": null,
  "state": "blocked",
  "agentType": "omp",
  "prompt": "Run exactly one shell command: echo hi. Nothing else.",
  "taskTitle": null,
  "displayName": null,
  "conversationName": "ark293-probe",
  "lastAssistantMessage": null,
  "toolName": "bash",
  "toolInput": null,
  "interrupted": false,
  "stateStartedAt": 1793854050861,
  "updatedAt": 1793854050861,
  "hasLivePty": true,
  "programStatus": {
    "state": "blocked",
    "kind": "permission",
    "message": "Allow tool: bash Command: echo hi",
    "observedAt": 1793854050867
  },
  "agentWait": {
    "source": "hook",
    "since": 1793854050861
  }
}
```

Findings:

- `agentWait` is an object `{ "source": "hook", "since": <ms> }` during a real prompt, never null. `state` is `blocked`, and `programStatus.kind` is `permission`.
- `activityOf` (`hub/sources.ts`) gives `{ "kind": "waiting", "text": "waiting on a prompt", "last_line": null }` for this entry, with no change to its logic: `agentWait` is truthy and `state` is `blocked`, so both rules hold. Only its doc comment changed, to name the real `agentWait` shape.
- The hub shows this text for it on the run page row and in Stuck agents: `waiting on a prompt`.
- `test/hub.test.ts` (`ARK-293-AC4`) gives the entry to `activityOf` and expects the kind `waiting`, also with `state` set to `working`, so the `agentWait` rule alone is proven.

The human ok came from Master Chief (LASO).

human: ok
