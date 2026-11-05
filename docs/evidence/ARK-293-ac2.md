# ARK-293 AC2: agent model source

ARK-293-AC2 proves where a hub agent's model comes from. The session model (what Orca reports, else the last message of the newest session file) is in `Agent.model`. `Agent.planned` is null when a model is known; it holds the plan model only when no session model exists. A run lead gets the `roles.chief` model (configured).

Tests: the `ARK-293-AC2` tests in `test/hub.test.ts`, run with `bun test test/hub.test.ts`.
