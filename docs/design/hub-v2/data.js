window.HUB_DATA = {
  _note:
    "Prototype data for hub-v2. Real shapes from /api/snapshot plus made-up states (review_queue, stuck, usage, progress) that the hub does not have yet.",
  generated_at: "2026-11-03T13:48:04.021Z",
  runs: [
    {
      run: "2026-11-03-ARK-284-1",
      project: "ark",
      ticket: {
        id: "ARK-284",
        title:
          "The run page shows every run, open or closed, with its decisions and each agent's transcript, and a live agent opens in Orca",
      },
      phase: "building",
      round: 1,
      started_at: "2026-11-03T13:27:58.046Z",
      updated_at: "2026-11-03T13:40:39.137Z",
      plan: [
        {
          id: "hub-run-page",
          role: "implementer",
          harness: "omp",
          model: "anthropic/claude-sonnet-5-5",
          needs: [],
          status: "running",
          cost_usd: 1.6333351400000007,
          started_at: "2026-11-03T13:40:39.137Z",
          waiting: null,
        },
        {
          id: "hub-run-page-tests",
          role: "validator",
          harness: "omp",
          model: "anthropic/claude-sonnet-5-5",
          needs: ["hub-run-page"],
          status: "pending",
          cost_usd: null,
          started_at: null,
          waiting: null,
        },
        {
          id: "hub-live-check",
          role: "validator",
          harness: "omp",
          model: "anthropic/claude-sonnet-5-5",
          needs: ["hub-run-page-tests"],
          status: "pending",
          cost_usd: null,
          started_at: null,
          waiting: null,
        },
        {
          id: "hub-run-page-review",
          role: "reviewer",
          harness: "omp",
          model: "anthropic/claude-sonnet-5-5",
          needs: ["hub-run-page", "hub-run-page-tests", "hub-live-check"],
          status: "pending",
          cost_usd: null,
          started_at: null,
          waiting: null,
        },
      ],
      merge_requests: [],
      agents: [
        {
          role: "Master Chief",
          harness: "omp",
          model: null,
          title: "Master Chief: ark tickets",
          step: null,
          planned: {
            harness: "omp",
            model: "anthropic/claude-sonnet-5-5",
            source: "configured",
          },
        },
        {
          role: "run lead",
          harness: null,
          model: null,
          title: "Ark run 2026-11-03-ARK-284-1",
          step: null,
          planned: {
            harness: "omp",
            model: "anthropic/claude-sonnet-5-5",
            source: "configured",
          },
        },
        {
          role: "implementer",
          harness: null,
          model: null,
          title: "hub-run-page (implementer, .)",
          step: "hub-run-page",
          planned: {
            harness: "omp",
            model: "anthropic/claude-sonnet-5-5",
            source: "plan",
          },
        },
      ],
      waiting: [],
      cost_usd: 2.71227238,
    },
    {
      run: "2026-11-03-ARK-282-1",
      project: "ark",
      ticket: {
        id: "ARK-282",
        title:
          "ark plan check rejects a step whose harness and model are not in roles, and a worker that never started costs no round",
      },
      phase: "building",
      round: 1,
      started_at: "2026-11-03T13:09:57.071Z",
      updated_at: "2026-11-03T13:45:20.588Z",
      plan: [
        {
          id: "plan-pair-and-not-started",
          role: "implementer",
          harness: "omp",
          model: "anthropic/claude-sonnet-5-5",
          needs: [],
          status: "succeeded",
          cost_usd: 0.52004668,
          started_at: "2026-11-03T13:12:25.749Z",
          waiting: null,
        },
        {
          id: "pair-and-not-started-tests",
          role: "validator",
          harness: "omp",
          model: "anthropic/claude-sonnet-5-5",
          needs: ["plan-pair-and-not-started"],
          status: "succeeded",
          cost_usd: 0.5390148600000001,
          started_at: "2026-11-03T13:21:43.682Z",
          waiting: null,
        },
        {
          id: "pair-and-not-started-review",
          role: "reviewer",
          harness: "omp",
          model: "anthropic/claude-sonnet-5-5",
          needs: ["plan-pair-and-not-started", "pair-and-not-started-tests"],
          status: "pending",
          cost_usd: null,
          started_at: null,
          waiting: null,
        },
      ],
      merge_requests: [],
      agents: [
        {
          role: "Master Chief",
          harness: "omp",
          model: null,
          title: "Master Chief: ark tickets",
          step: null,
          planned: {
            harness: "omp",
            model: "anthropic/claude-sonnet-5-5",
            source: "configured",
          },
        },
        {
          role: "run lead",
          harness: null,
          model: null,
          title: "Ark run 2026-11-03-ARK-282-1",
          step: null,
          planned: {
            harness: "omp",
            model: "anthropic/claude-sonnet-5-5",
            source: "configured",
          },
        },
      ],
      waiting: [],
      cost_usd: 1.67021354,
    },
    {
      run: "2026-11-03-ARK-281-1",
      project: "ark",
      ticket: {
        id: "ARK-281",
        title:
          "The auto-merger waits for the run lead's final report and skips a PR whose ticket is not live",
      },
      phase: "building",
      round: 1,
      started_at: "2026-11-03T13:09:56.798Z",
      updated_at: "2026-11-03T13:28:25.921Z",
      plan: [
        {
          id: "auto-merger-gate",
          role: "implementer",
          harness: "omp",
          model: "anthropic/claude-sonnet-5-5",
          needs: [],
          status: "succeeded",
          cost_usd: 0.1349713,
          started_at: "2026-11-03T13:12:31.663Z",
          waiting: null,
        },
        {
          id: "auto-merger-tests",
          role: "validator",
          harness: "omp",
          model: "anthropic/claude-sonnet-5-5",
          needs: ["auto-merger-gate"],
          status: "succeeded",
          cost_usd: 0.28153952,
          started_at: "2026-11-03T13:13:13.276Z",
          waiting: null,
        },
        {
          id: "auto-merger-review",
          role: "reviewer",
          harness: "omp",
          model: "anthropic/claude-sonnet-5-5",
          needs: ["auto-merger-gate", "auto-merger-tests"],
          status: "pending",
          cost_usd: null,
          started_at: null,
          waiting: null,
        },
      ],
      merge_requests: [],
      agents: [
        {
          role: "Master Chief",
          harness: "omp",
          model: null,
          title: "Master Chief: ark tickets",
          step: null,
          planned: {
            harness: "omp",
            model: "anthropic/claude-sonnet-5-5",
            source: "configured",
          },
        },
        {
          role: "run lead",
          harness: null,
          model: null,
          title: "Ark run 2026-11-03-ARK-281-1",
          step: null,
          planned: {
            harness: "omp",
            model: "anthropic/claude-sonnet-5-5",
            source: "configured",
          },
        },
      ],
      waiting: [],
      cost_usd: 1.0878828199999997,
    },
    {
      run: "2026-11-03-ARK-280-1",
      project: "ark",
      ticket: {
        id: "ARK-280",
        title:
          "Run workers start in a permission mode that needs no human approval, scoped to the run worktree",
      },
      phase: "building",
      round: 1,
      started_at: "2026-11-03T13:09:55.795Z",
      updated_at: "2026-11-03T13:29:51.262Z",
      plan: [
        {
          id: "permission-measure",
          role: "implementer",
          harness: "omp",
          model: "anthropic/claude-sonnet-5-5",
          needs: [],
          status: "succeeded",
          cost_usd: 0.0757831,
          started_at: "2026-11-03T13:13:59.370Z",
          waiting: null,
        },
        {
          id: "worktree-setting",
          role: "implementer",
          harness: "omp",
          model: "anthropic/claude-sonnet-5-5",
          needs: ["permission-measure"],
          status: "succeeded",
          cost_usd: 0.40899968,
          started_at: "2026-11-03T13:14:20.282Z",
          waiting: null,
        },
        {
          id: "permission-tests",
          role: "validator",
          harness: "omp",
          model: "anthropic/claude-sonnet-5-5",
          needs: ["worktree-setting"],
          status: "running",
          cost_usd: 0.45835606000000007,
          started_at: "2026-11-03T13:29:51.262Z",
          waiting: null,
        },
        {
          id: "permission-review",
          role: "reviewer",
          harness: "omp",
          model: "anthropic/claude-sonnet-5-5",
          needs: ["worktree-setting", "permission-tests"],
          status: "pending",
          cost_usd: null,
          started_at: null,
          waiting: null,
        },
      ],
      merge_requests: [],
      agents: [
        {
          role: "Master Chief",
          harness: "omp",
          model: null,
          title: "Master Chief: ark tickets",
          step: null,
          planned: {
            harness: "omp",
            model: "anthropic/claude-sonnet-5-5",
            source: "configured",
          },
        },
        {
          role: "run lead",
          harness: null,
          model: null,
          title: "Ark run 2026-11-03-ARK-280-1",
          step: null,
          planned: {
            harness: "omp",
            model: "anthropic/claude-sonnet-5-5",
            source: "configured",
          },
        },
        {
          role: "validator",
          harness: null,
          model: null,
          title: "permission-tests (validator, .)",
          step: "permission-tests",
          planned: {
            harness: "omp",
            model: "anthropic/claude-sonnet-5-5",
            source: "plan",
          },
        },
      ],
      waiting: [],
      cost_usd: 1.8239397400000004,
    },
    {
      run: "2026-11-03-ARK-188-1",
      project: "ark",
      ticket: {
        id: "ARK-188",
        title:
          "Worktrees: unique branch names across days, cleanup after a squash merge, and a stop on uncommitted changes",
      },
      phase: "escalation",
      round: 2,
      started_at: "2026-11-03T13:09:57.767Z",
      updated_at: "2026-11-03T13:46:57.960Z",
      plan: [
        {
          id: "worktree-fixes",
          role: "implementer",
          harness: "omp",
          model: "anthropic/claude-sonnet-5-5",
          needs: [],
          status: "succeeded",
          cost_usd: 0.74616658,
          started_at: "2026-11-03T13:46:20.537Z",
          waiting: null,
        },
        {
          id: "worktree-tests",
          role: "validator",
          harness: "omp",
          model: "anthropic/claude-sonnet-5-5",
          needs: ["worktree-fixes"],
          status: "succeeded",
          cost_usd: 0.26547484,
          started_at: "2026-11-03T13:18:01.072Z",
          waiting: null,
        },
        {
          id: "worktree-checks",
          role: "reviewer",
          harness: "omp",
          model: "anthropic/claude-sonnet-5-5",
          needs: ["worktree-fixes", "worktree-tests"],
          status: "pending",
          cost_usd: null,
          started_at: null,
          waiting: null,
        },
      ],
      merge_requests: [],
      agents: [
        {
          role: "Master Chief",
          harness: "omp",
          model: null,
          title: "Master Chief: ark tickets",
          step: null,
          planned: {
            harness: "omp",
            model: "anthropic/claude-sonnet-5-5",
            source: "configured",
          },
        },
        {
          role: "run lead",
          harness: null,
          model: null,
          title: "Ark run 2026-11-03-ARK-188-1",
          step: null,
          planned: {
            harness: "omp",
            model: "anthropic/claude-sonnet-5-5",
            source: "configured",
          },
        },
      ],
      waiting: [],
      cost_usd: 1.5964089199999993,
    },
  ],
  gates: [
    {
      id: "gate:2026-11-03-ARK-188-1:escalation",
      run: "2026-11-03-ARK-188-1",
      project: "ark",
      ticket: "ARK-188",
      kind: "escalation",
      question:
        'Escalation on "Worktrees: unique branch names across days, cleanup after a squash merge, and a stop on uncommitted changes": decide how to go on',
      review_url: null,
      since: "2026-11-03T13:46:57.960Z",
    },
  ],
  ticket_runs: [
    {
      project: "ark",
      ticket: "ARK-284",
      run: "2026-11-03-ARK-284-1",
      phase: "building",
      waiting: false,
      cost_usd: 2.71227238,
    },
    {
      project: "ark",
      ticket: "ARK-282",
      run: "2026-11-03-ARK-282-1",
      phase: "building",
      waiting: false,
      cost_usd: 1.67021354,
    },
    {
      project: "ark",
      ticket: "ARK-281",
      run: "2026-11-03-ARK-281-1",
      phase: "building",
      waiting: false,
      cost_usd: 1.0878828199999997,
    },
    {
      project: "ark",
      ticket: "ARK-280",
      run: "2026-11-03-ARK-280-1",
      phase: "building",
      waiting: false,
      cost_usd: 1.8239397400000004,
    },
    {
      project: "ark",
      ticket: "ARK-188",
      run: "2026-11-03-ARK-188-1",
      phase: "escalation",
      waiting: false,
      cost_usd: 1.5964089199999993,
    },
    {
      project: "ark",
      ticket: "ARK-279",
      run: "2026-11-02-ARK-279-1",
      phase: "closed",
      waiting: false,
      cost_usd: 2.664554,
    },
    {
      project: "ark",
      ticket: "ARK-278",
      run: "2026-11-02-ARK-278-1",
      phase: "closed",
      waiting: false,
      cost_usd: 2.434173,
    },
    {
      project: "ark",
      ticket: "ARK-277",
      run: "2026-11-02-ARK-277-1",
      phase: "closed",
      waiting: false,
      cost_usd: 13.894852,
    },
    {
      project: "ark",
      ticket: "ARK-276",
      run: "2026-11-02-ARK-276-1",
      phase: "closed",
      waiting: false,
      cost_usd: 1.902234,
    },
    {
      project: "ark",
      ticket: "ARK-275",
      run: "2026-11-02-ARK-275-1",
      phase: "closed",
      waiting: false,
      cost_usd: 1.208078,
    },
    {
      project: "ark",
      ticket: "ARK-258",
      run: "2026-11-02-ARK-258-1",
      phase: "closed",
      waiting: false,
      cost_usd: 1.135119,
    },
    {
      project: "ark",
      ticket: "ARK-251",
      run: "2026-11-02-ARK-251-1",
      phase: "closed",
      waiting: false,
      cost_usd: null,
    },
    {
      project: "ark",
      ticket: "ARK-246",
      run: "2026-11-02-ARK-246-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.807712,
    },
    {
      project: "ark",
      ticket: "ARK-245",
      run: "2026-11-02-ARK-245-1",
      phase: "closed",
      waiting: false,
      cost_usd: null,
    },
    {
      project: "ark",
      ticket: "ARK-244",
      run: "2026-11-02-ARK-244-1",
      phase: "closed",
      waiting: false,
      cost_usd: 1.88901,
    },
    {
      project: "ark",
      ticket: "ARK-243",
      run: "2026-11-02-ARK-243-1",
      phase: "closed",
      waiting: false,
      cost_usd: 3.824262,
    },
    {
      project: "ark",
      ticket: "ARK-242",
      run: "2026-11-02-ARK-242-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.651349,
    },
    {
      project: "ark",
      ticket: "ARK-241",
      run: "2026-11-02-ARK-241-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.591868,
    },
    {
      project: "ark",
      ticket: "ARK-240",
      run: "2026-11-02-ARK-240-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.367635,
    },
    {
      project: "ark",
      ticket: "ARK-239",
      run: "2026-11-02-ARK-239-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.489742,
    },
    {
      project: "ark",
      ticket: "ARK-238",
      run: "2026-11-02-ARK-238-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.497162,
    },
    {
      project: "ark",
      ticket: "ARK-237",
      run: "2026-11-02-ARK-237-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.38371,
    },
    {
      project: "ark",
      ticket: "ARK-236",
      run: "2026-11-02-ARK-236-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.413259,
    },
    {
      project: "ark",
      ticket: "ARK-235",
      run: "2026-11-02-ARK-235-1",
      phase: "closed",
      waiting: false,
      cost_usd: 1.292816,
    },
    {
      project: "ark",
      ticket: "ARK-234",
      run: "2026-11-02-ARK-234-1",
      phase: "closed",
      waiting: false,
      cost_usd: 1.522929,
    },
    {
      project: "ark",
      ticket: "ARK-233",
      run: "2026-11-02-ARK-233-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.661904,
    },
    {
      project: "ark",
      ticket: "ARK-232",
      run: "2026-11-02-ARK-232-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.656987,
    },
    {
      project: "ark",
      ticket: "ARK-231",
      run: "2026-11-02-ARK-231-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.380988,
    },
    {
      project: "ark",
      ticket: "ARK-229",
      run: "2026-11-02-ARK-229-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.438683,
    },
    {
      project: "ark",
      ticket: "ARK-228",
      run: "2026-11-02-ARK-228-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.360028,
    },
    {
      project: "ark",
      ticket: "ARK-209",
      run: "2026-11-02-ARK-209-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.992461,
    },
    {
      project: "ark",
      ticket: "ARK-207",
      run: "2026-11-02-ARK-207-1",
      phase: "closed",
      waiting: false,
      cost_usd: 1.362047,
    },
    {
      project: "ark",
      ticket: "ARK-198",
      run: "2026-11-02-ARK-198-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.86061,
    },
    {
      project: "ark",
      ticket: "ARK-183",
      run: "2026-11-02-ARK-183-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.922971,
    },
    {
      project: "ark",
      ticket: "ARK-230",
      run: "2026-11-01-ARK-230-1",
      phase: "closed",
      waiting: false,
      cost_usd: 3.067831,
    },
    {
      project: "ark",
      ticket: "ARK-227",
      run: "2026-11-01-ARK-227-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.475165,
    },
    {
      project: "ark",
      ticket: "ARK-217",
      run: "2026-11-01-ARK-217-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.504165,
    },
    {
      project: "ark",
      ticket: "ARK-216",
      run: "2026-11-01-ARK-216-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.449259,
    },
    {
      project: "ark",
      ticket: "ARK-215",
      run: "2026-11-01-ARK-215-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.863555,
    },
    {
      project: "ark",
      ticket: "ARK-214",
      run: "2026-11-01-ARK-214-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.416038,
    },
    {
      project: "ark",
      ticket: "ARK-213",
      run: "2026-11-01-ARK-213-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.399088,
    },
    {
      project: "ark",
      ticket: "ARK-212",
      run: "2026-11-01-ARK-212-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.548956,
    },
    {
      project: "ark",
      ticket: "ARK-211",
      run: "2026-11-01-ARK-211-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.890916,
    },
    {
      project: "ark",
      ticket: "ARK-210",
      run: "2026-11-01-ARK-210-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.981482,
    },
    {
      project: "ark",
      ticket: "ARK-208",
      run: "2026-11-01-ARK-208-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.985053,
    },
    {
      project: "ark",
      ticket: "ARK-199",
      run: "2026-11-01-ARK-199-1",
      phase: "closed",
      waiting: false,
      cost_usd: 2.018017,
    },
    {
      project: "ark",
      ticket: "ARK-184",
      run: "2026-11-01-ARK-184-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.478983,
    },
    {
      project: "ark",
      ticket: "ARK-181",
      run: "2026-11-01-ARK-181-1",
      phase: "closed",
      waiting: false,
      cost_usd: 2.344376,
    },
    {
      project: "ark",
      ticket: "ARK-180",
      run: "2026-11-01-ARK-180-1",
      phase: "closed",
      waiting: false,
      cost_usd: 3.795362,
    },
    {
      project: "ark",
      ticket: "ARK-179",
      run: "2026-11-01-ARK-179-1",
      phase: "closed",
      waiting: false,
      cost_usd: 2.816017,
    },
    {
      project: "ark",
      ticket: "ARK-178",
      run: "2026-11-01-ARK-178-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.842101,
    },
    {
      project: "ark",
      ticket: "ARK-177",
      run: "2026-11-01-ARK-177-1",
      phase: "closed",
      waiting: false,
      cost_usd: 1.606143,
    },
    {
      project: "ark",
      ticket: "ARK-174",
      run: "2026-11-01-ARK-174-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.379258,
    },
    {
      project: "ark",
      ticket: "ARK-182",
      run: "2026-10-31-ARK-182-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.76859,
    },
    {
      project: "ark",
      ticket: "ARK-176",
      run: "2026-10-31-ARK-176-1",
      phase: "closed",
      waiting: false,
      cost_usd: 3.632252,
    },
    {
      project: "ark",
      ticket: "ARK-175",
      run: "2026-10-31-ARK-175-1",
      phase: "closed",
      waiting: false,
      cost_usd: 1.827217,
    },
    {
      project: "ark",
      ticket: "ARK-173",
      run: "2026-10-31-ARK-173-1",
      phase: "closed",
      waiting: false,
      cost_usd: 2.489641,
    },
    {
      project: "ark",
      ticket: "ARK-172",
      run: "2026-10-31-ARK-172-1",
      phase: "closed",
      waiting: false,
      cost_usd: 1.515975,
    },
    {
      project: "ark",
      ticket: "ARK-171",
      run: "2026-10-31-ARK-171-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.780066,
    },
    {
      project: "ark",
      ticket: "ARK-170",
      run: "2026-10-31-ARK-170-1",
      phase: "closed",
      waiting: false,
      cost_usd: 1.039021,
    },
    {
      project: "ark",
      ticket: "ARK-169",
      run: "2026-10-30-ARK-169-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.120664,
    },
    {
      project: "ark",
      ticket: "ARK-168",
      run: "2026-10-30-ARK-168-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.59652,
    },
    {
      project: "ark",
      ticket: "ARK-167",
      run: "2026-10-30-ARK-167-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.309711,
    },
    {
      project: "ark",
      ticket: "ARK-166",
      run: "2026-10-30-ARK-166-2",
      phase: "closed",
      waiting: false,
      cost_usd: 0.437428,
    },
    {
      project: "ark",
      ticket: "ARK-163",
      run: "2026-10-30-ARK-163-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.066693,
    },
    {
      project: "ark",
      ticket: "ARK-165",
      run: "2026-10-29-ARK-165-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.508199,
    },
    {
      project: "ark",
      ticket: "ARK-164",
      run: "2026-10-29-ARK-164-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.150776,
    },
    {
      project: "ark",
      ticket: "ARK-162",
      run: "2026-10-29-ARK-162-1",
      phase: "closed",
      waiting: false,
      cost_usd: 0.123009,
    },
  ],
  tickets: [
    {
      project: "ark",
      id: "ARK-158",
      title: "Bootstrap playbook; pytest and behave parsers; onboard Clara",
      status: "in_progress",
      milestone: "M2",
      depends_on: ["ARK-156"],
      body: {
        problem: "",
        change: "",
        criteria: [],
      },
    },
    {
      project: "ark",
      id: "ARK-159",
      title: "First Clara ticket across repos to MRs in DAG order",
      status: "ready",
      milestone: "M2",
      depends_on: ["ARK-158"],
      body: {
        problem: "",
        change: "",
        criteria: [],
      },
    },
    {
      project: "ark",
      id: "ARK-185",
      title: "Design block: update stale docs and close two plan check gaps",
      status: "ready",
      milestone: "M1",
      depends_on: ["ARK-282"],
      body: {
        problem:
          'Run 2026-10-31-ARK-171-1 added the design block. Its review left 1 P2 and 4 P3 findings in the code (`findings/plan-design-review.md`):\n\n- P2: the `ark plan check` help text in `cli/ark.ts` line 58 still says that only a missing summary makes a plan not valid.\n- P3: docs/explanation/architecture.md and docs/how-to/run-a-ticket.md do not mention the design rules or the Design section.\n- P3: an `example` that holds a code fence breaks the `plan.md` layout.\n- P3: a blank caller such as `callers: [""]` passes the check.\n- P3: the ARK-171-AC5 playbook test pins prose.',
        change:
          "1. Update the `ark plan check` help text in `cli/ark.ts`, and generate the command reference again.\n2. In `cli/plan.ts`, refuse a blank caller. Render `example` with a fence that is longer than every fence inside it.\n3. Update architecture.md and run-a-ticket.md.\n4. Replace or remove the ARK-171-AC5 test that pins prose (`rules/test-audit.md`).",
        criteria: [
          {
            id: "ARK-185-AC1",
            text: "The help text of `ark plan check` shall name each reason that makes a plan not valid, including a missing `design.interfaces` and an interface with no `callers`.",
          },
          {
            id: "ARK-185-AC2",
            text: "If an interface's `callers` list holds an empty or blank string, then `ark plan check` shall refuse the plan.",
          },
          {
            id: "ARK-185-AC3",
            text: "When a design `example` holds a code fence, `ark plan check` shall render the Steps heading and the steps table of `plan.md` outside of every fence.",
          },
          {
            id: "ARK-185-AC4",
            text: "The documents docs/explanation/architecture.md and docs/how-to/run-a-ticket.md shall describe the design block rules and the Design section of `plan.md` (live human check).",
          },
        ],
      },
    },
    {
      project: "ark",
      id: "ARK-186",
      title: "Report the actual model of each step and flag same-vendor review",
      status: "proposed",
      milestone: "M3",
      depends_on: [],
      body: {
        problem:
          "The plan names a model for each step, but the harness can fail over to another model. In run 2026-10-31-ARK-171-1, the plan put the implementer on `gpt-6-astra` and the validator and the reviewer on `gpt-6-luna`. The Codex quota was exhausted, and OMP moved every step to `claude-sonnet-5-5`. Cross-vendor review did not hold. The run lead's first retro said OpenAI. Master Chief corrected it from `cost.by_model`.",
        change:
          "1. In `cli/retro.ts`, collect the models of each step's session messages into `actual_models`.\n2. Compare them with `plan.yml`, and print a line for each step whose model changed.\n3. Find the vendor of each model from its ID (`claude-*` is Anthropic, `gpt-*` is OpenAI). Set `same_vendor_review`. Report it. Do not enforce it, as the PRD non-goal says.\n4. Update the `metrics.json` description in docs/reference/cli.md and the retro playbook.",
        criteria: [
          {
            id: "ARK-186-AC1",
            text: "The `metrics.json` that `ark retro` writes shall have `actual_models`, a map from step ID to the list of models that the step's sessions used.",
          },
          {
            id: "ARK-186-AC2",
            text: "If the actual models of a step differ from its model in `plan.yml`, then `ark retro` shall print a line that names the step, the plan model and the actual models.",
          },
          {
            id: "ARK-186-AC3",
            text: "If a validator or reviewer step ran on a model of the same vendor as an implementer step in the same repo, then `ark retro` shall set `same_vendor_review` to true in `metrics.json` and name the steps in its output; otherwise `ark retro` shall set it to false.",
          },
        ],
      },
    },
    {
      project: "ark",
      id: "ARK-187",
      title:
        "Run state: an unchanged plan keeps its approval, and the playbooks close an aborted run correctly",
      status: "ready",
      milestone: "M1",
      depends_on: ["ARK-282"],
      body: {
        problem:
          'A repeat `ark plan check` clears the plan approval, also when `plan.yml` did not change. In `cli/events.ts:123-125`, each `plan.checked` event sets `planApproved = false` and does not compare the hash. In run 2026-10-30-ARK-166-2, the plan hash stayed the same, but the approval was cleared. `step.finished` was then refused.\n\nThe run-lead playbook sends an aborted run to section 11 "with outcome `failed`" (`skills/ark/playbooks/run-lead.md:273`). `failed` is not an outcome. `cli/transitions.ts:4` accepts only `merged`, `abandoned`, `aborted` and `handed_off`. `ark run close <run> aborted` is already accepted in every open phase when no MR exists (`cli/transitions.ts:118-131`). But no playbook says that the human can abort before escalation. In run 2026-10-30-ARK-163-1, the run lead tried `ark gate record escalation abort` in phase `building`, and the command refused it.',
        change:
          "1. In `cli/events.ts`, keep `planApproved` when a `plan.checked` event has the same `plan_hash` as the plan that was approved. Clear it when the hash is different.\n2. In run-lead.md, replace the outcome `failed` with `aborted`. Add one sentence: the human can abort in any phase before an MR opens, and the run lead then runs `ark run close <run> aborted`.\n3. Add a playbook contract test. The test reads each `ark run close <run> <outcome>` in `skills/ark/playbooks/*.md` and checks the outcome against `outcomes` in `cli/transitions.ts`.",
        criteria: [
          {
            id: "ARK-187-AC1",
            text: "When `ark plan check` runs again on an unchanged `plan.yml` after `gate.answered plan approve`, the run shall keep its plan approval, and `ark run step <run> <step> start` shall be accepted.",
          },
          {
            id: "ARK-187-AC2",
            text: "When `ark plan check` runs on a changed `plan.yml` after `gate.answered plan approve`, the run shall lose its plan approval, and `ark run step <run> <step> start` shall be refused with a message that names the plan gate.",
          },
          {
            id: "ARK-187-AC3",
            text: "The playbooks shall give `ark run close` only outcomes that `ark run close` accepts.",
          },
          {
            id: "ARK-187-AC4",
            text: "The run-lead playbook shall tell the run lead that the human can abort in any phase before an MR opens, and that the run lead then runs `ark run close <run> aborted` (live human check).",
          },
        ],
      },
    },
    {
      project: "ark",
      id: "ARK-188",
      title:
        "Worktrees: unique branch names across days, cleanup after a squash merge, and a stop on uncommitted changes",
      status: "ready",
      milestone: "M1",
      depends_on: [],
      body: {
        problem:
          "Three worktree problems came out of retros, and none of them became a ticket.\n\n1. **Branch names collide on a later day.** `branchName` in `cli/worktree.ts:29-38` takes the run number from the run ID. The run number starts again at 1 each date. A second run of a ticket on a new day gets the same branch as the first run, and `git worktree add -b` fails when that branch still exists.\n2. **A squash merge keeps the branch.** At close, `cli/worktree.ts:141-153` deletes a branch only when `git merge-base --is-ancestor <branch> origin/<target>` passes. After a squash merge the branch is never an ancestor, so the branch stays.\n3. **Uncommitted changes are lost.** In run 2026-10-29-ARK-165-1, the workspace had a modified `run-lead.md`. `ark worktree create` branched from `HEAD` without that change, and a merge conflict followed when the MR landed.",
        change:
          '1. In `branchName`, check the local and `origin` branches. Add the lowest free `-<n>` suffix from 2. Remove the run-number suffix.\n2. In run close cleanup, treat a branch as merged when `ark merge-request status` reports the MR as merged, or when the ancestor check passes. When `git fetch` fails and the MR state is not known, keep the branch and print the reason. Today the code ignores a failed fetch with the comment "best effort" (`cli/worktree.ts:142`).\n3. In `ark worktree create`, run `git status --porcelain` in each source repo. When the output is not empty, print the paths and exit 1. Add the flag `--allow-dirty`, which prints the paths as a warning and continues.\n4. Update docs/reference/cli.md and the `worktree create` row in run-lead.md.',
        criteria: [
          {
            id: "ARK-188-AC1",
            text: "If the branch `ark/<ticket id>-<slug>` already exists locally or on `origin`, then `ark worktree create` shall create the branch `ark/<ticket id>-<slug>-<n>` with the lowest free `n` from 2, and record that branch in the `worktree.created` event.",
          },
          {
            id: "ARK-188-AC2",
            text: "When `ark merge-request status` reports the MR of a repo as merged, `ark run close <run> merged` shall delete the local branch of that repo, also when the branch is not an ancestor of the target branch.",
          },
          {
            id: "ARK-188-AC3",
            text: "If `git fetch` fails and the MR state is not known, then `ark run close <run> merged` shall keep the branch and print the repo and the reason.",
          },
          {
            id: "ARK-188-AC4",
            text: "If the source repo has uncommitted changes and the caller does not give `--allow-dirty`, then `ark worktree create` shall print the changed paths and exit 1.",
          },
          {
            id: "ARK-188-AC5",
            text: "Where the caller gives `--allow-dirty`, `ark worktree create` shall create the worktree and print the changed paths as a warning.",
          },
        ],
      },
    },
    {
      project: "ark",
      id: "ARK-191",
      title: "Ticket status follows its run, and ark status shows stale runs",
      status: "proposed",
      milestone: "M1",
      depends_on: ["ARK-188"],
      body: {
        problem:
          "A ticket's status does not follow its run. On 2026-10-31, the README shows ARK-171 as `ready`, but run 2026-10-31-ARK-171-1 is in phase `building`. Runs of ARK-176 and ARK-182 are also `building`. Somebody must edit the status by hand, and other sessions read the wrong status when they plan work.\n\nOpen runs can also stay open with no activity, and nothing shows them. `ark status` lists open runs but does not show how old they are.",
        change:
          "1. In `ark run start` and `ark run close`, when `ticket_source` is `local`, set the `status:` line of the ticket file. Change no other line.\n2. In `ark status`, show the age of the newest event for each open run. Mark the run `stale` after 24 hours.\n3. In chief.md, tell Master Chief to update the Status cell of the README row at start and close.\n4. Update docs/reference/cli.md.",
        criteria: [
          {
            id: "ARK-191-AC1",
            text: "Where a project has `ticket_source: local`, `ark run start` shall set `status: in_progress` in the ticket file and change no other line.",
          },
          {
            id: "ARK-191-AC2",
            text: "Where a project has `ticket_source: local`, `ark run close <run> merged` shall set `status: done` in the ticket file, and `ark run close` with `aborted` or `abandoned` shall set it to `ready`.",
          },
          {
            id: "ARK-191-AC3",
            text: "If the newest event of an open run is older than 24 hours, then `ark status` shall mark the run `stale` and show the age.",
          },
          {
            id: "ARK-191-AC4",
            text: "When Master Chief starts or closes a run, Master Chief shall update the Status cell of the row of that ticket in the tickets README (live human check).",
          },
        ],
      },
    },
    {
      project: "ark",
      id: "ARK-200",
      title: "ark merge-request status reports CI checks, new human comments and merge conflicts",
      status: "proposed",
      milestone: "M1",
      depends_on: ["ARK-208"],
      body: {
        problem:
          "`ark merge-request status` reads only the MR state: merged, open or closed (`cli/merge-request.ts:270`). Master Chief polls it on every wait (`skills/ark/playbooks/chief.md:131`), but it cannot see a failing CI check, a new review comment or a merge conflict. These events need work after the MR opens, and nothing notices them.",
        change:
          "1. Add the CI state, the human comments since a time, and the conflict state to `ark merge-request status`, for GitHub (`gh pr checks`, `gh api` review comments) and GitLab (pipeline and notes API).\n2. Leave out comments by the Ark user's own agents and by bots. Mark them by the comment author.\n3. Add `--since <time>` and `--json`. Update docs/reference/cli.md.",
        criteria: [
          {
            id: "ARK-200-AC1",
            text: "The output of `ark merge-request status <run>` shall give the CI state of each MR (`passed`, `failed`, `running` or `none`), and with `--json` the name and URL of each failed check.",
          },
          {
            id: "ARK-200-AC2",
            text: "Where the caller gives `--since <time>`, `ark merge-request status <run>` shall list each human comment written after that time, with author, file and line when present, body and URL, and leave out comments by Ark agents and bots.",
          },
          {
            id: "ARK-200-AC3",
            text: "If an MR cannot merge into its target branch, then `ark merge-request status <run>` shall print `conflict` for that MR.",
          },
          {
            id: "ARK-200-AC4",
            text: "If `gh` or `glab` cannot answer, then `ark merge-request status <run>` shall print `unknown` for that value and exit 0.",
          },
        ],
      },
    },
    {
      project: "ark",
      id: "ARK-202",
      title:
        "Master Chief watches open MRs, and the run lead handles CI failures, review comments and conflicts",
      status: "proposed",
      milestone: "M1",
      depends_on: ["ARK-200"],
      body: {
        problem:
          "The run lead stops after it opens the MRs and writes the retro (`skills/ark/playbooks/run-lead.md` \u00a710 and \u00a711). Master Chief then only waits for a merge (`chief.md:131`). The human must fix a failing CI check, a review comment or a merge conflict by hand. Then the change is not merge-ready.",
        change:
          '1. **chief.md \u00a77.** On every wait, for each run in `merge_requests_open`, run `ark merge-request status <run> --since <last check>`. When CI failed, a human commented, or an MR has a conflict, start the run lead again with the same spec (`/skill:ark run-lead <run>`) and give it the items.\n2. **run-lead.md, new section after \u00a710, "Work on the open MRs".**\n   - CI failure: read the failed check log, run an MR round, push.\n   - Comment: judge it. A change request starts an MR round. A question gets a reply only. A note gets nothing. After a fix, reply with the commit. Do not resolve the thread; the human resolves it.\n   - Conflict: rebase on the target branch, run `ark test <run>`, push.\n   - Before an implementer MR round, ask the human for the gate answer through Master Chief. ARK-208 (done) makes the CLI enforce this gate. Validator and reviewer steps need no gate.\n3. Update docs/explanation/architecture.md (run lifecycle) and docs/prd.md "How it works".',
        criteria: [
          {
            id: "ARK-202-AC1",
            text: "When CI fails on an open MR of a run, Master Chief shall start the run lead again for that run, and the run lead shall run an MR round and push the fix to the same branch until CI passes (live human check).",
          },
          {
            id: "ARK-202-AC2",
            text: "When a human writes a review comment on an open MR, the run lead shall start an MR round for a change request, reply with no commit for a question, and do nothing for a note, and each reply after a fix shall name the commit (live human check).",
          },
          {
            id: "ARK-202-AC3",
            text: "When the target branch moves and an MR has a conflict, the run lead shall rebase the branch, run `ark test <run>` and push, so that the MR has no conflict (live human check).",
          },
        ],
      },
    },
    {
      project: "ark",
      id: "ARK-203",
      title: "Provider fallback chain that keeps cross-vendor review, then waits for the reset",
      status: "proposed",
      milestone: "M1",
      depends_on: ["ARK-186", "ARK-198"],
      body: {
        problem:
          "Provider usage limits stopped three runs or sessions in two days:\n\n- In run 2026-10-31-ARK-171-1, OMP moved every step to `claude-sonnet-5-5`, and cross-vendor review did not hold. Nobody saw it until the retro.\n- In run 2026-10-31-ARK-170-1, the validator stopped on `usage_limit_reached` and idled for about 30 minutes.\n- On 2026-10-31, the brainstorm scouts failed on the same limit.\n\nThe run lead now finds the error and asks the human (`run-lead.md:249`). `ark.yml` has one model per role (`cli/config.ts:106-114`) and no fallback.",
        change:
          "1. Add `roles.<role>.fallbacks` to `ark.yml`. The bootstrap playbook proposes fallbacks from the providers it finds.\n2. In the OMP usage parser, read `model_change` events with role `temporary`. `ark status <run>` marks a validator or reviewer step that moved to the implementer's vendor.\n3. run-lead.md \u00a77: on a usage limit or a `same_vendor_fallback` mark, stop the worker. Start it again with `--retry-of` on the first fallback that keeps cross-vendor review. When none is left, wait for the reset time and start it again on the planned model. Tell Master Chief each change.\n4. Update docs/reference/cli.md and bootstrap.md.",
        criteria: [
          {
            id: "ARK-203-AC1",
            text: "If an entry in `roles.<role>.fallbacks` has no harness or no model, then `ark status` shall refuse the config.",
          },
          {
            id: "ARK-203-AC2",
            text: "When an OMP session of a validator or reviewer step has a `model_change` with role `temporary` to a model of the same vendor as an implementer step in the same repo, `ark status <run>` shall mark the step `same_vendor_fallback` and name the model.",
          },
          {
            id: "ARK-203-AC3",
            text: "When a worker stops on a usage limit and a fallback keeps cross-vendor review, the run lead shall start the step again with `worker-start --retry-of` on the first such fallback, and tell Master Chief the old and the new model (live human check).",
          },
          {
            id: "ARK-203-AC4",
            text: "While only same-vendor fallbacks remain, the run lead shall not start the step on them, and shall start it on its planned model after the reset time of the provider (live human check).",
          },
        ],
      },
    },
    {
      project: "ark",
      id: "ARK-224",
      title: "Ask the human to review again after new commits on a reviewed MR",
      status: "proposed",
      milestone: "M1",
      depends_on: ["ARK-202"],
      body: {
        problem:
          "After ARK-202, the run lead pushes fixes to an open MR. An approval that the human gave earlier then covers code that the human did not see. The article says that an approval is good for one commit, and that new commits from an agent need a new approval.",
        change:
          "1. Add the comment and the review request to the MR round flow (`cli/merge-request.ts`), called by the run lead after it pushes.\n2. GitHub: `gh pr edit --add-reviewer`. GitLab: `glab api` to reset approvals where allowed.\n3. Update chief.md, run-lead.md and docs/reference/cli.md.",
        criteria: [
          {
            id: "ARK-224-AC1",
            text: "When the run lead pushes commits to an MR after a human approved or reviewed it, `ark merge-request` shall add a comment on the MR that lists each new commit, the round it belongs to, and the `ark test` result at the new head.",
          },
          {
            id: "ARK-224-AC2",
            text: "When that comment is added on GitHub, `ark merge-request` shall request a review from each human who reviewed the MR before; on GitLab, it shall reset the approvals of the MR if the project allows it.",
          },
          {
            id: "ARK-224-AC3",
            text: "If the host cannot request the review, then `ark merge-request` shall keep the comment and print a warning that names the host error.",
          },
        ],
      },
    },
    {
      project: "ark",
      id: "ARK-236",
      title: "Playbook fixes from the 2026-11-02 close check",
      status: "done",
      milestone: "M1",
      depends_on: [],
      body: {
        problem: "",
        change:
          "Edit worker.md and run-lead.md as the criteria say. test/playbooks.test.ts checks each rule.",
        criteria: [
          {
            id: "ARK-236-AC1",
            text: "worker.md tells an implementer to run every check script its repo's package.json lists (for this repo `format`, then `format:check`, `typecheck` and `lint`) before each commit and before `worker_done`, also in rework rounds and for Markdown-only changes",
          },
          {
            id: "ARK-236-AC2",
            text: "worker.md tells an implementer to commit its own work before `worker_done`, and run-lead.md says a findings file never forbids an implementer commit",
          },
          {
            id: "ARK-236-AC3",
            text: "run-lead.md section 7 says that for a repo named `.` the worktree path is `<run folder>/workspace`, with no trailing `/.`",
          },
          {
            id: "ARK-236-AC4",
            text: "run-lead.md section 1 tells a run lead to treat a `run_...` ID found in the run folder as a candidate only, and to bind it with `run-use` only after `run-show` shows the objective `Ark run <run>`",
          },
          {
            id: "ARK-236-AC5",
            text: "run-lead.md tells the run lead to copy every literal string an AC names (a field, flag or message) into the implementer's worker spec word for word",
          },
        ],
      },
    },
    {
      project: "ark",
      id: "ARK-237",
      title: "Clone-based sync and MR tests do not time out under load",
      status: "done",
      milestone: "M1",
      depends_on: [],
      body: {
        problem: "",
        change: "Give the clone-based tests an explicit timeout of 30 seconds or more.",
        criteria: [
          {
            id: "ARK-237-AC1",
            text: "The ARK-165 sync tests and the ARK-155 merge-request tests that clone or push git repos set a per-test timeout of at least 30 seconds",
          },
          {
            id: "ARK-237-AC2",
            text: "Those tests pass when the suite runs with 4 other full `bun test` processes running at the same time",
          },
        ],
      },
    },
    {
      project: "ark",
      id: "ARK-238",
      title: "No Designer and no mockup for a run that needs none",
      status: "done",
      milestone: "M1",
      depends_on: [],
      body: {
        problem: "",
        change: "Skip the mockup and the Designer when no surface needs them.",
        criteria: [
          {
            id: "ARK-238-AC1",
            text: "`ark strategy record` accepts a strategy card with no `Mockup:` line when the evaluation's Surfaces is `none`",
          },
          {
            id: "ARK-238-AC2",
            text: "`ark strategy record` accepts a one-card `strategies.md` with no `Mockup:` line and starts no Designer step when Surfaces is only `document`",
          },
          {
            id: "ARK-238-AC3",
            text: "run-lead.md section 2 says when to leave out the `Mockup:` line and when to skip the Designer",
          },
        ],
      },
    },
    {
      project: "ark",
      id: "ARK-239",
      title: "Hub drops the plan gate item after a change answer",
      status: "done",
      milestone: "M4",
      depends_on: ["ARK-227"],
      body: {
        problem: "",
        change: "The hub shows an open plan gate only when a valid check follows the last answer.",
        criteria: [
          {
            id: "ARK-239-AC1",
            text: "For an event log with a valid `plan.checked` at T, `gate.answered plan change` at T+60 s and no later `plan.checked`, the hub Needs-me list has no plan gate item for the run",
          },
        ],
      },
    },
    {
      project: "ark",
      id: "ARK-240",
      title: "ark retro counts findings sent back through round files",
      status: "done",
      milestone: "M3",
      depends_on: [],
      body: {
        problem: "",
        change: "Count accepted findings from the round files.",
        criteria: [
          {
            id: "ARK-240-AC1",
            text: "`ark retro` counts the accepted findings in each `findings/round-<n>.md` of the run into `rework.findings_sent_back` in `metrics.json`",
          },
        ],
      },
    },
    {
      project: "ark",
      id: "ARK-241",
      title: "ark worktree sync syncs every repo before it reports conflicts",
      status: "done",
      milestone: "M2",
      depends_on: [],
      body: {
        problem: "",
        change: "Sync every repo, then report all conflicts.",
        criteria: [
          {
            id: "ARK-241-AC1",
            text: "With repos A, B and C where only B conflicts, `ark worktree sync` syncs A and C, exits 1 and names B",
          },
          {
            id: "ARK-241-AC2",
            text: "`ark worktree sync` with one conflicting repo records a conflict for that repo only",
          },
        ],
      },
    },
    {
      project: "ark",
      id: "ARK-242",
      title: "ark worktree create shows the setup cause and checks cleanup",
      status: "done",
      milestone: "M1",
      depends_on: ["ARK-198"],
      body: {
        problem: "",
        change: "Show stdout when stderr is empty, and report a failed cleanup.",
        criteria: [
          {
            id: "ARK-242-AC1",
            text: "When the `setup` command fails with empty stderr, `ark worktree create` prints the end of its stdout",
          },
          {
            id: "ARK-242-AC2",
            text: "When removing the failed worktree also fails, the output names what was left behind, and the next `ark worktree create` for the run still works",
          },
        ],
      },
    },
    {
      project: "ark",
      id: "ARK-243",
      title: "UI browser tests run on Playwright instead of Bun.WebView",
      status: "done",
      milestone: "M4",
      depends_on: ["ARK-230", "ARK-235"],
      body: {
        problem: "",
        change:
          "Move the browser parts of the five test files to Playwright Test. Non-browser assertions stay in `bun test`. Add `@playwright/test` as a dev dependency and a `playwright.config.ts`. Run the Playwright suite as its own suite in `ark test` and in CI. Prefer an existing parser for the JUnit report; add a `playwright` parser only if none reads it.",
        criteria: [
          {
            id: "ARK-243-AC1",
            text: "No file under `test/` uses `Bun.WebView`; every browser test from `test/ui.test.ts`, `test/hub-views.test.ts`, `test/map-timeline.test.ts`, `test/run-detail.test.ts` and `test/usage-limit.test.ts` runs in Playwright Test with the Chromium project",
          },
          {
            id: "ARK-243-AC2",
            text: "Each migrated browser test keeps the AC ID it had in its title, and `ark test` reports the same status for those AC IDs as before the migration",
          },
          {
            id: "ARK-243-AC3",
            text: "`ark.yml` documentation and the project setup show a second suite that runs the Playwright tests with a JUnit report that an existing `ark test` parser reads, or a new `playwright` parser that `ark test` accepts",
          },
          {
            id: "ARK-243-AC4",
            text: "CI installs the Playwright Chromium browser and runs the Playwright suite on Linux, and both CI jobs pass",
          },
          {
            id: "ARK-243-AC5",
            text: "A failing Playwright test keeps a trace and a screenshot under the run's results folder or the Playwright output folder",
          },
          {
            id: "ARK-243-AC6",
            text: "After the Playwright suite finishes, the system temporary directory has no new Chrome profile directories from the run",
          },
        ],
      },
    },
    {
      project: "ark",
      id: "ARK-244",
      title: "Master Chief hands over to a new session without a hand-written state note",
      status: "done",
      milestone: "M1",
      depends_on: [],
      body: {
        problem: "",
        change:
          "Add `ark chief state` and `ark chief handover`. Move the two loops into the repo. Update chief.md so takeover reads live state and handover triggers on the context percentage in the status line.",
        criteria: [
          {
            id: "ARK-244-AC1",
            text: "`ark chief state --project <project>` prints a Markdown snapshot built only from live sources: each open run with phase and current step, each live run lead's dispatch ID and terminal handle from `orca orchestration worker-list`, queued Orca Tasks with status `ready` or `pending`, the workspace main head, the `ark.yml` `gates` and `concurrency`, closed runs whose `retro.md` has an empty Close chec",
          },
          {
            id: "ARK-244-AC2",
            text: "`ark chief handover --project <project>` starts a new Master Chief agent in a new Orca terminal with a prompt that names the old Master Chief terminal and tells it to wait for that terminal to exit, then bind the existing Master Chief Run with `run-use`, and prints the new terminal handle",
          },
          {
            id: "ARK-244-AC3",
            text: "The LASO auto-merger and the temp cleaner are files in the Ark repo, each with an integration test against a fake `gh` or a scratch temp directory, and chief.md names them",
          },
          {
            id: "ARK-244-AC4",
            text: "chief.md tells Master Chief to run `ark chief state` when it takes over, to keep only standing rules in `handoff.md`, and to run `ark chief handover` and then close its own terminal when its terminal's status line shows context use of 70% or more",
          },
        ],
      },
    },
    {
      project: "ark",
      id: "ARK-246",
      title:
        "The Timeline and the Map load: a hub push does not cancel their request, and the server reads usage once",
      status: "done",
      milestone: "M4",
      depends_on: [],
      body: {
        problem:
          'Steps: Open the hub. Press `3`. Wait.\n\nExpected: The Timeline lanes appear in a second or two.\n\nActual: The page shows "Loading the Timeline..." for more than 3 minutes. This also happens on a sandbox hub with a copy of the run folders and with the 1 hour window. The Map shows an empty SVG until the first answer and has no loading text.\n\nCauses in the code (the slow wall time that the explorers measured was under a load average of 37 to 152 and is not the bug):\n1. `ui/timeline.tsx:15-28` starts the fetch in an effect that depends on `[hub, hours]`. `hub` is a new object on every push, and the state has a `now` field that changes every second. The cleanup sets `stale`, and the code drops every answer that is not for the newest request (`ui/timeline.tsx:20`). No answer is ever used. `ui/map.tsx:79-92` has the same pattern, with no loading state (`nodes = graph?.nodes ?? []`, `ui/map.tsx:109`).\n2. `buildTimeline` runs in the route handler (`cli/ui.ts:106-110`) and blocks the hub. For each run it calls `costOf`, which calls `readUsage(directory)` (`cli/hub/timeline.ts:119-121` and `:228`). Each `readUsage` scans all session files. For 54 runs the calls use 10.4 s of CPU. All other work in `buildTimeline` uses 11 ms. The batch reader `readUsageIn(directories)` exists (`cli/usage/index.ts:105`) and `cli/hub/agents.ts:69` uses it.\n\nEvidence: QE sweep 2026-11-02, map-timeline F1 and F2.',
        change:
          'Timeline: fetch on mount and when the window changes. After a push, fetch again only when no request is in flight and the last answer is older than 15 seconds. Keep the answer of a request that finished while a push arrived, when the window is the same.\n\nMap: use the same fetch rule. Show "Loading the Map..." until the first answer.\n\nServer: in `buildTimeline`, read the usage of all run folders with one call of `readUsageIn`, and give each lane its messages.',
        criteria: [
          {
            id: "ARK-246-AC1",
            text: "The Timeline shows its lanes while the hub pushes state every second and `/api/timeline` takes 3 seconds to answer",
          },
          {
            id: "ARK-246-AC2",
            text: "`buildTimeline` scans the session roots once for all runs, not once for each run",
          },
          {
            id: "ARK-246-AC3",
            text: 'The Map shows "Loading the Map..." until its first answer, and shows its nodes when `/api/map` takes 3 seconds to answer while the hub pushes every second',
          },
          {
            id: "ARK-246-AC4",
            text: "A Playwright spec in `test/pw/map-timeline.pw.ts` whose title starts with `ARK-246-AC4` covers AC1 and AC3 with the answer of each API route delayed 3 seconds in a real browser. It fails before the fix and passes after it. `bunx playwright test test/pw/map-timeline.pw.ts -g ARK-246-AC4` exits 0",
          },
        ],
      },
    },
    {
      project: "ark",
      id: "ARK-276",
      title:
        "Each run lead and its workers start in the run's own worktree, not in the main workspace",
      status: "done",
      milestone: "M1",
      depends_on: [],
      body: {
        problem:
          "On 2026-11-02, `orca orchestration worker-list --include-remote --json` listed 83 worker dispatches. 78 of them are recorded against the main workspace `/Users/cobekarhoff/Dev/abbott/ark`. Only 5 are recorded against run worktrees `~/.ark/projects/ark/runs/<run>/workspace`. The main worktree in Orca is full of agents. The human cannot see which agent belongs to which run.\n\nThree playbook lines cause this:\n\n- `chief.md` section 6 step 3 starts the run lead with `--worktree current`.\n- `run-lead.md` section 2 starts the evaluator with `--worktree path:<workspace from ark.yml>`. That is the main workspace.\n- `run-lead.md` section 2 starts the designer in the same way.\n\nOnly the step workers of `run-lead.md` section 7 start with `--worktree path:<run folder>/workspace/<repo>`.\n\nThe run worktree is made too late for the first three. `ark worktree create` runs in `run-lead.md` section 6, after the plan gate, so no run worktree exists when the lead, the evaluator and the designer start. `cli/transitions.ts` also refuses the `worktree.created` event in the phases `awaiting_criteria` and `awaiting_strategy`. For a workspace that is not a repo, `<run folder>/workspace` is a plain folder, and Orca does not know it (`selector_not_found`, ARK-164). So a run worktree for the first workers must be a repo worktree.\n\nThe human approved this change.",
        change:
          "1. Add `ark worktree anchor <run> [--project <name>]` in `cli/worktree.ts` and `cli/ark.ts`. The anchor is the worktree of the first entry of `discoverRepos(workspace)`. Because `.` sorts first, the anchor is `<run folder>/workspace` when the workspace root is a repo, also when it is a meta-repo with nested repos. When the root is not a repo, the anchor is `<run folder>/workspace/<first repo>`.\n   - Reuse the code of `worktreeCreate` for one repo (branch, `setup`, `worktree.created` event). Do not copy it.\n   - If the anchor exists and is in `state.worktrees`, print its selector and change nothing.\n   - Print one line: `path:<absolute path>`. It is the exact value for `--worktree`. `ark worktree create` later gives `exists` for the anchor repo and makes the other repos as before.\n2. In `cli/transitions.ts`, allow `worktree.created` in every phase except `closed`. `ark run close` already removes every worktree in `state.worktrees`, so the anchor is removed with the others.\n3. In `chief.md` section 6 step 3, run `ark worktree anchor <run>` after `ark run start`, then use the printed `path:<...>` as `--worktree` for the run lead. Remove `--worktree current` from the text and from its explanation. Master Chief itself stays in the main workspace. In section 8, before `ark run close`, release the run lead when it is not yet released (section 7 already releases it after its `worker_done`).\n4. In `run-lead.md` section 2, run `ark worktree anchor <run>` and use its printed `path:<...>` as `--worktree` for the evaluator and for the designer. Remove `path:<workspace from ark.yml>`. In `run-lead.md` section 7 step 3 and where it handles a worker, release each worker (also the evaluator and the designer) after its `worker_done`, after a failed exit and after an abnormal exit.\n5. In `worker.md`, change the sentence that says the evaluator and the designer work in the workspace. They work in the run worktree they were started in. Their other rules stay.\n6. Change `test/playbooks.test.ts`: the test `ARK-164-AC1` expects `--worktree current` today. Change it to the new text, and add the tests for the ACs below. Add the CLI tests in `test/worktree.test.ts`, with its existing helpers.\n7. Regenerate `docs/reference/cli.md` with `bun scripts/cli-reference.ts`.\n\nDo not change the `--agent` or `--model` of any `worker-start`. Do not change `--worktree path:<run folder>/workspace/<repo>` of the step workers. It works today and must not regress. Do not start a worker in a test: th",
        criteria: [
          {
            id: "ARK-276-AC1",
            text: "No `worker-start` command in `skills/ark/playbooks/chief.md` or `skills/ark/playbooks/run-lead.md` has `--worktree current` or `--worktree path:<workspace from ark.yml>`. Each such command takes its worktree from `ark worktree anchor <run>` or from `<run folder>/workspace/<repo>`. A test in `test/playbooks.test.ts` whose title starts with `ARK-276-AC1` fails when one of these strings comes back. T",
          },
          {
            id: "ARK-276-AC2",
            text: "`ark worktree anchor <run> [--project <name>]` prints one line, `path:<absolute path>`, and exits 0. On a fixture project whose workspace root is a git repo, the path is `<run folder>/workspace`, it is a git worktree on the branch `ark/<ticket id>-<slug>`, and `state.worktrees` has one entry for repo `.`. A second call prints the same line and records no second `worktree.created` event. A test in ",
          },
          {
            id: "ARK-276-AC3",
            text: "The anchor is the first entry of `discoverRepos(workspace)`. On a fixture whose workspace root is not a repo and has the repos `a` and `b`, the anchor path is `<run folder>/workspace/a`. On a fixture whose workspace root is a repo and has the nested repo `repos/x`, the anchor path is `<run folder>/workspace`. In both fixtures, a later `ark worktree create <run> <repo>` for each repo exits 0, print",
          },
          {
            id: "ARK-276-AC4",
            text: "`ark worktree anchor <run>` works in the phases `awaiting_criteria`, `awaiting_strategy`, `planning` and `building`. In the phase `closed` it exits 1 with the phase error that `ark worktree create` gives. The `worktree.created` rule in `cli/transitions.ts` allows every phase except `closed` and the phases that do not exist for an open run. A test whose title starts with `ARK-276-AC4` in `test/work",
          },
          {
            id: "ARK-276-AC5",
            text: "`ark run close <run> <outcome>` removes the anchor worktree and its branch, as it removes every other run worktree. A test whose title starts with `ARK-276-AC5` in `test/worktree.test.ts` runs `ark worktree anchor`, then `ark run close`, and checks that the path and the branch are gone. `bun test test/worktree.test.ts -t ARK-276-AC5` exits 0",
          },
          {
            id: "ARK-276-AC6",
            text: "`chief.md` section 6 step 3 runs `ark worktree anchor <run>` after `ark run start` and before `worker-start`, and gives the printed selector to `--worktree` for the run lead. `run-lead.md` runs `ark worktree anchor <run>` and gives the printed selector to `--worktree` for the evaluator and for the designer. Master Chief itself stays in the main workspace. The models stay `omp` and `anthropic/claud",
          },
          {
            id: "ARK-276-AC7",
            text: "`run-lead.md` says to release each worker with `orca orchestration worker-release --dispatch <dispatch id> --json` after its `worker_done`, for the evaluator, the designer and every step worker. It says to release the worker also after a failed exit and after an abnormal exit (the worker is gone and sent no `worker_done`). `chief.md` section 8 says to release the run lead first, when it is not yet",
          },
          {
            id: "ARK-276-AC8",
            text: "`docs/reference/cli.md` is regenerated with `bun scripts/cli-reference.ts` and lists `worktree anchor`. `bun test`, `bun run typecheck`, `bun run lint` and `bun run format:check` exit 0",
          },
          {
            id: "ARK-276-AC9",
            text: "End-to-end check, recorded in the validator report of the run: start one run on a fixture project with a fake `ark.yml` workspace, follow the changed playbooks as far as the run lead, the evaluator and one step worker, and run `orca orchestration worker-list --include-remote --json`. The `workspace` of each of the dispatches of this run is `<orca repo id>::<run folder>/workspace` and not the main ",
          },
        ],
      },
    },
    {
      project: "ark",
      id: "ARK-277",
      title:
        "A new read-only hub in hub/ shows live runs, their plans and models, and the backlog, and replaces the old hub",
      status: "done",
      milestone: "M4",
      depends_on: [],
      body: {
        problem:
          'The hub is slow and has too many parts. On 2026-11-02, a 404 that does no work took up to 14.8 s to answer. `/api/projects` took 59.3 s, `/api/agents` took 18.3 s and `/api/timeline` took 6 to 8 s. The server has one event loop. Request handlers call `readUsageIn` (`cli/usage/index.ts:105`). It reads the 480 MB of session files with sync calls, and it parses each whole file again on each call. Each view also polls every 5 s (`ui/hub-views.tsx:41`), so several tabs add their scans one after the other.\n\nThe hub has 9 views and about 7,050 lines (`ui/app.tsx` has 1,496). 31 open M4 tickets fix parts of it. The human said on 2026-11-02: "this ark hub as of today has too many things going on around it. Maybe we can create a new version from fresh that just focuses on the live running agents /tickets and the nodes and the plans and the dag of what is planned for that ticket etc and the models. And the backlog but everything else i think is just added complexity and fluff."',
        change:
          "1. Write ADR 0009 \"Hub is a read-only live view\". It supersedes ADR 0008. It amends ADR 0007, R13 and the M4 row in `docs/prd.md`. The hub shows Home, Run, Backlog and Map. It does not steer agents. It has no Timeline, Metrics, Search, Projects or notifications. Master Chief stays the only path to queue or steer work.\n2. Build a new hub in `hub/` (server and page). Use Bun and plain React. Do not use the React Compiler. Serve a production build.\n3. Use these rules from the first commit:\n   - One background reader builds one snapshot. It reads Ark files, Orca, Plannotator, GitHub and usage. Request handlers read only that snapshot.\n   - The page gets the snapshot from one event stream. No view polls.\n   - The usage index keys each session file by path, size and mtime, and parses a whole file again when one of them changes. The parsers read whole files (`cli/usage/omp.ts:31-39`, `cli/usage/claude.ts:88-96`). Claude removes duplicate response IDs across a file, so do not read only the new tail. Closed runs read their cost from `metrics.json` (`cli/retro.ts:443-519`).\n   - Keep the index in memory. Keep it in `bun:sqlite` only if the cold-start budget (AC6) fails without it. The SQLite file is a cache. The hub can delete it and build it again.\n   - Each source keeps its last good value and its read time.\n4. Views:\n   - **Home**: Needs me first (gates as links to Plannotator). Then each open run with its live agents, models, phase, MR and CI state, and cost.\n   - **Run**: the plan DAG, with the role, harness, model, status and cost of each step.\n   - **Backlog**: read-only, with 'Copy prompt for Master Chief'.\n   - **Map**: the ticket graph from `depends_on`, colored by run phase. It has no step detail.\n5. Cut over in this run. Point `ark ui`, `ark ui install` and `ark ui uninstall` at `hub/`. Delete `ui/`, `cli/hub/`, `cli/ui.ts` code that only the old hub uses, the React Compiler setup and the old hub tests. Use the fixture helpers in `test/helpers.ts` and `test/pw/helpers.ts` (`tempArkHome`, `writeProject`, `writeTicket`, `writeFakeOrca`, `startHub`), and move them if the old files go.\n   Other CLI code imports from `cli/hub/`: `cli/chief.ts:6-8` (`exec`, `execJson`, `retroUnanswered`, `findLiveChief`, `readTerminals`), `cli/events.ts:5` and `cli/run.ts:1` (`now` from `cli/hub/clock.ts`). Move these helpers to `cli/` (for example `cli/exec.ts`, `cli/clock.ts`, `cli/orca.ts`) before you delete `cli/hub/`. `ark chief state` and `ark chief handover` must work a",
        criteria: [
          {
            id: "ARK-277-AC1",
            text: "`docs/adr/0009-hub-is-a-read-only-live-view.md` exists with `status: accepted`. `docs/adr/0008-hub-steers-through-master-chief.md` has `status: superseded` and names ADR 0009. ADR 0007, R13 and the M4 row in `docs/prd.md` name the views of ADR 0009: Home, Run, Backlog and Map. The validator report quotes the 4 changed lines",
          },
          {
            id: "ARK-277-AC2",
            text: "The server in `hub/` has no route that accepts POST, PUT, PATCH or DELETE. A test in `test/hub.test.ts` whose title starts with `ARK-277-AC2` sends each method to every route and gets 404 or 405. `bun test test/hub.test.ts -t ARK-277-AC2` exits 0",
          },
          {
            id: "ARK-277-AC3",
            text: "Request handlers read only memory. On a fixture `ARK_HOME` with 25 runs and 300 session files, and a fake Orca that sleeps 3 s on every call, 50 requests each to `/`, to `/nope` and to every API route answer with a p95 below 200 ms, while one browser page is open on each view. A Playwright spec in `test/pw/hub.pw.ts` whose title starts with `ARK-277-AC3` covers this. `bunx playwright test test/pw/",
          },
          {
            id: "ARK-277-AC4",
            text: "The page gets data from one event stream. Over 30 s on each of Home, Run, Backlog and Map, the page sends no request other than its first load and the event stream. An event appended to `events.ndjson` of an open run shows on Home within 5 s. A Playwright spec in `test/pw/hub.pw.ts` whose title starts with `ARK-277-AC4` counts the requests by URL. `bunx playwright test test/pw/hub.pw.ts -g ARK-277",
          },
          {
            id: "ARK-277-AC5",
            text: "The usage index re-parses only session files whose size or mtime changed. After the first build, a refresh with no changed file parses 0 files. After one file grows, the next refresh parses that 1 file. A closed run with `metrics.json` gets its cost from `metrics.json`, and the index parses no session file for it. A test in `test/hub.test.ts` whose title starts with `ARK-277-AC5` reads the parse c",
          },
          {
            id: "ARK-277-AC6",
            text: "Cold start: on a fixture with 300 session files of 100 MB in total, the hub serves a full snapshot within 5 s of its start, and `/` answers in less than 200 ms during that time. If an index kept in memory cannot meet this, the hub keeps the index in `bun:sqlite` at `$ARK_HOME/hub/usage.sqlite`. When the hub deletes or loses that file, it rebuilds it, and the costs stay the same. A test in `test/hu",
          },
          {
            id: "ARK-277-AC7",
            text: "Home shows Needs me first. Each open gate is a link to its Plannotator review, or shows the gate question when no review exists. Below it, Home shows each open run: ticket ID and title, phase, each live agent with its role, harness and model, each MR with `open`, `merged` or `closed` and its CI state `passing`, `failing`, `pending` or `unknown`, and the cost of the run in USD or `unknown`. A Playw",
          },
          {
            id: "ARK-277-AC8",
            text: "The run page draws the plan DAG of the run: one node for each step of `plan.md` and one edge for each dependency. Each node shows the step name, role, harness, model, status and cost in USD or `unknown`. A Playwright spec in `test/pw/hub.pw.ts` whose title starts with `ARK-277-AC8` covers a fixture plan with 4 steps and 3 edges. `bunx playwright test test/pw/hub.pw.ts -g ARK-277-AC8` exits 0",
          },
          {
            id: "ARK-277-AC9",
            text: "Backlog lists each ticket of the project with ID, title, status, milestone and `depends_on`, and filters by status and by text. It has no button that changes a ticket. The button 'Copy prompt for Master Chief' copies a text that names the selected ticket IDs in dependency order. A Playwright spec in `test/pw/hub.pw.ts` whose title starts with `ARK-277-AC9` covers this. `bunx playwright test test/p",
          },
          {
            id: "ARK-277-AC10",
            text: "The Map draws one node for each ticket and one edge for each `depends_on`. The color of a node is the phase of the newest run of that ticket, or `no run`. The Map has no step nodes. A Playwright spec in `test/pw/hub.pw.ts` whose title starts with `ARK-277-AC10` covers a fixture with 5 tickets, 4 edges and 3 runs in different phases. `bunx playwright test test/pw/hub.pw.ts -g ARK-277-AC10` exits 0",
          },
          {
            id: "ARK-277-AC11",
            text: "When Orca or Plannotator does not answer, the page keeps the last good value and shows 'as of N s ago'. Before the first good read, it shows `unknown`, not an empty list. A Playwright spec in `test/pw/hub.pw.ts` whose title starts with `ARK-277-AC11` uses a fake Orca that answers 2 times and then fails. `bunx playwright test test/pw/hub.pw.ts -g ARK-277-AC11` exits 0",
          },
          {
            id: "ARK-277-AC12",
            text: "Cutover: `ark ui`, `ark ui install` and `ark ui uninstall` serve and manage the hub in `hub/`. The folders `ui/` and `cli/hub/`, `ui/react-compiler.ts`, the React Compiler entry in `bunfig.toml` and `package.json`, and the tests of the old hub do not exist. No file imports them. `bun test`, `bun run typecheck`, `bun run lint` and `bun run format:check` exit 0",
          },
          {
            id: "ARK-277-AC13",
            text: "After the human check on the real `ARK_HOME` (the human opens `ark ui`, then Home, one run page, Backlog and Map), the validator writes `<run folder>/validator-ac13.md` with the 4 view times and the answer of the human. A test in `test/hub.test.ts` whose title starts with `ARK-277-AC13` reads that file and checks that it holds 4 times below 1 s and the line `human: ok`. `bun test test/hub.test.ts ",
          },
        ],
      },
    },
    {
      project: "ark",
      id: "ARK-278",
      title:
        "Run close releases the settled Orca workers of the run, and --sweep releases them for runs that are already closed",
      status: "done",
      milestone: "M1",
      depends_on: ["ARK-276"],
      body: {
        problem:
          'Orca keeps every worker that Ark started. On 2026-11-02, `orca orchestration worker-list --json` showed 100 rows: 81 `succeeded`, 10 `failed`, 4 `stopped` and 5 `ready`. Only 5 terminals were live. `orca orchestration run-list` showed 70 Runs. The human said on 2026-11-02: "All the historic runs and agents etc are bloating the whole app as well."\n\n`ark run close` (`cli/run.ts:148-153`) records `run.closed` and cleans the worktrees. It does not release the Orca workers of the run. ARK-276 AC7 tells the run lead to release each worker after its `worker_done`. A worker that ends while the run lead is gone, or a run from before ARK-276, stays settled and is not released.\n\nOrca has no verb that removes a Run. `orca orchestration reset --tasks` removes every Task, also the queue of Master Chief, so Ark must not use it.',
        change:
          "1. In `cli/run.ts`, after the worktree cleanup in `runClose`, release the settled dispatches of the Orca Run `Ark run <run>`:\n   - Find the Run with `orca orchestration run-list --json`. Follow `nextCursor`.\n   - List its dispatches with `orca orchestration worker-list --run <id> --json`.\n   - Run `worker-release --dispatch <id> --json` for each settled dispatch that is not released. Do not release an active dispatch.\n   - Use `execJson` with a timeout. An Orca failure never fails the close.\n2. Add `--sweep` to `ark run close`. It does step 1 for each closed run of the project. It records no event.\n3. Keep the worktree cleanup as it is. Add one test that a clean close leaves no `workspace/` folder. No closed run had a `workspace/` folder on 2026-11-02, so this is a guard, not a fix.\n4. In `chief.md` section 8, name the release. Tell Master Chief to run `ark run close --sweep` once after this ticket merges.\n5. Regenerate `docs/reference/cli.md`.\n\nDo not add a new `ark` command (R10). Do not call `orca orchestration reset`. Do not try to remove Orca Runs. The human accepted that Orca keeps its Runs, and an Orca feature request outside Ark covers it.\n\nRisks:\n\n- ARK-277 moves `execJson` from `cli/hub/exec.ts` to `cli/`. The run that merges second changes one import line.\n- It is not known if a released worker leaves `worker-list`. AC7 proves it on the real Orca.\n- The run lead dispatch lives in the Orca Run of Master Chief, not in `Ark run <run>`. Master Chief releases it (`chief.md` section 7, step 5). This ticket does not change that.",
        criteria: [
          {
            id: "ARK-278-AC1",
            text: "`ark run close <run> <outcome>` finds the Orca Run whose objective is exactly `Ark run <run>`. It runs `orca orchestration worker-release --dispatch <id> --json` for each dispatch of that Run that `worker-list --run <id> --json` shows as settled and not yet released. It prints one line for each release. A test in `test/run.test.ts` whose title starts with `ARK-278-AC1` uses a fake Orca with 3 sett",
          },
          {
            id: "ARK-278-AC2",
            text: "`ark run close` does not release a dispatch that is still active. It prints `<dispatch id> still active, not released` for it. A test in `test/run.test.ts` whose title starts with `ARK-278-AC2` covers 1 active and 1 settled dispatch. `bun test test/run.test.ts -t ARK-278-AC2` exits 0",
          },
          {
            id: "ARK-278-AC3",
            text: "When Orca is missing, does not answer or exits non-zero, `ark run close` still records `run.closed`, still cleans the worktrees, prints `orca: workers not released: <reason>` and exits 0. When no Orca Run has the objective `Ark run <run>`, it prints nothing about Orca and exits 0. A test in `test/run.test.ts` whose title starts with `ARK-278-AC3` covers the missing Orca, the fake Orca that hangs p",
          },
          {
            id: "ARK-278-AC4",
            text: "`ark run close --sweep [--project <name>]` does the release of AC1 for every closed run of the project and records no event. It is idempotent: a second call makes no release call. It refuses a run argument together with `--sweep`. A test in `test/run.test.ts` whose title starts with `ARK-278-AC4` covers 2 closed runs, 1 open run and a second call. `bun test test/run.test.ts -t ARK-278-AC4` exits 0",
          },
          {
            id: "ARK-278-AC5",
            text: "After `ark run close` on a run whose worktrees are all clean and merged, the run folder has no `workspace/` folder. It still has `events.ndjson`, `ticket.md`, `plan.md`, `retro.md`, `metrics.json` and `results/` when they existed before. A test in `test/worktree.test.ts` whose title starts with `ARK-278-AC5` covers this. `bun test test/worktree.test.ts -t ARK-278-AC5` exits 0",
          },
          {
            id: "ARK-278-AC6",
            text: "`docs/reference/cli.md` is regenerated with `bun scripts/cli-reference.ts` and lists `--sweep`. `chief.md` section 8 names the release that `ark run close` does, and tells Master Chief to run `ark run close --sweep` once after the merge of this ticket. `bun test`, `bun run typecheck`, `bun run lint` and `bun run format:check` exit 0",
          },
          {
            id: "ARK-278-AC7",
            text: "Live check, recorded in the validator report: on the real Orca, run `orca orchestration worker-list --json --limit 100` and count the rows, run `ark run close --sweep`, then count the rows again. The report quotes both counts and the `terminal state` of 3 released rows. If a released worker stays in `worker-list`, the report says so, and the hub of ARK-277 hides rows in the state `released`",
          },
        ],
      },
    },
    {
      project: "ark",
      id: "ARK-279",
      title:
        "Every run with a UI surface uses the UI/UX skills in its strategy cards, its plan, its build and its MR review",
      status: "done",
      milestone: "M1",
      depends_on: ["ARK-276"],
      body: {
        problem:
          "On 2026-11-02, the human asked that every Ark run with a UI use the UI/UX skills. The skills are `impeccable`, `emil-design-eng`, `web-design-guidelines` and, for React code, `vercel-react-best-practices`. Today Ark does not require them.\n\n- `worker.md` tells the Designer to read `impeccable` and `emil-design-eng`. The text is a suggestion. Nothing shows which skill guided a card.\n- The plan has no place for a skill. `plan.md` does not show which steps are UI steps.\n- No brief tells the implementer, the validator or the reviewer to read these skills. The reviewer checks \"the repo's conventions\" only.\n- The MR description (`description()` in `cli/merge-request.ts`) has the ticket and the ACs only. The human cannot see which skills were used, or what the reviewer found about the UI.\n\n`Surfaces` in `evaluation.md` has 4 values: `web_ui`, `cli_output`, `document` and `none` (`cli/evaluation.ts`). The human's rule is: any value but `none` means a UI run. This ticket follows the rule as written, so `cli_output` and `document` runs also use the skills.\n\nARK-218 (proposed) will build the MR description from run data. This ticket does not depend on ARK-218. It adds one section to `description()` as it is today. When ARK-218 lands, it must keep the `UI/UX checks` section.\n\nARK-276 edits `run-lead.md`, `chief.md` and `worker.md`. This ticket depends on ARK-276, so the two changes do not conflict.\n\nThe human approved this change.",
        change:
          "1. Add `cli/ui-skills.ts`. It exports one constant, the required UI skills (`impeccable`, `emil-design-eng`, `web-design-guidelines`), the React skill (`vercel-react-best-practices`), and a function that gives the required skills for a `Surfaces` list (an empty list for `none`). This file is the only place with these names.\n2. Add `ark ui-skills <run> [--project <name>]` in `cli/ark.ts`. It prints the skills as in AC1. The playbooks and the error messages refer to this command. They never copy the names.\n3. In `cli/strategy.ts`, add `skills` to the card fields. In `strategyRecord`, apply the existing `needsMockups` case to `Skills:` as in AC3. Use the constant for the check.\n4. In `cli/plan.ts`:\n   - Read an optional `skills` list for each step (`textList`).\n   - Give `findProblems` the `Surfaces` list of the run, and add the 3 checks of AC4.\n   - Add the `Skills` column to the Steps table of `plan.md` only when `Surfaces` is not `none`. A table for `none` does not change.\n5. In `cli/merge-request.ts`, give `description()` the UI/UX section for a run with `Surfaces` not `none`. The skills come from `loadPlan` (it is already loaded in `mergeRequestOpen`). The findings come from the files `<run folder>/findings/<step>.md` of the steps with role `reviewer`. Parse the `### <rank>: <title>` headings and the `**File:**`, `**Line:**`, `**Skill:**` and `**Rule:**` lines. Ignore a finding with no `**Skill:**` line.\n6. In `skills/ark/playbooks/run-lead.md` (Designer brief in section 3, plan section 4, step worker section 7) and `skills/ark/playbooks/worker.md` (section 1, Designer step 4, Reviewer), make the changes of AC5 and AC6. Remove the skill names from `worker.md`, Designer step 4. Do not touch what ARK-276 changed.\n7. Change the tests: `test/ui-skills.test.ts` (new), `test/strategy.test.ts`, `test/plan.test.ts`, `test/merge-request.test.ts` and `test/playbooks.test.ts`. If an existing plan or strategy test uses a run with a surface that is not `none`, it gets a valid `Skills:` or `skills`.\n8. In `docs/reference/cli.md`, write the `Skills:` field and the `skills` step field where the strategy card and `plan.yml` are described. Regenerate the command list with `bun scripts/cli-reference.ts`.\n\nDo not change `ark.yml` or the `Surfaces` values. Do not start a worker in a test. Do not make the CLI decide whether a change touches React code: the run lead and the worker decide, and the React skill is optional in the checks.\n\nRisks:\n\n- A `cli_output` or `document` ru",
        criteria: [
          {
            id: "ARK-279-AC1",
            text: "`ark ui-skills <run> [--project <name>]` prints the UI skills of the run, one line for each. When the `Surfaces` list in the recorded evaluation is not `none`, it prints 3 lines that name the required skills, and one more line, `<react skill> (only when the change touches React code)`. When `Surfaces` is `none`, it prints `none`. It exits 1 for a run with no recorded evaluation. The names are defi",
          },
          {
            id: "ARK-279-AC2",
            text: "The names `web-design-guidelines`, `emil-design-eng` and `vercel-react-best-practices` appear in `cli/ui-skills.ts` and in no other file under `cli/` and in no file under `skills/ark/playbooks/`. The playbooks and every other CLI file take the list from `ark ui-skills` or from the exported constant. A test in `test/ui-skills.test.ts` whose title starts with `ARK-279-AC2` reads these files and fail",
          },
          {
            id: "ARK-279-AC3",
            text: "`ark strategy record <run>` reads a `Skills:` field in each card. When `Surfaces` is not `none` and the Designer runs (the same case in which the command needs a `Mockup:` line), it refuses a card with no `Skills:` line, and a card whose `Skills:` line names a skill that `ark ui-skills` does not list. The refusal names the card and the field. A card with a valid `Skills:` line is recorded. When `S",
          },
          {
            id: "ARK-279-AC4",
            text: "A step in `plan.yml` can have an optional `skills` list. When `Surfaces` is not `none`, `ark plan check <run>` prints a problem and exits 1 when no step has a `skills` list, when a `skills` entry is not a skill that `ark ui-skills` lists, and when a non-empty `skills` list lacks one of the 3 required skills. The React skill is allowed and is not required. When `Surfaces` is not `none`, the Steps t",
          },
          {
            id: "ARK-279-AC5",
            text: "`skills/ark/playbooks/run-lead.md` says: (a) the Designer brief tells the Designer to read and apply the skills of `ark ui-skills <run>`, and each card has a `Skills:` line; (b) the plan section tells the run lead to give a `skills` list to every implementer, validator and reviewer step that touches the UI, and to add the React skill to a step that touches React code; (c) the step worker spec of a",
          },
          {
            id: "ARK-279-AC6",
            text: "`skills/ark/playbooks/worker.md` says: (a) in section 1, a worker whose step has a `skills` list reads each skill with `skill://<name>` before it works, applies it, and names the skills it applied in its `worker_done` report (this covers the implementer and the validator); (b) the Designer step that lists skills to read takes them from `ark ui-skills <run>` and adds `prototype` and `plannotator-vi",
          },
          {
            id: "ARK-279-AC7",
            text: "When `Surfaces` is not `none`, the description of each MR that `ark merge-request open <run>` makes (built by `description()` in `cli/merge-request.ts`) has a section with the heading `## UI/UX checks`. It has the line `Skills applied: <list>`, which is the union of the `skills` lists of the plan steps. It then lists each finding of the reviewer step files `<run folder>/findings/<step>.md` that ha",
          },
          {
            id: "ARK-279-AC8",
            text: "When `Surfaces` is `none`, the description of an MR has no `UI/UX checks` heading and is the same as before this ticket. A test in `test/merge-request.test.ts` whose title starts with `ARK-279-AC8` checks both. `bun test test/merge-request.test.ts -t ARK-279-AC8` exits 0",
          },
          {
            id: "ARK-279-AC9",
            text: "`docs/reference/cli.md` is regenerated with `bun scripts/cli-reference.ts` and lists `ui-skills`. The text in `docs/reference/cli.md` about the strategy card fields and the `plan.yml` step fields lists `Skills:` and `skills`. `bun test`, `bun run typecheck`, `bun run lint` and `bun run format:check` exit 0",
          },
        ],
      },
    },
    {
      project: "ark",
      id: "ARK-280",
      title:
        "Run workers start in a permission mode that needs no human approval, scoped to the run worktree",
      status: "ready",
      milestone: "M1",
      depends_on: [],
      body: {
        problem:
          'A worker that `worker-start` makes can stop at a permission prompt that only the human can approve in the Orca UI. The run waits until Master Chief tells the human. This cost 2 to 9 minutes for each worker.\n\n- Run 2026-11-02-ARK-275-1: 4 of 5 workers stopped (evaluator, designer, implementer, validator). Proposal 2 in its `retro.md` is `proposed`.\n- Run 2026-11-02-ARK-276-1: the evaluator and the first implementer stopped. Proposal 3 in its `retro.md` is `proposed`.\n- Run 2026-11-02-ARK-243-1: `worker-start` for omp changed from terminal mode to structured mode during the run. Structured workers stopped at a permission prompt.\n\nNo playbook, config key or doc says anything about permissions (`grep -i permission skills docs cli hub` finds nothing).\n\nWhat the repo and the tools show on 2026-11-03:\n\n- `orca orchestration worker-start --help` has no permission flag. It says: "How the worker runs follows the user\'s own setting for new agent tabs; there is no flag for it". It lists `--agent`, `--model` and `--effort`. `--effort` is not supported by omp.\n- `omp --help` has `--auto-approve` ("Auto-approve all tool calls") and `--approval-mode` (`always-ask`, `always-ask-cached`, `write`, `yolo`). The matching setting is `tools.approvalMode`.\n- The omp config of the human (`~/.omp/agent/config.yml`) already has `approvalMode: yolo`. Workers still stop. So a structured worker does not read that setting, or Orca (not omp) opens the prompt. The evaluator must find out which, with a real `',
        change:
          "1. Measure first (AC1). Start a scratch worker in each mode `worker-start` allows, with each candidate setting, and write down what stops and what does not. Read `worker-read` and `orca orchestration check` for the prompt, not only the exit code. Do the measure in a scratch worktree, not in the main workspace.\n2. Apply the least permissive setting that works (AC2, AC3). Prefer, in this order: a setting that lives in the run worktree (a file that the Ark worktree command writes and that the git ignore rules keep out of the MR), then a flag or environment on each `worker-start` command. Do not edit `~/.omp`. Do not use `--auto-approve` or `yolo` if `write` or `always-ask-cached` reaches the first tool call with no prompt.\n3. Update `run-lead.md` (the `worker-start` rows of sections 2, 4 and 7), `chief.md` (the run lead start in section 6) and `worker.md` only where the command or the file changes. Add a sentence that a worker that still stops at a prompt is a defect: tell Master Chief, and do not approve it in the worker.\n4. Add the doc text of AC5.\n5. Run the live check of AC4 and write its output in the validator report.\n\nDo not change `ark.yml` roles. Do not start a worker in a unit test: the test reads the playbook text or runs the Ark command against a temporary home.\n\nRisks:\n\n- The finding of AC1 can show that the prompt comes from Orca and no setting of omp reaches it. Then the change moves to Orca's own setting for new agent tabs, and Ark cannot set it for the human. In that case the implementer stops, writes the finding, and asks Master Chief which Orca setting the human wants. It does not weaken a check to pass.\n- A worker with full permission runs any command in its worktree. The scope of AC3 limits it to that worktree, and the reviewer checks that the setting file is not in the MR.",
        criteria: [
          {
            id: "ARK-280-AC1",
            text: "Before any change, the implementer records in `<run folder>/findings/permission-modes.md` what it measured: the output of `orca orchestration worker-start --help` and `omp --help` for each permission option; whether a worker that `worker-start` makes in structured mode and in terminal mode reads the omp setting `tools.approvalMode` (from `~/.omp/agent/config.yml` or from a settings file in the wor",
          },
          {
            id: "ARK-280-AC2",
            text: "The setting of AC1 is applied by Ark, not by the human, to every worker that the playbooks start (evaluator, designer, implementer, validator, reviewer and the run lead). If the setting is a `worker-start` flag or an environment, every `orca orchestration worker-start` command in `skills/ark/playbooks/run-lead.md` and `skills/ark/playbooks/chief.md` carries it. If the setting is a file, the Ark co",
          },
          {
            id: "ARK-280-AC3",
            text: "The setting is safe. It reaches only the worktree of the run, or only the workers that Ark starts. It changes no file outside the run worktree, not `~/.omp`, not the main workspace and not the worktree of another run. It is the least permissive value of AC1, not `yolo`, unless the findings file shows that no other value reaches a first tool call with no prompt. A test in `test/worktree.test.ts` or",
          },
          {
            id: "ARK-280-AC4",
            text: "Live check, recorded in the validator report on the real Orca: start one worker with the exact command that the playbook gives, in a scratch worktree made by the Ark command, and a spec that asks for one shell call (`echo ark-permission-check`). Do this in structured mode and, when `worker-start` can start a terminal worker, in terminal mode too. For each, run `orca orchestration worker-read` and ",
          },
          {
            id: "ARK-280-AC5",
            text: "`docs/how-to/run-a-ticket.md` or `docs/how-to/bootstrap-a-project.md` says which permission setting Ark gives to workers, where it applies, and how to turn it off. `docs/reference/cli.md` is regenerated with `bun scripts/cli-reference.ts` when a command changes. `bun test`, `bun run typecheck`, `bun run lint` and `bun run format:check` exit 0",
          },
        ],
      },
    },
    {
      project: "ark",
      id: "ARK-281",
      title:
        "The auto-merger waits for the run lead's final report and skips a PR whose ticket is not live",
      status: "ready",
      milestone: "M1",
      depends_on: [],
      body: {
        problem:
          '`scripts/auto-merger.sh` merges each PR of a run in `merge_requests_open` as soon as `gh pr view --json mergeStateStatus` says `CLEAN`. It reads nothing else. It does not read `retro.md`, the ticket status or the run lead\'s report.\n\n- On 2026-11-02, it merged PR #80 of ARK-275 (the ticket had become `superseded` by ARK-277). The change landed in `main` and nobody wanted it.\n- It also merges before the run lead sends its final report. The run lead can still be fixing a CI failure, writing the retro or answering a review comment. A merge before the report cannot be undone, and the run lead then works on a branch that is gone.\n\nA wrong merge is the one step in the loop that Ark cannot undo. The script must wait for the run lead and must check that the work is still wanted.\n\nThe final report is the `worker_done` of the run lead (`run-lead.md` section 11, step 3). Master Chief gets it through Orca, and the script runs outside Orca and has no event for it. `run-lead.md` section 11, step 2 says: "A run is not closed until `retro.md` exists, so write it before you finish". The run lead writes `retro.md` immediately before the report, so `retro.md` is the file that the script can read. The evaluator must check this order in `run-lead.md` and say so in its report. If the evaluator finds a better signal that the script can read with no Orca call, it uses that signal and changes AC1 in the plan with a reason.\n\nThe human approved this change.',
        change:
          "1. In `scripts/auto-merger.sh`, for each run in `merge_requests_open`, find the run folder: `${ARK_HOME:-$HOME/.ark}/projects/${ARK_PROJECT:-*}/runs/<run>` (a glob; take the first match). Hold every PR of the run when `retro.md` is missing there.\n2. Read `id` from the frontmatter of `<run folder>/ticket.md`. Read `status:` from `<project folder>/tickets/<id>.md` (the project folder is the parent of `runs`). Hold every PR of the run when the status is `superseded` or `done`. A missing ticket file does not hold.\n3. Read `ark status <run>` again right before `gh pr merge`. Merge only when its `phase:` line is still `phase: merge_requests_open`.\n4. Print `HELD: <run> #<number> <reason>` to stderr once for each held PR (keep the held PR numbers in a shell variable, as `knownConflicts` does). A held PR changes nothing: no `CHANGE:` line and no exit.\n5. In `chief.md` section 12 and in section 7 or 8, write the rules of AC5.\n6. Update the existing auto-merger test (AC6) and add the tests of AC1 to AC5.\n\nDo not read Orca in the script. Do not add a flag for the signal. The script has no config file, and the 3 rules hold for every run.\n\nRisks:\n\n- `retro.md` exists a few seconds before the `worker_done`. A merge in that gap is possible, and it is harmless: the run lead has stopped working on the branch.\n- A run lead that dies before it writes `retro.md` leaves the PR unmerged. The `HELD:` line tells Master Chief, and Master Chief decides with the human. This is the safe failure.\n- A project with a `ticket_source` that is not `local` has no ticket file. The script treats the ticket as live. A later ticket can add the check for other sources.",
        criteria: [
          {
            id: "ARK-281-AC1",
            text: "`scripts/auto-merger.sh` merges a CLEAN PR of a run only when the run lead has sent its final report. The signal is the file `<run folder>/retro.md` (the run lead writes it in section 11 of `run-lead.md` right before its `worker_done`; the run folder is `${ARK_HOME:-$HOME/.ark}/projects/${ARK_PROJECT:-*}/runs/<run>`). A CLEAN PR of a run with no `retro.md` is not merged, and no `gh pr merge` call ",
          },
          {
            id: "ARK-281-AC2",
            text: "`scripts/auto-merger.sh` does not merge a PR of a run whose ticket is not live. The ticket id is the `id` in the frontmatter of `<run folder>/ticket.md`. The ticket file is `${ARK_HOME:-$HOME/.ark}/projects/<project>/tickets/<ticket id>.md`. A ticket is not live when its `status:` is `superseded` or `done`. A ticket file that does not exist counts as live (the `ticket_source` of the project may no",
          },
          {
            id: "ARK-281-AC3",
            text: "A run that is closed is never merged. The script reads the run list from `ark status` (only runs that are not `closed`) and, before each `gh pr merge`, reads `ark status <run>` again and merges only when the phase is still `merge_requests_open`. A test in `test/chief-scripts.test.ts` whose title starts with `ARK-281-AC3` uses a fake `ark` that lists a run as `merge_requests_open` in the first call",
          },
          {
            id: "ARK-281-AC4",
            text: "A held PR does not make the script exit and does not print a `CHANGE:` line. The script prints one line `HELD: <run> #<number> <reason>` to stderr the first time it holds a PR (a `reason` of `no final report` or `ticket <status>`), and not again for the same PR. A test in `test/chief-scripts.test.ts` whose title starts with `ARK-281-AC4` checks that the stderr has the line once after 3 passes and ",
          },
          {
            id: "ARK-281-AC5",
            text: "`skills/ark/playbooks/chief.md` section 12 (the `auto-merger.sh` line) says the 3 rules: the script merges only after the run lead's final report (`retro.md` exists), skips a run whose ticket is `superseded` or `done`, and prints `HELD:` lines to stderr. Section 7 or 8 tells Master Chief that a `HELD: ... ticket superseded` line means: close the run `aborted` or `abandoned` with the human, and clo",
          },
          {
            id: "ARK-281-AC6",
            text: "The existing test `ARK-244-AC3 auto-merger merges the CLEAN PR only, reports the conflict and exits` still passes, with `retro.md` and a `ready` ticket added for its run. `bun test`, `bun run typecheck`, `bun run lint` and `bun run format:check` exit 0",
          },
        ],
      },
    },
    {
      project: "ark",
      id: "ARK-282",
      title:
        "ark plan check rejects a step whose harness and model are not in roles, and a worker that never started costs no round",
      status: "ready",
      milestone: "M1",
      depends_on: [],
      body: {
        problem:
          'A retired model name caused failed worker starts, and a failed start cost a round.\n\n- Runs 2026-11-02-ARK-239-1, ARK-241-1 and ARK-244-1: `worker-start` failed with `Unknown ACP model: pi/task`. `ark.yml` already had `anthropic/claude-sonnet-5-5`, but `plan.yml` still named `pi/task`. `cli/plan.ts:213` only checks that `step.model` is not empty, so `ark plan check` passed.\n- Run 2026-11-02-ARK-244-1: the run lead ran `ark run step <step> start`, the worker did not start, and the run lead ran `finish --failed`. The `step.started` event had already moved the round (`round = max(started rounds)` in `cli/events.ts:222`). The run was at the end of its round budget, so the run went to phase `escalation` and waited about 45 minutes for a human answer. A worker that never ran had cost a round.\n- Run 2026-11-02-ARK-243-1: the same cost, in its retro (proposal 4): "a failed `worker-start` is counted as a round when `ark run step ... start` ran first".\n\nThe retros already name the fix: `finish --failed --not-started` restores the round (ARK-244-1, proposal 2). A plan check that knows `ark.yml` stops the failed start before it happens (ARK-239-1, ARK-241-1, ARK-244-1 proposals).\n\n`ark.yml` `roles` has the pair for each of `implementer`, `validator`, `reviewer` and, optionally, `evaluator`, `designer` and `chief` (`cli/config.ts:13-30`). A plan can give a step another pair than its own role, for example the validator pair for a second reviewer, so the rule is: the pair of a step equals th',
        change:
          '1. In `cli/plan.ts`, `findProblems` gets the `roles` of the project (`loadConfig(project).roles`; `planCheck` already imports `loadConfig`). For each step with a `harness` and a `model`, add the problem of AC1 when the pair is not in `roles`. Keep the existing "no harness" and "no model" problems and do not repeat them for an empty value.\n2. In `cli/run.ts` and `cli/ark.ts`, add the flag `--not-started` to `run step ... finish`. It needs `--failed` and is refused with `start` and `--merge`. It adds `not_started: true` to the `step.finished` data. Count `finishes` for the round of the next implementer start without finishes that have `not_started`.\n3. In `cli/events.ts`, when a `step.finished` has `not_started: true`, remove the round of that step\'s last `step.started` from the rounds that `round` is the maximum of (keep the list of started rounds, `round` is the highest, and at least 1). Check the phase rule that follows (`round >= roundBudget && ...`) with the restored round. `cli/transitions.ts` needs a change only if the check of `data.not_started` in `step.finished` needs a rule.\n4. In `cli/retro.ts`, ignore a step whose last finish has `not_started` in `rework.rounds` (line 526 reads the `round` of each `step.started`) and in the cost by step.\n5. In `run-lead.md` section 7, change the `worker-start` failure rule (AC5).\n6. Update `cli/ark.ts` help text and regenerate `docs/reference/cli.md` (AC6). Fix the fixtures of AC6.\n7. Add tests: `test/plan.test.ts`, `test/run.test.ts`, `test/retro.test.ts`, `test/playbooks.test.ts`.\n\nDo not add a retry for `worker-start`. Do not read Orca in the CLI: the run lead says that the worker did not start. Do not change `ark.yml`.\n\nRisks:\n\n- Plans of open runs that name a pair that is not in `roles` are refused at the next `ark plan check`. The refusal names the pairs that work, and the run lead fixes the plan.\n- `--not-started` is a claim of the run lead. A run lead that uses it for a worker that did run hides a round. The playbook text limits it to a `worker-start` that exited non-zero with no running terminal.\n- The harness name in `ark.yml` (`omp`) and the `--agent` value that Orca takes can differ. The rule compares `plan.yml` with `ark.yml` only. It does not know what Orca accepts, so a model that both files name wrongly still fails at the start. The start failure now costs no round.',
        criteria: [
          {
            id: "ARK-282-AC1",
            text: "`ark plan check <run>` prints a problem and exits 1 for a step whose `harness` and `model` pair is not the pair of any entry in `roles` in the `ark.yml` of the project. The problem names the step, the pair it has, and the pairs that `roles` allows (`step <id> uses <harness>/<model>, which is not in ark.yml roles: <list>`). A step whose pair equals the pair of one role passes, also when the role is",
          },
          {
            id: "ARK-282-AC2",
            text: "`ark run step <run> <step> finish --failed --not-started` records `step.finished` with `outcome: failed` and `not_started: true`. It is a usage error without `--failed`, and with `start`, and with `--merge`. After it, the round of the run is the highest round of the steps that did start: `ark status <run>` prints the same `round:` line and the same phase as before the failed `ark run step <run> <s",
          },
          {
            id: "ARK-282-AC3",
            text: "A failed start never opens the escalation gate. A test in `test/run.test.ts` whose title starts with `ARK-282-AC3` builds a run at the last round with a failed test, records `ark run step <run> <implementer step> start` (after a `one_more_round` answer), then `finish --failed --not-started`, and checks that `ark status <run>` shows phase `building` and no waiting escalation gate, and that a second",
          },
          {
            id: "ARK-282-AC4",
            text: "`ark retro <run>` does not count a step that finished with `not_started: true`: `rework.rounds` and the cost by step ignore it, and `rework.escalations` is unchanged. A step that finished `--failed` without `--not-started` still counts as before. A test in `test/retro.test.ts` whose title starts with `ARK-282-AC4` covers both. `bun test test/retro.test.ts -t ARK-282-AC4` exits 0",
          },
          {
            id: "ARK-282-AC5",
            text: "`skills/ark/playbooks/run-lead.md` section 7 (the `worker-start` failure rule) tells the run lead: when `worker-start` exits non-zero and no worker ran (the output has `failedStage` and no running terminal), run `ark run step <run> <step> finish --failed --not-started`, and not `finish --failed`. It tells the run lead to read the `roles` of `ark.yml` again and to fix the plan with `ark plan check`",
          },
          {
            id: "ARK-282-AC6",
            text: "The `ark plan check` and `ark run step` help in `cli/ark.ts` and `docs/reference/cli.md` (regenerated with `bun scripts/cli-reference.ts`) describe the pair rule, `--not-started` and the `not_started` field. The plan.yml step fields text in `docs/reference/cli.md` says that `harness` and `model` must equal a pair in `roles`. Plans and fixtures in existing tests that use a pair that is not in their",
          },
        ],
      },
    },
    {
      project: "ark",
      id: "ARK-283",
      title: "A criterion can be marked manual and proven by a human gate",
      status: "proposed",
      milestone: "M1",
      depends_on: [],
      body: {
        problem:
          "Some ACs are proved by a person: a live check on the real Orca, a look at the page, a regeneration of docs. `ark test` shows each AC with no tagged test as `missing`, so it exits 1 for these ACs, and the validator writes a test only to make the AC appear.\n\n- Run 2026-11-02-ARK-277-1: the evaluation named a blocker for ARK-277-AC13, a human check. The validator waited in step `hub-tests` for 16,888 s of work time, and the gate wait in `metrics.json` is 135 s (`time.gate_wait_seconds`). The wait for the human counted as work.\n- Runs 2026-11-02-ARK-276-1 (ARK-276-AC8 and AC9) and 2026-11-02-ARK-278-1 (ARK-278-AC6 and AC7): `ark test` showed the ACs of a docs regeneration and a live check as `missing` after the first validator step, and each cost one validator restart. The learning of 2026-11-03 says to write one deterministic test for each. That test does not prove the live check.\n- Open tickets use the text `(live human check)` in ARK-187-AC4, ARK-191-AC4 and ARK-202-AC1 to AC3. Nothing in `ark` records this check, and nothing stops the MR.",
        change:
          "1. Add the field `manual: true` to a criterion in the ticket frontmatter. `ark test` reads it and shows `manual pending`, `manual ok` or `manual problem` for that criterion (AC1).\n2. Add the gate `manual` to `ark gate record` (AC2). The answer is `ok` or `problem`, with an optional note.\n3. In `ark retro`, count the wait between the first `manual pending` and the answer as gate wait (AC3).\n4. In `ark merge-request open`, refuse while a manual criterion has no `ok` (AC4).\n5. Regenerate `docs/reference/cli.md`. In `run-lead.md`, tell the run lead to ask the human for each manual criterion and to record the answer (AC5).\n\nDo not add a new `ark` command (R10). Do not change how a normal criterion is proved.\n\nRisks:\n\n- The criterion field is also read by `ark criteria amend` (ARK-207) and by the hub of ARK-277. Both must keep `manual: true` when they write the ticket.\n- A manual criterion that is `problem` ends in phase `building`. The run lead decides if it starts a round, as for a failing test.",
        criteria: [
          {
            id: "ARK-283-AC1",
            text: "A criterion in the ticket with `manual: true` is shown by `ark test <run>` as `manual pending` until a manual gate answer `ok` exists for it, and as `manual ok` after that. `manual pending` is not `missing`: `ark test` exits 0 when every other criterion passes and every manual criterion is `manual ok`, and exits 1 when a manual criterion is `manual pending` or `manual problem`. A test in `test/tes",
          },
          {
            id: "ARK-283-AC2",
            text: "`ark gate record <run> manual <criterion id> ok\\|problem [--note <text>]` records a `gate.answered` event with the gate `manual`, the criterion id and the answer. It exits 1 and names the id when the criterion is unknown or has no `manual: true`. A test in `test/gate.test.ts` whose title starts with `ARK-283-AC2` covers `ok`, `problem`, an unknown id and a criterion that is not manual. `bun test t",
          },
          {
            id: "ARK-283-AC3",
            text: "`ark retro <run>` counts the time from the first `test.completed` event that lists a manual criterion as `manual pending` to the `gate.answered` manual answer for it as gate wait in `time.gate_wait_seconds`, and not as work time. A test in `test/retro.test.ts` whose title starts with `ARK-283-AC3` uses an event log with a 600 s wait and checks that `gate_wait_seconds` holds it and the work time do",
          },
          {
            id: "ARK-283-AC4",
            text: "`ark merge-request open <run>` exits 1 and names each manual criterion that has no `ok` answer, and opens no MR. When every manual criterion has `ok`, the command behaves as before. A test in `test/merge-request.test.ts` whose title starts with `ARK-283-AC4` covers both cases. `bun test test/merge-request.test.ts -t ARK-283-AC4` exits 0",
          },
          {
            id: "ARK-283-AC5",
            text: "`docs/reference/cli.md` is regenerated with `bun scripts/cli-reference.ts` and lists the gate `manual`. `run-lead.md` tells the run lead to ask the human for each `manual: true` criterion through Master Chief and to record the answer with `ark gate record <run> <gate> ...`. A test in `test/playbooks.test.ts` whose title starts with `ARK-283-AC5` checks the word `manual` in both files. `bun test te",
          },
        ],
      },
    },
    {
      project: "ark",
      id: "ARK-284",
      title:
        "The run page shows every run, open or closed, with its decisions and each agent's transcript, and a live agent opens in Orca",
      status: "ready",
      milestone: "M4",
      depends_on: [],
      body: {
        problem:
          'The hub in `hub/` shows open runs only (`hub/types.ts:121`). A closed run has no page. The run page shows no transcript, so the human cannot see what an agent did, which tools it called or which decisions the run took. The hub has no link to an agent in Orca. The human said on 2026-11-03: "as a user i want the ability to click on a run/task (historic or active) and be able to see all the logs and details, tool hits and decisions from that run. i also would like to be able to click a link to send me to that agents page in orca".',
        change:
          "1. Amend ADR 0009. The hub stays read-only, with one exception: a focus action. `POST /api/open-in-orca` runs `orca terminal switch --terminal <handle>` for a handle that the snapshot lists as live. It sends no text and changes no run state. Only requests from the hub's own page are accepted. File an Orca feature request for an `orca://terminal/<handle>` link, outside Ark.\n2. Add `terminal` and `live` to `Agent` in `hub/types.ts`, from the Orca terminal list that `hub/sources.ts` already reads. Show 'Open in Orca' on Home and on the run page for each live agent, Master Chief included.\n3. Let `#/run/<run>` show any run. Link Backlog rows and Map nodes to runs.\n4. Add a decisions timeline from `events.ndjson`.\n5. Add transcripts from the session files that `hub/usage.ts` already indexes. Map each file whole to the run lead, a step or 'unassigned' (AC5). Do not use the message-by-message window match of `runCost` (`hub/usage.ts:190-197`) for transcripts. A run lead in the anchor worktree (ARK-276) overlaps the step windows.\n6. Read transcripts in the usage worker thread (`hub/usage-worker.ts`), one page of 200 entries per request. The rule of ARK-277 becomes: a request handler reads memory or asks the worker thread for one page.\n7. Show run files as text, inside the run folder only.\n\nDo not show full tool results, cost or tokens in the transcript. Do not redact. The hub serves only `127.0.0.1`, and the session files are already readable by the same user (ADR 0003). Do not add search inside transcripts.\n\nRisks:\n\n- Some session files are very large (one is 248 MB under `~/.omp/agent/sessions`). AC7 bounds the read.\n- Orca has no link to an agent page. `orca terminal switch` is the only way, so the hub needs the one POST route of AC1.\n- The start-time rule of AC5 can leave files 'unassigned' when a worker starts before `step.started` is recorded. The list shows them, so nothing is hidden.",
        criteria: [
          {
            id: "ARK-284-AC1",
            text: 'ADR 0009 allows one action: `POST /api/open-in-orca` with `{ "terminal": <handle> }`. It runs `orca terminal switch --terminal <handle>`. It sends no text into a terminal and changes no run state. It answers 403 to a request whose Origin or Host is not the hub\'s own `127.0.0.1` address, 400 to a handle that the current snapshot does not list as live, and 502 when `orca` fails. The test `ARK-277-AC',
          },
          {
            id: "ARK-284-AC2",
            text: "Each agent in the snapshot has `terminal` (the Orca handle or null) and `live` (true when Orca lists the terminal as connected). Home and the run page show an 'Open in Orca' button for each live agent, Master Chief included. The button posts AC1. An agent that is not live shows 'ended, not in Orca' and no button. A Playwright spec in `test/pw/hub.pw.ts` whose title starts with `ARK-284-AC2` covers",
          },
          {
            id: "ARK-284-AC3",
            text: "`#/run/<run>` shows a closed run as well as an open one. Each Backlog row links to the runs of its ticket, newest first. A Map node with a run links to the newest run of its ticket. A Playwright spec in `test/pw/hub.pw.ts` whose title starts with `ARK-284-AC3` opens a closed run from Backlog and from the Map. `bunx playwright test test/pw/hub.pw.ts -g ARK-284-AC3` exits 0",
          },
          {
            id: "ARK-284-AC4",
            text: "The run page shows a decisions timeline from `events.ndjson`, oldest first: each `gate.answered` with its gate and answer, `strategy.recorded`, `plan.checked`, `evaluation.recorded`, `escalation.requested`, `test.completed` with pass and fail counts, `merge_request.opened` and `run.closed` with its outcome. Each entry shows its time. A Playwright spec in `test/pw/hub.pw.ts` whose title starts with",
          },
          {
            id: "ARK-284-AC5",
            text: "Session files map to agents whole, never message by message. A file whose start time falls in a step window, in that step's worktree, belongs to that step. The file in the run folder that starts before the first step and ends after it belongs to the run lead. Every other file under the run folder is listed as 'unassigned'. A test in `test/hub.test.ts` whose title starts with `ARK-284-AC5` covers a",
          },
          {
            id: "ARK-284-AC6",
            text: "A click on a DAG node, on the run lead or on an unassigned file opens its transcript. The transcript shows each message with role and time, and each tool call with tool name, arguments, `ok` or `error` and the first line of the result. It shows no full tool result. Thinking blocks are folded by default and open on a click. It works for omp, Claude and Codex session files. A Playwright spec in `tes",
          },
          {
            id: "ARK-284-AC7",
            text: "Transcripts load on demand in the usage worker thread, 200 entries per page, with a 'Load more' button. While the worker reads a 200 MB session file, `/` and `/nope` answer with a p95 below 200 ms. A test in `test/hub.test.ts` whose title starts with `ARK-284-AC7` covers this. `bun test test/hub.test.ts -t ARK-284-AC7` exits 0",
          },
          {
            id: "ARK-284-AC8",
            text: "The run page links to `plan.md`, `strategies.md`, `retro.md` and each file in `findings/` and `results/` that exists, and shows each one as text. A missing file has no link. A path outside the run folder answers 404. A Playwright spec in `test/pw/hub.pw.ts` whose title starts with `ARK-284-AC8` covers 1 present file, 1 missing file and a `../` path. `bunx playwright test test/pw/hub.pw.ts -g ARK-2",
          },
          {
            id: "ARK-284-AC9",
            text: "`bun test`, `bun run typecheck`, `bun run lint` and `bun run format:check` exit 0",
          },
          {
            id: "ARK-284-AC10",
            text: "Live human check: the human opens a closed run and an open run on the real `ARK_HOME`, opens one step transcript in each, and clicks 'Open in Orca' on one live agent. Orca shows that agent. The validator report records what the human saw",
          },
        ],
      },
    },
  ],
  queued: [
    {
      ticket: "ARK-185",
      blocked_by: [],
    },
    {
      ticket: "ARK-187",
      blocked_by: [],
    },
    {
      ticket: "ARK-191",
      blocked_by: ["ARK-188"],
    },
    {
      ticket: "ARK-200",
      blocked_by: [],
    },
    {
      ticket: "ARK-202",
      blocked_by: ["ARK-200"],
    },
  ],
  progress: {
    "2026-11-03-ARK-284-1": {
      steps_done: 0,
      steps_total: 4,
      round: 1,
      round_budget: 2,
      current_step_minutes: 7,
      median_step_minutes: 14,
      eta_minutes: 35,
    },
    "2026-11-03-ARK-282-1": {
      steps_done: 1,
      steps_total: 4,
      round: 1,
      round_budget: 2,
      current_step_minutes: 2,
      median_step_minutes: 14,
      eta_minutes: 50,
    },
    "2026-11-03-ARK-281-1": {
      steps_done: 2,
      steps_total: 4,
      round: 1,
      round_budget: 2,
      current_step_minutes: 19,
      median_step_minutes: 14,
      eta_minutes: 20,
    },
    "2026-11-03-ARK-280-1": {
      steps_done: 0,
      steps_total: 4,
      round: 1,
      round_budget: 2,
      current_step_minutes: 18,
      median_step_minutes: 14,
      eta_minutes: 25,
    },
    "2026-11-03-ARK-188-1": {
      steps_done: 1,
      steps_total: 4,
      round: 2,
      round_budget: 2,
      current_step_minutes: 1,
      median_step_minutes: 14,
      eta_minutes: 60,
    },
  },
  stuck: [
    {
      run: "2026-11-03-ARK-281-1",
      ticket: "ARK-281",
      role: "validator",
      terminal: "term_demo-281-validator",
      kind: "waiting_on_prompt",
      since_minutes: 19,
      last_line: "Allow bash: bun test test/auto-merger.test.ts? [y/N]",
    },
    {
      run: "2026-11-03-ARK-280-1",
      ticket: "ARK-280",
      role: "implementer",
      terminal: "term_demo-280-impl",
      kind: "idle",
      since_minutes: 18,
      last_line: "Working\u2026 (no output for 18 min)",
    },
  ],
  review_queue: [
    {
      run: "2026-11-02-ARK-278-1",
      ticket: "ARK-278",
      title:
        "Run close releases the settled Orca workers of the run, and --sweep releases them for runs that are already closed",
      merge_order: 1,
      url: "https://github.com/cobekarhoff/ark/pull/86",
      ci: "passing",
      diff: {
        files: 6,
        added: 312,
        removed: 41,
      },
      tests: {
        passed: 412,
        failed: 0,
      },
      findings: {
        open: 0,
        fixed: 3,
      },
      waiting_minutes: 42,
      criteria: [
        {
          id: "ARK-278-AC1",
          proof: "test",
          status: "pass",
        },
        {
          id: "ARK-278-AC2",
          proof: "test",
          status: "pass",
        },
        {
          id: "ARK-278-AC3",
          proof: "test",
          status: "pass",
        },
        {
          id: "ARK-278-AC4",
          proof: "test",
          status: "pass",
        },
        {
          id: "ARK-278-AC5",
          proof: "test",
          status: "pass",
        },
        {
          id: "ARK-278-AC6",
          proof: "test",
          status: "pass",
        },
        {
          id: "ARK-278-AC7",
          proof: "live check",
          status: "pass",
        },
      ],
    },
    {
      run: "2026-11-03-ARK-282-1",
      ticket: "ARK-282",
      title:
        "ark plan check rejects a step whose harness and model are not in roles, and a worker that never started costs no round",
      merge_order: 2,
      url: "https://github.com/cobekarhoff/ark/pull/88",
      ci: "failing",
      diff: {
        files: 4,
        added: 158,
        removed: 22,
      },
      tests: {
        passed: 409,
        failed: 2,
      },
      findings: {
        open: 1,
        fixed: 1,
      },
      waiting_minutes: 6,
      criteria: [
        {
          id: "ARK-282-AC1",
          proof: "test",
          status: "pass",
        },
        {
          id: "ARK-282-AC2",
          proof: "test",
          status: "fail",
        },
        {
          id: "ARK-282-AC3",
          proof: "test",
          status: "pass",
        },
      ],
    },
  ],
  usage: {
    daily_cost_usd: {
      "2026-10-29": 0.781984,
      "2026-10-30": 1.5310160000000002,
      "2026-10-31": 12.052762,
      "2026-11-01": 23.861765000000002,
      "2026-11-02": 42.60714299999999,
    },
    today_usd: 9.03,
    limits: [
      {
        provider: "anthropic",
        window: "5h",
        used_pct: 82,
        resets_in_minutes: 74,
      },
      {
        provider: "openai-codex",
        window: "weekly",
        used_pct: 31,
        resets_in_minutes: 5400,
      },
    ],
  },
};
