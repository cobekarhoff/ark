// PROTOTYPE, throwaway. Shared scenario for every variant.
window.REPO_GRAPH_DATA = {
 "_note": "PROTOTYPE, made-up runs in real shapes: Clara pins and Smart QC submodules come from the real workspaces (2026-11-06). The repos block, bump steps and merge order are the proposed design.",
 "scenarios": {
  "clara": {
   "project": "clara",
   "merge_requests_setting": "none",
   "ticket": {
    "id": "CLA-12",
    "title": "Tenant manifests carry the report retention period from clara-core to the CancerGuard tenant"
   },
   "run": {
    "run": "2026-11-09-CLA-12-1",
    "phase": "building",
    "round": 1,
    "round_budget": 2,
    "outcome": null
   },
   "repos": [
    {
     "repo": "repos/shared/packages",
     "why": "changes clara-core: adds RetentionPolicy",
     "depends_on": []
    },
    {
     "repo": "repos/platform",
     "why": "tenant-manifest-service reads RetentionPolicy",
     "depends_on": [
      {
       "repo": "repos/shared/packages",
       "kind": "package",
       "pin": "clara-core>=0.0.5rc3,<1.0",
       "evidence": "repos/platform/services/tenant-manifest-service/pyproject.toml:11",
       "bump": {
        "step": "bump-platform-core",
        "to": "clara-core>=0.0.6rc1,<1.0 (after publish)",
        "status": "waits for upstream publish"
       }
      }
     ]
    },
    {
     "repo": "repos/tenants/cancerguard-us",
     "why": "sets the 7-year retention in the tenant manifest",
     "depends_on": [
      {
       "repo": "repos/shared/packages",
       "kind": "package",
       "pin": "clara-core>=0.0.5rc3",
       "evidence": "repos/tenants/cancerguard-us/pyproject.toml:10",
       "bump": {
        "step": "bump-tenant-core",
        "to": "clara-core>=0.0.6rc1 (after publish)",
        "status": "waits for upstream publish"
       }
      },
      {
       "repo": "repos/platform",
       "kind": "api",
       "pin": "tenant-manifest schema v3",
       "evidence": "repos/tenants/cancerguard-us/manifest/schema.json:1",
       "bump": null
      }
     ]
    },
    {
     "repo": "repos/end-to-end-tests",
     "why": "E2E: report shows retention end date",
     "depends_on": [
      {
       "repo": "repos/platform",
       "kind": "compose",
       "pin": "service tenant-manifest",
       "evidence": "docker-compose.yml:49",
       "bump": null
      },
      {
       "repo": "repos/tenants/cancerguard-us",
       "kind": "compose",
       "pin": "service tenant-cancerguard",
       "evidence": "docker-compose.yml:88",
       "bump": null
      }
     ]
    }
   ],
   "skew": [
    {
     "package": "@clara/core",
     "values": {
      "repos/platform": "0.0.6-rc1",
      "repos/domains/reports": "0.0.4-rc.0"
     },
     "note": "not touched by this ticket"
    }
   ],
   "steps": [
    {
     "id": "core-retention",
     "role": "implementer",
     "repo": "repos/shared/packages",
     "harness": "omp",
     "model": "anthropic/claude-sonnet-5-5",
     "needs": [],
     "status": "done",
     "criteria": [
      "CLA-12/AC1"
     ],
     "cost_usd": 0.62,
     "minutes": 14
    },
    {
     "id": "core-review",
     "role": "reviewer",
     "repo": "repos/shared/packages",
     "harness": "omp",
     "model": "openai-codex/gpt-6.1-sol",
     "needs": [
      "core-retention"
     ],
     "status": "done",
     "criteria": [],
     "cost_usd": 0.21,
     "minutes": 4
    },
    {
     "id": "platform-reads",
     "role": "implementer",
     "repo": "repos/platform",
     "harness": "omp",
     "model": "anthropic/claude-sonnet-5-5",
     "needs": [
      "core-retention"
     ],
     "status": "running",
     "criteria": [
      "CLA-12/AC2"
     ],
     "cost_usd": 0.41,
     "minutes": 9
    },
    {
     "id": "bump-platform-core",
     "role": "implementer",
     "repo": "repos/platform",
     "harness": "omp",
     "model": "anthropic/claude-sonnet-5-5",
     "needs": [
      "core-retention"
     ],
     "status": "waiting",
     "criteria": [],
     "bump": {
      "edge": "repos/shared/packages",
      "kind": "package"
     }
    },
    {
     "id": "tenant-retention",
     "role": "implementer",
     "repo": "repos/tenants/cancerguard-us",
     "harness": "omp",
     "model": "anthropic/claude-sonnet-5-5",
     "needs": [
      "core-retention",
      "platform-reads"
     ],
     "status": "pending",
     "criteria": [
      "CLA-12/AC3"
     ]
    },
    {
     "id": "bump-tenant-core",
     "role": "implementer",
     "repo": "repos/tenants/cancerguard-us",
     "harness": "omp",
     "model": "anthropic/claude-sonnet-5-5",
     "needs": [
      "core-retention"
     ],
     "status": "waiting",
     "criteria": [],
     "bump": {
      "edge": "repos/shared/packages",
      "kind": "package"
     }
    },
    {
     "id": "e2e-retention",
     "role": "validator",
     "repo": "repos/end-to-end-tests",
     "harness": "omp",
     "model": "anthropic/claude-sonnet-5-5",
     "needs": [
      "platform-reads",
      "tenant-retention"
     ],
     "status": "pending",
     "criteria": [
      "CLA-12/AC1",
      "CLA-12/AC2",
      "CLA-12/AC3"
     ]
    },
    {
     "id": "platform-review",
     "role": "reviewer",
     "repo": "repos/platform",
     "harness": "omp",
     "model": "openai-codex/gpt-6.1-sol",
     "needs": [
      "platform-reads",
      "e2e-retention"
     ],
     "status": "pending",
     "criteria": []
    },
    {
     "id": "tenant-review",
     "role": "reviewer",
     "repo": "repos/tenants/cancerguard-us",
     "harness": "omp",
     "model": "openai-codex/gpt-6.1-sol",
     "needs": [
      "tenant-retention",
      "e2e-retention"
     ],
     "status": "pending",
     "criteria": []
    }
   ],
   "merge_order": [
    "repos/shared/packages",
    "repos/platform",
    "repos/tenants/cancerguard-us",
    "repos/end-to-end-tests"
   ],
   "handoff": [
    {
     "repo": "repos/shared/packages",
     "branch": "ark/CLA-12-retention",
     "state": "ready"
    },
    {
     "repo": "repos/platform",
     "branch": "ark/CLA-12-retention",
     "state": "building"
    },
    {
     "repo": "repos/tenants/cancerguard-us",
     "branch": "ark/CLA-12-retention",
     "state": "not started"
    },
    {
     "repo": "repos/end-to-end-tests",
     "branch": "ark/CLA-12-retention",
     "state": "not started"
    }
   ]
  },
  "smart_qc": {
   "project": "smart-qc",
   "merge_requests_setting": "open (scenario; the real smart-qc is none)",
   "ticket": {
    "id": "SQC-7",
    "title": "The QC metrics app reads the new threshold profile from configuration-manager"
   },
   "run": {
    "run": "2026-11-10-SQC-7-1",
    "phase": "merge_requests_open",
    "round": 2,
    "round_budget": 2,
    "outcome": null
   },
   "repos": [
    {
     "repo": "repos/configuration-manager",
     "why": "adds threshold profiles",
     "depends_on": []
    },
    {
     "repo": "repos/qc-metrics-app",
     "why": "reads the profile",
     "depends_on": [
      {
       "repo": "repos/configuration-manager",
       "kind": "submodule",
       "pin": "configuration-manager @ 7e9f23f",
       "evidence": "repos/qc-metrics-app/.gitmodules:1",
       "bump": {
        "step": "bump-qcm-submodule",
        "to": "3c1d0aa (merged !41)",
        "status": "refreshed after !41 merged"
       }
      }
     ]
    },
    {
     "repo": "repos/qc-workflow-mocker",
     "why": "mocks a profile change event",
     "depends_on": [
      {
       "repo": "repos/configuration-manager",
       "kind": "submodule",
       "pin": "configuration-manager @ e84bdfc",
       "evidence": "repos/qc-workflow-mocker/.gitmodules:4",
       "bump": {
        "step": "bump-mocker-submodule",
        "to": "3c1d0aa (merged !41)",
        "status": "refreshed after !41 merged"
       }
      },
      {
       "repo": "repos/qc-metrics-app",
       "kind": "submodule",
       "pin": "qc-metrics-app @ b4d719c",
       "evidence": "repos/qc-workflow-mocker/.gitmodules:10",
       "bump": {
        "step": "bump-mocker-app",
        "to": "9a02e11 (branch head of !42)",
        "status": "refresh after !42 merges"
       }
      }
     ]
    }
   ],
   "steps": [
    {
     "id": "profiles",
     "role": "implementer",
     "repo": "repos/configuration-manager",
     "harness": "omp",
     "model": "anthropic/claude-sonnet-5-5",
     "needs": [],
     "status": "done",
     "criteria": [],
     "cost_usd": 0.55,
     "minutes": 12
    },
    {
     "id": "profiles-review",
     "role": "reviewer",
     "repo": "repos/configuration-manager",
     "harness": "omp",
     "model": "openai-codex/gpt-6.1-sol",
     "needs": [
      "profiles"
     ],
     "status": "done",
     "criteria": [],
     "cost_usd": 0.18,
     "minutes": 3
    },
    {
     "id": "bump-qcm-submodule",
     "role": "implementer",
     "repo": "repos/qc-metrics-app",
     "harness": "omp",
     "model": "anthropic/claude-sonnet-5-5",
     "needs": [
      "profiles"
     ],
     "status": "done",
     "criteria": [],
     "bump": {
      "edge": "repos/configuration-manager",
      "kind": "submodule"
     },
     "cost_usd": 0.05,
     "minutes": 1
    },
    {
     "id": "app-reads",
     "role": "implementer",
     "repo": "repos/qc-metrics-app",
     "harness": "omp",
     "model": "anthropic/claude-sonnet-5-5",
     "needs": [
      "bump-qcm-submodule"
     ],
     "status": "done",
     "criteria": [],
     "cost_usd": 0.71,
     "minutes": 18
    },
    {
     "id": "bump-mocker-submodule",
     "role": "implementer",
     "repo": "repos/qc-workflow-mocker",
     "harness": "omp",
     "model": "anthropic/claude-sonnet-5-5",
     "needs": [
      "profiles"
     ],
     "status": "done",
     "criteria": [],
     "bump": {
      "edge": "repos/configuration-manager",
      "kind": "submodule"
     },
     "cost_usd": 0.04,
     "minutes": 1
    },
    {
     "id": "bump-mocker-app",
     "role": "implementer",
     "repo": "repos/qc-workflow-mocker",
     "harness": "omp",
     "model": "anthropic/claude-sonnet-5-5",
     "needs": [
      "app-reads"
     ],
     "status": "done",
     "criteria": [],
     "bump": {
      "edge": "repos/qc-metrics-app",
      "kind": "submodule"
     },
     "cost_usd": 0.04,
     "minutes": 1
    },
    {
     "id": "mocker-event",
     "role": "implementer",
     "repo": "repos/qc-workflow-mocker",
     "harness": "omp",
     "model": "anthropic/claude-sonnet-5-5",
     "needs": [
      "bump-mocker-submodule",
      "bump-mocker-app"
     ],
     "status": "done",
     "criteria": [],
     "cost_usd": 0.33,
     "minutes": 8
    },
    {
     "id": "integration",
     "role": "validator",
     "repo": "repos/qc-metrics-app",
     "harness": "omp",
     "model": "anthropic/claude-sonnet-5-5",
     "needs": [
      "app-reads",
      "mocker-event"
     ],
     "status": "done",
     "criteria": [],
     "cost_usd": 0.48,
     "minutes": 15
    },
    {
     "id": "app-review",
     "role": "reviewer",
     "repo": "repos/qc-metrics-app",
     "harness": "omp",
     "model": "openai-codex/gpt-6.1-sol",
     "needs": [
      "app-reads",
      "integration"
     ],
     "status": "done",
     "criteria": [],
     "cost_usd": 0.26,
     "minutes": 5
    },
    {
     "id": "mocker-review",
     "role": "reviewer",
     "repo": "repos/qc-workflow-mocker",
     "harness": "omp",
     "model": "openai-codex/gpt-6.1-sol",
     "needs": [
      "mocker-event",
      "integration"
     ],
     "status": "done",
     "criteria": [],
     "cost_usd": 0.2,
     "minutes": 4
    }
   ],
   "merge_order": [
    "repos/configuration-manager",
    "repos/qc-metrics-app",
    "repos/qc-workflow-mocker"
   ],
   "merge_requests": [
    {
     "repo": "repos/configuration-manager",
     "number": 41,
     "state": "merged",
     "ci": "passed",
     "waits_for": []
    },
    {
     "repo": "repos/qc-metrics-app",
     "number": 42,
     "state": "open",
     "ci": "running",
     "waits_for": [
      41
     ],
     "note": "submodule refreshed to merged 3c1d0aa"
    },
    {
     "repo": "repos/qc-workflow-mocker",
     "number": 43,
     "state": "open",
     "ci": "failed",
     "waits_for": [
      41,
      42
     ],
     "note": "waits for !42; submodule qc-metrics-app still at branch head"
    }
   ]
  },
  "ark": {
   "project": "ark",
   "merge_requests_setting": "open",
   "ticket": {
    "id": "ARK-313",
    "title": "A test case writer designs the test cases and a test case reviewer checks them before the implementer starts"
   },
   "run": {
    "run": "2026-11-06-ARK-313-1",
    "phase": "building"
   },
   "repos": [
    {
     "repo": ".",
     "why": "single repo",
     "depends_on": []
    }
   ],
   "merge_order": [
    "."
   ],
   "note": "single-repo run: one lane, or the repo graph is hidden"
  }
 }
};
