# ARK-300 AC5: live check

Read-only checks on this Mac, 2026-11-03, portless 0.15.13. The validator did not run `ark ui install` from the run worktree, because the plist would point at a path that is removed when the run closes.

## portless list

```text
No active routes.
Start an app with: portless <name> <command>
```

## portless doctor

```text
Version: 0.15.13
Node.js: 24.13.1
Mode: HTTP, .localhost
ok    Proxy is responding on port 80.
ok    Proxy PID file points to the responding proxy process: 96649
info  No routes are registered.
Summary: 0 failures, 0 warnings.
```

## curl -s -o /dev/null -w '%{http_code}' http://nope.localhost/

```text
404
```

## curl -sf http://127.0.0.1:4317/api/snapshot

Exit 0. The body starts with `{"generated_at":"2026-11-04T00:51:14.504Z","sources":{"ark":{"ok":true,...`.

## launchctl list | grep dev.ark

```text
22424	0	dev.ark.hub
```

Only the plain `dev.ark.hub` is loaded; `dev.ark.proxy` is not installed yet and the hub has no route.

install: pending (Master Chief runs ark ui install from the main checkout after the merge)

login proof: pending

proof: partial
