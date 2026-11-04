# ARK-299 AC4: live check

Followed `Live human check` in `skills/ark/playbooks/run-lead.md` for the made-up slug `ark-299-check`, from the run worktree, 2026-11-03. The proxy runs in HTTP mode (`portless doctor`: `Mode: HTTP, .localhost`, `ok    Proxy is responding on port 80.`, 0 failures). The page is `http://hub.ark-299-check.localhost`.

Free port picked first: 63792.

```text
$ portless hub.ark-299-check --app-port 63792 ark ui --port 63792 --name hub.ark-299-check.localhost
portless

-- Proxy is running
-- hub.ark-299-check.localhost (auto-resolves to 127.0.0.1)
-- Using port 63792 (fixed)
```

Route while the hub runs:

```text
$ portless list

Active routes:

  http://hub.ark-299-check.localhost  ->  localhost:63792  (pid 51698) up 2s

```

Preflight:

```text
$ curl -sf http://hub.ark-299-check.localhost/api/snapshot
{"generated_at":"2026-11-04T00:39:22.260Z","sources":{"ark":{"ok":true,"read_at":"2026-11-04T00:39:22.258Z"},"orca":{"ok":…
(exit 0)
```

Open the page in the worktree:

```text
$ orca tab create --worktree path:/Users/cobekarhoff/.ark/projects/ark/runs/2026-11-03-ARK-299-1/workspace --url http://hub.ark-299-check.localhost
Created tab 9b599fd4-9069-44fe-99e8-b906a2cc22b8
(exit 0)
```

Stop the hub, then list again:

```text
$ portless list
No active routes.
Start an app with: portless <name> <command>
```
