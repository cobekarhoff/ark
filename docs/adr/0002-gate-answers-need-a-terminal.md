# Gate answers are confirmed on the controlling terminal

A gate answer counts only when a human gives it through a channel an agent cannot drive. `ark gate answer` requires the gate name typed on `/dev/tty`. The console's answer action (localhost, human-clicked) counts too. An answer recorded any other way is refused, whatever git identity the caller has.

We rejected identity checks because the orchestrator can run `ark gate answer` through bash with the user's git config. We rejected environment markers because OMP injects only `PI_SESSION_ID` and `PI_SESSION_FILE`, which an agent can unset or forge. Signed answers (SSH key over the packet hash) are stronger and work headless, but add a signing step at every gate; revisit them if runs move to a shared CI runner.

Assumption to verify before relying on it: OMP's bash tool gives agents no controlling terminal.
