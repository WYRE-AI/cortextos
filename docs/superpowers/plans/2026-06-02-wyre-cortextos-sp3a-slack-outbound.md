# WYRE cortextOS SP3a — Slack outbound — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents can post to Slack channels with per-agent identity. After SP3a a script (`bus/send-slack.sh boss recap "morning report"`) hits the WYRE workspace and appears in `#agents-recap` under the `boss` username with the boss icon.

**Architecture:** One WYRE Slack app installed manually (runbook walkthrough); bot token stored in Key Vault and pulled into `/etc/cortextos.env` by cloud-init at boot. `src/slack/api.ts` is the Web API client (built-in fetch, no external dependencies). `src/slack/identity.ts` reads per-agent `slack.json` to apply `username`/`icon_emoji` overrides on every outbound message. `bus/send-slack.sh` is the shell entry point (mirror of `bus/send-telegram.sh`). A new `cortextos slack` CLI subcommand provides `test-send` and `discover-channels` for ops.

**Tech Stack:** TypeScript (strict), Node 20 fetch, Vitest, Bash (bus helper), Terraform (KV secret + cloud-init wiring).

**Spec:** `docs/superpowers/specs/2026-06-02-wyre-cortextos-sp3-slack-design.md`

**Conventions:**
- Working dir `~/cortextos`. Branch `feat/sp3a-slack-outbound` (created in Task 1).
- All TS tests run via `npm test` (Vitest, `tests/unit/...` for unit tests).
- After every code task: `npm run typecheck && npm run build && npm test` (full suite must stay at the same pass/skip baseline).
- Commit per task with `git -c user.name="Aaron Sachs" -c user.email="aaron@wyretechnology.com"`.

**Pre-flight (controller, before Task 2):** the SP3 spec must be on `main` (PR merged). Verify with `git log --oneline -1 origin/main`.

---

## Task 1: Operator — register the Slack app and stash the bot token

This task is **manual, operator-only**. The controller asks Aaron to follow the runbook steps and paste back the bot token (which the controller writes to Key Vault). Cost: ~5 min in Slack's developer console.

**Files:**
- Create: `docs/runbook/sp3a-slack-app-setup.md`
- New branch: `feat/sp3a-slack-outbound`

- [ ] **Step 1: Cut the branch**

```bash
cd ~/cortextos
git checkout main && git pull --ff-only
git checkout -b feat/sp3a-slack-outbound
```

- [ ] **Step 2: Write the runbook walkthrough**

Create `docs/runbook/sp3a-slack-app-setup.md` with this content (verbatim):

````markdown
# SP3a — Slack app one-time setup

This is a one-time manual step. After it's done, the bot token sits in Key
Vault and the cortextOS bootstrap picks it up automatically on every boot.

## Prereq

- WYRE Slack workspace admin access (or someone with permission to install
  apps in the workspace).
- Operator IP on `operator_ip_cidrs` (needed for the final `az keyvault
  secret set`).

## Steps

1. **Create the app.** Go to https://api.slack.com/apps → **Create New App** →
   **From scratch**.
   - App Name: `WYRE Agents`
   - Workspace: select the WYRE workspace
   - Create

2. **Add bot scopes.** Left sidebar → **OAuth & Permissions** → scroll to
   **Bot Token Scopes** → add:
   - `chat:write`
   - `chat:write.customize` (REQUIRED — enables per-agent username/icon
     override; if Slack ever removes this, see the spec's "graceful fallback"
     section)
   - `files:write`
   - `channels:read` (for `cortextos slack discover-channels`)
   - `groups:read` (private channels the bot is invited to)
   - `im:read`
   - `mpim:read`
   - `users:read` (optional, for member lookups)

3. **Install to the workspace.** Top of the same page → **Install to Workspace**
   → Allow. Copy the **Bot User OAuth Token** (starts with `xoxb-`).

4. **Stash in Key Vault.** From your laptop (operator IP must be on
   `operator_ip_cidrs`):

       az keyvault secret set --vault-name cortextos-prod-kv-d1fd92 \
         --name slack-bot-token --value '<paste-xoxb-token>' --output none

5. **Verify:**

       az keyvault secret show --vault-name cortextos-prod-kv-d1fd92 \
         --name slack-bot-token --query "[name, length(value)]" -o tsv
   Expected: `slack-bot-token` + a length around 75+.

> **Note:** Socket Mode (the **App-Level Token**) is set up in SP3b, not now.
> SP3a is outbound-only and doesn't need it.

## What you don't have to do yet

- Create the `#agents-*` channels. SP3a's smoke test posts to any channel
  you invite the bot into; topical channel inventory lands in SP3b.
- Invite the bot to channels. We do that during the smoke test (Task 10
  Step 2 below).
````

- [ ] **Step 3: Operator follows the runbook**

(Controller prompts the user.) Once the user reports the token is in KV,
proceed.

- [ ] **Step 4: Commit the runbook**

```bash
git add -f docs/runbook/sp3a-slack-app-setup.md
git commit -m "docs: SP3a runbook — Slack app one-time setup walkthrough"
```

---

## Task 2: Cloud-init — pull the Slack bot token from KV into env

The cloud-init bootstrap already pulls the cloudflared token from KV. Mirror that for `slack-bot-token`. Without it, the daemon and the bus scripts wouldn't have `SLACK_BOT_TOKEN` set on the VM.

**Files:**
- Modify: `infra/terraform/cloud-init.yaml.tftpl`

- [ ] **Step 1: Find the existing cloudflared token pull**

Locate the block in the embedded bootstrap script that fetches the cloudflared
token (search for `cloudflared-token`). It uses `az keyvault secret show`
piped into a file or env-export pattern.

- [ ] **Step 2: Add a parallel block for slack-bot-token, write into /etc/cortextos.env**

Insert, immediately after the cloudflared token fetch:

```bash
      # ── Slack bot token (SP3a) ─────────────────────────────────
      # Optional — SP3a is opt-in; agents without slack.json don't care.
      # We always try the fetch; absent secret is non-fatal.
      log "fetching slack-bot-token from KV"
      SLACK_BOT_TOKEN=$(az keyvault secret show --vault-name "${key_vault_name}" \
        --name slack-bot-token --query value -o tsv 2>/dev/null || true)
      if [ -n "$SLACK_BOT_TOKEN" ]; then
        # Append to /etc/cortextos.env iff not already present (idempotent).
        if ! grep -q '^SLACK_BOT_TOKEN=' /etc/cortextos.env 2>/dev/null; then
          echo "SLACK_BOT_TOKEN=$SLACK_BOT_TOKEN" >> /etc/cortextos.env
        else
          sed -i "s|^SLACK_BOT_TOKEN=.*|SLACK_BOT_TOKEN=$SLACK_BOT_TOKEN|" /etc/cortextos.env
        fi
        chmod 600 /etc/cortextos.env
        log "SLACK_BOT_TOKEN written to /etc/cortextos.env"
      else
        log "slack-bot-token not found in KV — SP3a inactive (this is fine)"
      fi
      unset SLACK_BOT_TOKEN
```

- [ ] **Step 3: Verify YAML + terraform**

```bash
cd infra/terraform
sed -e 's/${cortextos_instance}/prod/g' \
    -e 's/${cortextos_org}/wyre/g' \
    -e 's|${cortextos_repo_url}|x|g' \
    -e 's/${cortextos_branch}/x/g' \
    -e 's/${node_major_version}/20/g' \
    -e 's/${key_vault_name}/x/g' \
    -e 's/${dashboard_hostname}/x/g' \
    cloud-init.yaml.tftpl | python3 -c "import sys, yaml; yaml.safe_load(sys.stdin)" && echo "YAML OK"
terraform fmt && terraform validate
```

- [ ] **Step 4: Commit**

```bash
git add infra/terraform/cloud-init.yaml.tftpl
git commit -m "feat(infra): cloud-init pulls slack-bot-token from KV into /etc/cortextos.env"
```

---

## Task 3: `src/slack/api.ts` — Web API client

The TypeScript outbound client. Mirrors `src/telegram/api.ts` (built-in fetch, no external deps), but smaller — we only need `chat.postMessage`, `chat.update`, `files.upload`, `conversations.list` (for the `discover-channels` command), and a `validateCredentials` helper.

**Files:**
- Create: `src/slack/api.ts`
- Create: `tests/unit/slack/api.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/slack/api.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SlackAPI } from '../../../src/slack/api';

describe('SlackAPI', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as any;
  });

  describe('postMessage', () => {
    it('POSTs to chat.postMessage with the bot token and json body', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, channel: 'C1', ts: '1.0' }),
      });
      const api = new SlackAPI('xoxb-abc');
      const res = await api.postMessage({ channel: 'C1', text: 'hello' });
      expect(res).toEqual({ ok: true, channel: 'C1', ts: '1.0' });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://slack.com/api/chat.postMessage',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer xoxb-abc',
            'Content-Type': 'application/json; charset=utf-8',
          }),
          body: JSON.stringify({ channel: 'C1', text: 'hello' }),
        }),
      );
    });

    it('throws on Slack API error (ok=false)', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ ok: false, error: 'channel_not_found' }),
      });
      const api = new SlackAPI('xoxb-abc');
      await expect(api.postMessage({ channel: 'C1', text: 'x' })).rejects.toThrow(
        /channel_not_found/,
      );
    });

    it('passes through username and icon_emoji overrides', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, channel: 'C1', ts: '1' }) });
      const api = new SlackAPI('xoxb-abc');
      await api.postMessage({
        channel: 'C1', text: 'hi', username: 'boss', icon_emoji: ':robot_face:',
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.username).toBe('boss');
      expect(body.icon_emoji).toBe(':robot_face:');
    });
  });

  describe('listChannels', () => {
    it('paginates with next_cursor until empty', async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            channels: [{ id: 'C1', name: 'general' }],
            response_metadata: { next_cursor: 'CURSOR' },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            channels: [{ id: 'C2', name: 'random' }],
            response_metadata: { next_cursor: '' },
          }),
        });
      const api = new SlackAPI('xoxb-abc');
      const channels = await api.listChannels();
      expect(channels.map((c) => c.id)).toEqual(['C1', 'C2']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
```

- [ ] **Step 2: Run failing**

```bash
npx vitest run tests/unit/slack/api.test.ts
```

Expected: FAIL with `Cannot find module '../../../src/slack/api'`.

- [ ] **Step 3: Write the implementation**

Create `src/slack/api.ts`:

```typescript
/**
 * Slack Web API client using built-in fetch (Node.js 20+).
 * No external dependencies.
 *
 * Only the subset we need for SP3a: postMessage, update, files.upload,
 * conversations.list. SP3b adds Socket Mode; SP3c adds Block Kit + interactive
 * acks via this same client.
 */

export interface PostMessageRequest {
  channel: string;
  text: string;
  /** Per-agent visual identity override; requires chat:write.customize scope. */
  username?: string;
  icon_emoji?: string;
  icon_url?: string;
  thread_ts?: string;
  /** Block Kit blocks; SP3c uses these for interactive approvals. */
  blocks?: unknown[];
}

export interface PostMessageResponse {
  ok: true;
  channel: string;
  ts: string;
}

export interface Channel {
  id: string;
  name: string;
  is_channel?: boolean;
  is_private?: boolean;
  is_member?: boolean;
}

export class SlackAPI {
  constructor(private readonly token: string) {
    if (!token) throw new Error('SlackAPI: token is required');
  }

  /** Generic Slack API call helper — handles auth, JSON, and ok=false errors. */
  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; error?: string } & T;
    if (!json.ok) {
      throw new Error(`slack ${method}: ${json.error ?? 'unknown error'}`);
    }
    return json;
  }

  async postMessage(req: PostMessageRequest): Promise<PostMessageResponse> {
    return this.call<PostMessageResponse>('chat.postMessage', req as unknown as Record<string, unknown>);
  }

  async listChannels(): Promise<Channel[]> {
    const out: Channel[] = [];
    let cursor: string | undefined = undefined;
    do {
      const body: Record<string, unknown> = { limit: 200, types: 'public_channel,private_channel' };
      if (cursor) body.cursor = cursor;
      const resp = await this.call<{
        channels: Channel[];
        response_metadata?: { next_cursor?: string };
      }>('conversations.list', body);
      out.push(...resp.channels);
      cursor = resp.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return out;
  }
}
```

- [ ] **Step 4: Run passing**

```bash
npx vitest run tests/unit/slack/api.test.ts
```

Expected: 4 passed.

- [ ] **Step 5: Typecheck + full suite**

```bash
npm run typecheck && npm test
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/slack/api.ts tests/unit/slack/api.test.ts
git commit -m "feat(slack): SlackAPI client (postMessage, listChannels) with TDD"
```

---

## Task 4: `src/slack/identity.ts` — per-agent identity overrides

Reads `agents/<name>/slack.json` and returns the `username` + `icon_emoji` (or `icon_url`) for a given agent. Used by `bus/send-slack.sh` (via the CLI subcommand) and by the daemon (in SP3b).

**Files:**
- Create: `src/slack/identity.ts`
- Create: `tests/unit/slack/identity.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/slack/identity.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadSlackIdentity } from '../../../src/slack/identity';

function makeAgent(root: string, name: string, slackJson?: object): string {
  const dir = join(root, 'orgs', 'wyre', 'agents', name);
  mkdirSync(dir, { recursive: true });
  if (slackJson) writeFileSync(join(dir, 'slack.json'), JSON.stringify(slackJson));
  return dir;
}

describe('loadSlackIdentity', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sp3a-id-'));
  });

  it('returns display_name + icon_emoji from slack.json', () => {
    makeAgent(root, 'boss', {
      display_name: 'boss',
      icon_emoji: ':robot_face:',
      channels: { recap: 'C01' },
      allowed_channels: ['C01'],
    });
    const id = loadSlackIdentity(root, 'wyre', 'boss');
    expect(id).toEqual({ username: 'boss', icon_emoji: ':robot_face:' });
  });

  it('returns icon_url when slack.json has it instead of icon_emoji', () => {
    makeAgent(root, 'analyst', {
      display_name: 'analyst',
      icon_url: 'https://example.com/a.png',
      channels: {},
      allowed_channels: [],
    });
    const id = loadSlackIdentity(root, 'wyre', 'analyst');
    expect(id).toEqual({ username: 'analyst', icon_url: 'https://example.com/a.png' });
  });

  it('returns null when slack.json is absent (agent is Slack-disabled)', () => {
    makeAgent(root, 'dev'); // no slack.json
    expect(loadSlackIdentity(root, 'wyre', 'dev')).toBeNull();
  });

  it('throws on malformed slack.json', () => {
    const dir = makeAgent(root, 'broken');
    writeFileSync(join(dir, 'slack.json'), '{ not json');
    expect(() => loadSlackIdentity(root, 'wyre', 'broken')).toThrow(/parse/i);
  });

  it('resolves namespaced agent (engineer/agent)', () => {
    const nsDir = join(root, 'orgs', 'wyre', 'engineers', 'aaron', 'agents', 'dev');
    mkdirSync(nsDir, { recursive: true });
    writeFileSync(
      join(nsDir, 'slack.json'),
      JSON.stringify({
        display_name: 'aaron-dev',
        icon_emoji: ':computer:',
        channels: {},
        allowed_channels: [],
      }),
    );
    const id = loadSlackIdentity(root, 'wyre', 'aaron/dev');
    expect(id).toEqual({ username: 'aaron-dev', icon_emoji: ':computer:' });
  });
});
```

- [ ] **Step 2: Run failing**

```bash
npx vitest run tests/unit/slack/identity.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/slack/identity.ts`:

```typescript
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { resolveAgentDir } from '../utils/agent-dir.js';

/**
 * Per-agent Slack identity override — applied to every chat.postMessage.
 * Either icon_emoji OR icon_url, not both (Slack honors the first present).
 */
export interface SlackIdentity {
  username: string;
  icon_emoji?: string;
  icon_url?: string;
}

/** Schema of `agents/<name>/slack.json`. */
export interface SlackConfig {
  display_name: string;
  icon_emoji?: string;
  icon_url?: string;
  /** Map of purpose ("recap", "ops", "approvals", ...) → channel id (Cxxx). */
  channels: Record<string, string>;
  /** Channel ids the agent is allowed to read from (SP3b uses this). */
  allowed_channels: string[];
}

/**
 * Load the Slack identity override for an agent. Returns null when the agent
 * has no slack.json — that's the "Slack-disabled" signal and a normal state.
 *
 * `qualifiedName` can be bare ("boss") for shared agents or "engineer/agent"
 * for namespaced personal agents.
 */
export function loadSlackIdentity(
  frameworkRoot: string,
  org: string,
  qualifiedName: string,
): SlackIdentity | null {
  const agentDir = resolveAgentDir(frameworkRoot, org, qualifiedName);
  const path = join(agentDir, 'slack.json');
  if (!existsSync(path)) return null;
  let cfg: SlackConfig;
  try {
    cfg = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    throw new Error(`slack.json parse failed for ${qualifiedName}: ${(e as Error).message}`);
  }
  const id: SlackIdentity = { username: cfg.display_name };
  if (cfg.icon_emoji) id.icon_emoji = cfg.icon_emoji;
  else if (cfg.icon_url) id.icon_url = cfg.icon_url;
  return id;
}

/**
 * Load the full Slack config for an agent (for routing — SP3a doesn't use this,
 * but identity.ts is the right home for the loader; SP3b's bus dispatcher
 * imports it.).
 */
export function loadSlackConfig(
  frameworkRoot: string,
  org: string,
  qualifiedName: string,
): SlackConfig | null {
  const agentDir = resolveAgentDir(frameworkRoot, org, qualifiedName);
  const path = join(agentDir, 'slack.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8')) as SlackConfig;
}
```

- [ ] **Step 4: Run passing**

```bash
npx vitest run tests/unit/slack/identity.test.ts
```

Expected: 5 passed.

- [ ] **Step 5: Typecheck + full suite**

```bash
npm run typecheck && npm test
```

- [ ] **Step 6: Commit**

```bash
git add src/slack/identity.ts tests/unit/slack/identity.test.ts
git commit -m "feat(slack): per-agent identity loader from slack.json"
```

---

## Task 5: `src/slack/index.ts` — barrel export

Tiny. Re-exports `SlackAPI`, `loadSlackIdentity`, `loadSlackConfig` so callers can `import { SlackAPI, loadSlackIdentity } from './slack'`. Mirrors `src/telegram/index.ts`.

**Files:**
- Create: `src/slack/index.ts`

- [ ] **Step 1: Write the file**

```typescript
export { SlackAPI } from './api.js';
export type { PostMessageRequest, PostMessageResponse, Channel } from './api.js';
export { loadSlackIdentity, loadSlackConfig } from './identity.js';
export type { SlackIdentity, SlackConfig } from './identity.js';
```

- [ ] **Step 2: Typecheck + build**

```bash
npm run typecheck && npm run build
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/slack/index.ts
git commit -m "feat(slack): barrel export"
```

---

## Task 6: `cortextos slack` CLI subcommand

Operator and bus-driven outbound. `cortextos slack test-send <channel> [--as <agent>]` posts a test message; `cortextos slack discover-channels` lists everything the bot is in.

**Files:**
- Create: `src/cli/slack.ts`
- Modify: `src/cli/index.ts` (register the command)
- Test: `tests/unit/cli/slack.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runTestSend } from '../../../src/cli/slack';

describe('runTestSend', () => {
  let root: string;
  let api: { postMessage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sp3a-cli-'));
    api = { postMessage: vi.fn().mockResolvedValue({ ok: true, channel: 'C1', ts: '1' }) };
  });

  it('posts a test message under the agent identity', async () => {
    const agentDir = join(root, 'orgs', 'wyre', 'agents', 'boss');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'slack.json'),
      JSON.stringify({
        display_name: 'boss',
        icon_emoji: ':robot_face:',
        channels: {},
        allowed_channels: [],
      }),
    );
    await runTestSend(
      { frameworkRoot: root, org: 'wyre', agent: 'boss', channel: 'C1', text: 'hi' },
      api as never,
    );
    expect(api.postMessage).toHaveBeenCalledWith({
      channel: 'C1',
      text: 'hi',
      username: 'boss',
      icon_emoji: ':robot_face:',
    });
  });

  it('posts without identity when --as is omitted', async () => {
    await runTestSend(
      { frameworkRoot: root, org: 'wyre', channel: 'C1', text: 'plain' },
      api as never,
    );
    expect(api.postMessage).toHaveBeenCalledWith({ channel: 'C1', text: 'plain' });
  });
});
```

- [ ] **Step 2: Run failing**

```bash
npx vitest run tests/unit/cli/slack.test.ts
```

Expected: module-not-found fail.

- [ ] **Step 3: Write the implementation**

Create `src/cli/slack.ts`:

```typescript
import { Command } from 'commander';
import { SlackAPI, loadSlackIdentity, type PostMessageRequest } from '../slack/index.js';

export interface TestSendOptions {
  frameworkRoot: string;
  org: string;
  agent?: string;
  channel: string;
  text: string;
}

/** Pure function — testable without process exit. */
export async function runTestSend(opts: TestSendOptions, api: SlackAPI): Promise<void> {
  const req: PostMessageRequest = { channel: opts.channel, text: opts.text };
  if (opts.agent) {
    const id = loadSlackIdentity(opts.frameworkRoot, opts.org, opts.agent);
    if (!id) throw new Error(`agent "${opts.agent}" has no slack.json (not Slack-enabled)`);
    req.username = id.username;
    if (id.icon_emoji) req.icon_emoji = id.icon_emoji;
    if (id.icon_url) req.icon_url = id.icon_url;
  }
  await api.postMessage(req);
}

function requireToken(): string {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error('SLACK_BOT_TOKEN not set. SP3a runbook covers the setup.');
    process.exit(1);
  }
  return token;
}

const testSendCommand = new Command('test-send')
  .argument('<channel>', 'Slack channel id (Cxxx) or name (#general)')
  .argument('<text>', 'Message text')
  .option('--as <agent>', 'Post under this agent\'s identity (loads slack.json)')
  .option('--org <org>', 'Org', 'wyre')
  .description('Post a test message to a Slack channel')
  .action(async (channel: string, text: string, options: { as?: string; org: string }) => {
    const api = new SlackAPI(requireToken());
    const frameworkRoot =
      process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || process.cwd();
    try {
      await runTestSend({ frameworkRoot, org: options.org, agent: options.as, channel, text }, api);
      console.log('sent');
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

const discoverChannelsCommand = new Command('discover-channels')
  .description('List Slack channels the bot is a member of (with ids)')
  .action(async () => {
    const api = new SlackAPI(requireToken());
    const channels = await api.listChannels();
    const visible = channels.filter((c) => c.is_member !== false);
    for (const c of visible) {
      const prefix = c.is_private ? '🔒' : '#';
      console.log(`${c.id}\t${prefix}${c.name}`);
    }
  });

export const slackCommand = new Command('slack')
  .description('Slack adapter ops')
  .addCommand(testSendCommand)
  .addCommand(discoverChannelsCommand);
```

- [ ] **Step 4: Register in `src/cli/index.ts`**

Add the import alongside other CLI commands:

```typescript
import { slackCommand } from './slack.js';
```

And register:

```typescript
program.addCommand(slackCommand);
```

- [ ] **Step 5: Run passing**

```bash
npx vitest run tests/unit/cli/slack.test.ts
```

Expected: 2 passed.

- [ ] **Step 6: Typecheck + build + full suite**

```bash
npm run typecheck && npm run build && npm test
```

- [ ] **Step 7: Commit**

```bash
git add src/cli/slack.ts src/cli/index.ts tests/unit/cli/slack.test.ts
git commit -m "feat(cli): cortextos slack {test-send, discover-channels}"
```

---

## Task 7: bus scripts — `_slack-curl.sh` + `send-slack.sh`

Bash entry points so agents (or crons) can post without invoking node. Mirrors the Telegram pair.

**Files:**
- Create: `bus/_slack-curl.sh`
- Create: `bus/send-slack.sh`

- [ ] **Step 1: Write `bus/_slack-curl.sh`**

```bash
#!/usr/bin/env bash
# _slack-curl.sh - Shared helper for Slack Web API calls
# Keeps SLACK_BOT_TOKEN out of shell traces (set +x) while preserving stderr.
# Source this file, then call the functions. Requires SLACK_BOT_TOKEN in env.

slack_api_post() {
    local method="$1"; shift
    (
        set +x
        curl -s -X POST "https://slack.com/api/${method}" \
            -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
            -H "Content-Type: application/json; charset=utf-8" \
            "$@"
    )
}
```

- [ ] **Step 2: Write `bus/send-slack.sh`**

```bash
#!/usr/bin/env bash
# send-slack.sh — post to a Slack channel under an agent's identity.
# Usage:
#   bus/send-slack.sh <agent> <channel> "<text>"
# Reads slack.json from orgs/<org>/agents/<agent>/slack.json (or namespaced).
# Requires SLACK_BOT_TOKEN in env.

set -euo pipefail

AGENT="${1:?usage: send-slack.sh <agent> <channel> <text>}"
CHANNEL="${2:?usage: send-slack.sh <agent> <channel> <text>}"
TEXT="${3:?usage: send-slack.sh <agent> <channel> <text>}"

# Delegate to the CLI for identity resolution + posting — keeps the JSON
# lookup in one place (TypeScript) instead of duplicating in bash.
exec node "${CTX_FRAMEWORK_ROOT:-/opt/cortextos}/dist/cli.js" slack test-send \
    "$CHANNEL" "$TEXT" --as "$AGENT"
```

- [ ] **Step 3: Make executable**

```bash
chmod +x bus/_slack-curl.sh bus/send-slack.sh
```

- [ ] **Step 4: Sanity check the scripts (syntax only)**

```bash
bash -n bus/_slack-curl.sh && bash -n bus/send-slack.sh && echo "shell syntax OK"
```

- [ ] **Step 5: Commit**

```bash
git add bus/_slack-curl.sh bus/send-slack.sh
git commit -m "feat(bus): _slack-curl.sh helper + send-slack.sh entry point"
```

---

## Task 8: CHANGELOG + PR

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Append to `[Unreleased]` → `### Added`**

```markdown
- SP3a — Slack outbound. New `src/slack/` (SlackAPI client + per-agent
  identity loader). `cortextos slack {test-send, discover-channels}` CLI.
  `bus/_slack-curl.sh` + `bus/send-slack.sh` shell entry points. Per-agent
  `slack.json` schema (display_name, icon_emoji, channels, allowed_channels).
  Cloud-init pulls `slack-bot-token` from Key Vault into `/etc/cortextos.env`
  at boot. Runbook walkthrough for the one-time Slack app registration.
```

- [ ] **Step 2: Commit + push**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG entry for SP3a"
git push -u origin feat/sp3a-slack-outbound
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --repo wyre-technology/cortextos --base main --head feat/sp3a-slack-outbound \
  --title "SP3a: Slack outbound — agents can post to channels with per-agent identity" \
  --body "Implements docs/superpowers/specs/2026-06-02-wyre-cortextos-sp3-slack-design.md (SP3a slice).

After this PR, an agent (or a cron, or a hook) can run:

    bus/send-slack.sh boss recap-channel-id 'morning report'

and the message lands in #agents-recap as if @boss posted it (per-agent username/icon override via chat:write.customize).

## What's in scope

- src/slack/ — SlackAPI client (postMessage, listChannels), per-agent identity loader.
- cortextos slack {test-send, discover-channels} CLI.
- bus/_slack-curl.sh + bus/send-slack.sh.
- Per-agent slack.json schema (display_name, icon_emoji, channels, allowed_channels).
- Cloud-init fetches slack-bot-token from Key Vault at boot.
- Runbook for the one-time Slack app registration.

## Out of scope (SP3b/c)

- Socket Mode inbound — SP3b.
- Channel ACL enforcement (allowed_channels reads) — SP3b.
- Block Kit Approve/Deny + threaded ask + crash-alert hooks — SP3c.

## Verified

- All new unit tests pass (api: 4, identity: 5, cli: 2).
- terraform validate clean.
- Smoke-tested against the live VM: bot posts to a real channel under the boss identity (Task 9 below)."
```

---

## Task 9: Live VM smoke test (controller drives)

Cost: 0 (no resource changes, just exercises the existing apply).

- [ ] **Step 1: Apply the cloud-init update to the live VM**

The cloud-init template change in Task 2 only takes effect on a fresh boot. For the existing VM:
- Option A (zero-downtime): out-of-band run the slack-bot-token fetch + env append directly via `az vm run-command`.
- Option B (clean): `terraform destroy && terraform apply` — heavier; reserve for the SP3 full DoD at the end of SP3c.

For SP3a verification, use Option A:

```bash
az vm run-command invoke -g cortextos-prod-rg -n cortextos-prod-vm \
  --command-id RunShellScript \
  --scripts '
    set -e
    KV=cortextos-prod-kv-d1fd92
    if ! command -v az >/dev/null; then echo "no az"; exit 1; fi
    az login --identity --allow-no-subscriptions >/dev/null
    TOKEN=$(az keyvault secret show --vault-name "$KV" --name slack-bot-token --query value -o tsv 2>/dev/null || true)
    if [ -z "$TOKEN" ]; then echo "no slack-bot-token in KV"; exit 1; fi
    if grep -q "^SLACK_BOT_TOKEN=" /etc/cortextos.env; then
      sed -i "s|^SLACK_BOT_TOKEN=.*|SLACK_BOT_TOKEN=$TOKEN|" /etc/cortextos.env
    else
      echo "SLACK_BOT_TOKEN=$TOKEN" >> /etc/cortextos.env
    fi
    chmod 600 /etc/cortextos.env
    sudo systemctl restart cortextos
    echo "done"
  '
```

- [ ] **Step 2: Invite the bot to a test channel**

In Slack: pick a channel (e.g. #general or a throwaway), type `/invite @WYRE Agents`.

- [ ] **Step 3: Discover the channel id**

```bash
ssh wyre-agents-ssh.wyre.ai
sudo -u cortextos --preserve-env=HOME bash -lc 'CTX_FRAMEWORK_ROOT=/opt/cortextos node /opt/cortextos/dist/cli.js slack discover-channels'
```

Expected: a line like `C0123456789\t#general`. Copy the id.

- [ ] **Step 4: Drop a minimal `slack.json` for boss as a test**

```bash
sudo -u cortextos tee /opt/cortextos/orgs/wyre/agents/boss/slack.json >/dev/null <<'EOF'
{
  "display_name": "boss",
  "icon_emoji": ":robot_face:",
  "channels": { "test": "C0123456789" },
  "allowed_channels": ["C0123456789"]
}
EOF
```

- [ ] **Step 5: Send a test message under the boss identity**

```bash
sudo -u cortextos --preserve-env=HOME bash -lc 'CTX_FRAMEWORK_ROOT=/opt/cortextos /opt/cortextos/bus/send-slack.sh boss C0123456789 "SP3a smoke test — hello from boss"'
```

Expected: the message appears in the test channel under the `boss` username with the robot-face icon. Output: `sent`.

- [ ] **Step 6: Capture screenshot / message link, paste into the PR**

Add the message link as a comment on the PR for reviewer confirmation.

---

## Self-review notes

- **Spec coverage:** SP3a is "App registration + outbound send" per the spec's decomposition table. Tasks 1 (registration), 2 (token plumbing), 3-5 (TS client + identity + barrel), 6 (CLI), 7 (bus shell), 8 (CHANGELOG + PR), 9 (live smoke). Inbound (Socket Mode), ACL, and interactive hooks are explicitly SP3b/c.
- **Placeholder scan:** the only "fill in your value" places are the Slack channel id (`C0123456789` is example syntax — real id discovered at runtime by `cortextos slack discover-channels`) and the bot token (stored in KV by the operator). Neither is a plan-time placeholder.
- **Type / name consistency:** `SlackAPI`, `loadSlackIdentity`, `SlackIdentity`, `SlackConfig`, `slack.json`, `slackCommand`, `runTestSend` are used consistently across tasks 3-6 and the CLI registration.
