# Rules for every Ark role

Every Ark role skill and the two test case skills read this file first.

- The `ark` command does the repeatable work: run state, worktrees, tests, MRs and metrics. Never edit `events.ndjson` or `state.json` by hand.
- Answers at a gate are the human's decisions. An agent never answers a gate for the human.
- Master Chief and run leads never write product code. Only an implementer worker does.
- An agent stops only a process it started, by its PID, and never runs a kill by name or pattern (`pkill`, `killall`, `kill` on a `ps` grep), because every run's tests share the host.
- Run folders live under `$ARK_HOME/projects/<project>/runs/<run>/`. `ARK_HOME` defaults to `~/.ark`. In a skill, `<run folder>` is that folder: find it with `ls -d ${ARK_HOME:-~/.ark}/projects/*/runs/<run>`.
