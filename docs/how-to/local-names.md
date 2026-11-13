# Reach the hub by a local name

macOS only. This page uses launchd. On Linux, run `ark ui` directly and open `http://127.0.0.1:4317`.

This page shows you how to open the Ark hub as `http://ark.localhost` instead of `http://127.0.0.1:4317`, and how to check and remove the names. The names are HTTP only: there is no certificate.

## What the names are

| Name                      | What it serves                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ark.localhost`           | The main hub, started at login by `ark ui install`.                                                                        |
| `hub.<slug>.localhost`    | A hub that a run lead starts from a run's worktree to check the change live. `<slug>` names that run, such as `ark-291-1`. |
| `<topic>.proto.localhost` | A prototype that a run lead starts for one topic.                                                                          |

A local proxy (`portless`) owns these names and sends each one to the port of the process that registered it.

## Before you begin

- Node 24+ on your `PATH`. The LaunchAgents copy the `PATH` of the shell that runs `ark ui install`, so run it from a shell where `node` resolves.
- Install portless:

  ```sh
  npm i -g portless
  ```

## Install

```sh
ark ui install
```

`ark ui install` writes two LaunchAgents in `~/Library/LaunchAgents`: `dev.ark.proxy` (runs `portless proxy start --unprivileged` at login) and `dev.ark.hub` (runs the hub through portless as `ark.localhost`). Expected output:

```text
Installed LaunchAgent dev.ark.proxy
  plist:  /Users/you/Library/LaunchAgents/dev.ark.proxy.plist
  log:    /Users/you/.ark/hub/proxy.log
Installed LaunchAgent dev.ark.hub
  plist:  /Users/you/Library/LaunchAgents/dev.ark.hub.plist
  hub:    http://127.0.0.1:4317
  name:   http://ark.localhost
  log:    /Users/you/.ark/hub/hub.log
The proxy starts at login. The hub starts at login and restarts after a crash. Both are running now.
Remove them with: ark ui uninstall
```

The hub restarts only after a crash, not after a clean exit. One hub runs per Ark repo: a second hub, on any port, prints `Ark hub already runs on http://127.0.0.1:<port>` and exits 0, so launchd does not restart it. The operating system holds the lock on a file in `ARK_HOME`, and releases it when the hub dies, however it dies, so a killed hub never blocks the next one.

If portless is not found, install writes only the plain hub agent, prints this line and exits 0:

```text
portless not found: the hub stays at http://127.0.0.1:4317
```

Run `ark ui install` again after you install portless. A second run with the same settings changes nothing and prints:

```text
LaunchAgents dev.ark.proxy and dev.ark.hub are already installed. Nothing changed.
  plist:  /Users/you/Library/LaunchAgents/dev.ark.proxy.plist
  plist:  /Users/you/Library/LaunchAgents/dev.ark.hub.plist
  hub:    http://127.0.0.1:4317
  name:   http://ark.localhost
```

The hub may start before the proxy at login. This is accepted: portless then starts a proxy by itself, and the live check shows the result.

## Check that it works

```sh
portless doctor
portless list
curl -sf http://ark.localhost/api/snapshot
```

`portless doctor` ends with `Summary: 0 failures, 0 warnings.` `portless list` shows `ark.localhost`:

```text
Active routes:

  http://ark.localhost  ->  localhost:4317  (pid 45066) up 2h
```

The `curl` prints the hub's snapshot as JSON. A name that no route owns gets 404 from the proxy:

```sh
curl -s -o /dev/null -w '%{http_code}' http://nope.localhost/
```

This prints `404`.

## Remove

```sh
ark ui uninstall
```

This unloads and deletes both LaunchAgents. The hub stops and neither agent starts at login. The shared portless proxy keeps running, because it is a detached background process that launchd does not own. Stop it with `portless proxy stop`. Expected output:

```text
Removed LaunchAgent dev.ark.hub
  plist:  /Users/you/Library/LaunchAgents/dev.ark.hub.plist (deleted)
Removed LaunchAgent dev.ark.proxy
  plist:  /Users/you/Library/LaunchAgents/dev.ark.proxy.plist (deleted)
The hub is stopped and neither agent starts at login. The shared portless proxy keeps running until you run: portless proxy stop
```

With nothing installed it prints `LaunchAgents dev.ark.hub and dev.ark.proxy are not installed. Nothing changed.`

## Who can reach the proxy

The proxy listens on all interfaces, because an unprivileged process cannot bind `127.0.0.1:80` on macOS. It refuses a peer that is not loopback.

### Evidence

Smoke test, 2026-11-03, portless 0.15.13:

- A request to the LAN IP `192.168.0.174:80` was reset before any response (curl exit 56), with and without the right `Host` header.
- Loopback got 200.
- A name that no route owns gets 404 from the proxy and never reaches a hub.

### Not tested

Safari, Firefox, HTTPS, a reboot.

## If it does not work

- **`portless not found`:** install it with `npm i -g portless`, then run `ark ui install` again. To use another binary, set `ARK_PORTLESS` to its path.
- **The proxy is not running after login:** its LaunchAgent has `KeepAlive` off, because `portless proxy start` starts a background proxy and exits at once. A proxy that dies is not restarted. Run `portless proxy start --unprivileged`. Running `ark ui install` again changes nothing.
- **The route is missing, or `portless` fails with a Node error:** run `portless doctor`. Install from a shell where Node 24+ resolves, so the LaunchAgent `PATH` holds it.
- Portless is pre-1.0 (0.15.13), so its flags may change. `portless doctor` is the check.
