# SP3b — Slack Socket Mode inbound setup

One-time manual step, same app as SP3a (`WYRE Agents`, App ID `A0B8MN37YSC`,
workspace `wyretalk.slack.com` — see `sp3a-slack-app-setup.md`). Do NOT
create a second app.

## Steps

1. **Enable Socket Mode.** App settings → **Socket Mode** → toggle **ON**.
2. **Generate an App-Level Token.** App settings → **Basic Information** →
   **App-Level Tokens** → **Generate Token**. Name it (e.g. `socket-mode`),
   scope: `connections:write`. This produces an `xapp-…` token.
3. **Stash in Key Vault**, matching `slack-bot-token`'s naming convention:

       az keyvault secret set --vault-name cortextos-prod-kv-d1fd92 \
         --name slack-app-token --value '<paste-xapp-token>' --output none

4. **Bot Token Scopes** (OAuth & Permissions → Bot Token Scopes) — add:
   - `channels:history` (read public channel messages)
   - `groups:history` (read private channel messages)
   - `im:history` (read DMs to the bot, if DM support is wanted)

   (SP3a's manifest already has `chat:write`, `channels:read`, `groups:read`
   — those stay as-is.)
5. **Event Subscriptions** (Features → Event Subscriptions): toggle
   **Enable Events ON** — no Request URL needed, Socket Mode delivers events
   over the WebSocket instead. Subscribe to bot events:
   - `message.channels`
   - `message.groups`
   - `message.im` (if DMs wanted)
   - `app_mention`
6. **Reinstall the app to the workspace.** Required for new scopes to take
   effect — this **re-issues the bot token** (`xoxb-…`) too, not just the new
   app-level one. Both need to land on the VM (step 7 below covers both).
7. **Verify the KV write:**

       az keyvault secret show --vault-name cortextos-prod-kv-d1fd92 \
         --name slack-app-token --query "[name, length(value)]" -o tsv

   Expected: `slack-app-token` + a length around 60+.

8. **Get it onto the running VM.** `az keyvault secret set` alone does
   **NOT** reach the running daemon — confirmed from
   `infra/terraform/cloud-init.yaml.tftpl` + the `cortextos.service` systemd
   unit: the daemon's `EnvironmentFile=/etc/cortextos.env` is populated by
   `cortextos-bootstrap.service`, a **oneshot** unit gated by
   `ConditionPathExists=!/var/lib/cortextos/.bootstrap-done` — it only runs
   once, on first boot. There is no periodic KV→env sync. (This is also true
   of `slack-bot-token`'s rotation path in `sp3a-slack-app-setup.md` — that
   runbook's "update KV then restart" instruction is incomplete as written;
   `sudo systemctl restart cortextos` alone does not re-fetch KV, since
   `cortextos.service`'s `Requires=cortextos-bootstrap.service` only ensures
   the oneshot has run at some point, not that it re-runs.)

   For tonight (VM already bootstrapped, SP3a already live), the working
   path is to mirror the bootstrap script's own write pattern directly:

       ssh wyre-agents-ssh.wyre.ai
       sudo bash -c 'grep -q "^SLACK_APP_TOKEN=" /etc/cortextos.env \
         && sed -i "s|^SLACK_APP_TOKEN=.*|SLACK_APP_TOKEN=<xapp-token>|" /etc/cortextos.env \
         || echo "SLACK_APP_TOKEN=<xapp-token>" >> /etc/cortextos.env'
       sudo chmod 600 /etc/cortextos.env
       # if the reinstall in step 6 issued a new xoxb- bot token, update that line too:
       sudo bash -c 'sed -i "s|^SLACK_BOT_TOKEN=.*|SLACK_BOT_TOKEN=<new-xoxb-token>|" /etc/cortextos.env'
       sudo systemctl restart cortextos

   `infra/terraform/cloud-init.yaml.tftpl` now also fetches `slack-app-token`
   the same way it fetches `slack-bot-token` (symmetric block added
   alongside this PR), so a **future** VM rebuild or a deliberate bootstrap
   re-run (`sudo rm /var/lib/cortextos/.bootstrap-done && sudo systemctl
   start cortextos-bootstrap.service` — note this re-runs the FULL bootstrap
   sequence, not just the Slack fetch, so prefer the direct env-file edit
   above for a routine token add/rotation) will pick it up from KV
   automatically. KV remains the source of truth for disaster recovery even
   though tonight's immediate path is the direct env-file edit.

## Per-agent setup (after the app-level steps above)

1. **Invite the bot** to whichever channel(s) the agent should listen on:
   `/invite @WYRE Agents` in that channel.
2. **Get the channel id.** `cortextos slack discover-channels` lists every
   channel the bot is in with its id.
3. **Fail-closed user allowlist.** Add every Slack user id that should be
   able to message this agent to `slack.json`'s `allowed_users`, as
   `"<team_id>:<user_id>"` composite keys (not bare user ids — see
   `identity.ts`'s docblock for why). Get a user's id via their Slack profile
   → "Copy member ID", and the team id from the workspace's own id (visible
   in the workspace URL or `team.info`). **An agent with an empty or missing
   `allowed_users` accepts messages from no one** — this is deliberate
   fail-closed behavior (mirrors Telegram's `ALLOWED_USER`), not a bug.

   ```json
   {
     "channels": { "recap": "C01XXXX01" },
     "allowed_channels": ["C01XXXX01"],
     "allowed_users": ["T0ABCDEF:U0123456"]
   }
   ```

   `display_name`/`icon_emoji`/`icon_url` are accepted in the schema but
   have no effect as of the 2026-10 identity-gate hardening
   (task_1790871245210_64848240): an outbound message's posted username is
   always the agent's own `CTX_AGENT_NAME`, read from that agent's own
   process environment, never from this file — a file is not a safe
   identity source, since any agent can read any other agent's `slack.json`.
   Setting `display_name` here will silently do nothing; don't rely on it.

   Note: `allowed_users` is a single flat list across ALL of this agent's
   `allowed_channels` — not a per-channel map. Fine for a single-channel
   agent; a future multi-channel agent needing different trust levels per
   channel would need this reworked.

## What SP3b does NOT do (deferred to SP3c)

Interactive hooks (Block Kit Approve/Deny buttons, thread-reply asks,
channel-routed crash alerts) are a separate sub-project per the SP3 design
spec (`docs/superpowers/specs/2026-06-02-wyre-cortextos-sp3-slack-design.md`).
SP3b delivers plain conversational inbound: a message in an allowed channel
from an allowed user gets injected into the agent's PTY session, same shape
as Telegram.

## Design deviation from the original SP3 spec — logged for the record

The original SP3 design spec's ACL model was channel-only ("Bot listens to
channels it's invited to; each agent has an allowlist of channels... messages
from non-allowlisted channels are dropped silently"). SP3b's actual build
adds a second, independent user-level `allowed_users` gate on top of the
channel allowlist — an explicit fail-closed decision made during tonight's
build (boss + warden security review), not a deviation discovered later.
Channel membership alone was judged too weak a security boundary: channels
are N-member and membership can drift after setup. Both gates must pass.

## Rotation

Same procedure as `slack-bot-token` (see `sp3a-slack-app-setup.md`'s
Rotation section) — rotate both `slack-bot-token` and `slack-app-token` if
either is compromised, then restart the daemon.
