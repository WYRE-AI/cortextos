import { readdirSync, readFileSync, renameSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { createHmac, timingSafeEqual } from 'crypto';
import type { InboxMessage, Priority, BusPaths } from '../types/index.js';
import { PRIORITY_MAP } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { acquireLock, releaseLock } from '../utils/lock.js';
import { randomString } from '../utils/random.js';
import { validateAgentName, validatePriority } from '../utils/validate.js';

// ---------------------------------------------------------------------------
// Security (H10): HMAC-SHA256 message signing
// ---------------------------------------------------------------------------

/**
 * Load the shared bus signing key from config.
 * Returns null if the key file doesn't exist (legacy installs without signing).
 */
function loadSigningKey(ctxRoot: string): string | null {
  const keyPath = join(ctxRoot, 'config', 'bus-signing-key');
  if (!existsSync(keyPath)) return null;
  try {
    return readFileSync(keyPath, 'utf-8').trim();
  } catch {
    return null;
  }
}

function hmacSign(key: string, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('hex');
}

function hmacVerify(key: string, payload: string, sig: string): boolean {
  const expected = hmacSign(key, payload);
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
  } catch {
    return false;
  }
}

function signPayload(msgId: string, from: string, to: string, text: string): string {
  return `${msgId}:${from}:${to}:${text}`;
}

/**
 * Send a message to another agent's inbox.
 * Creates a JSON file with format: {pnum}-{epochMs}-from-{sender}-{rand5}.json
 * Identical to bash send-message.sh output.
 *
 * @param fanout Internal — set by `sendToCapability` (src/bus/agents.ts) to
 *   tag this message as one copy of a capability-tagged fan-out. Do not set
 *   this from a normal single-recipient send; see InboxMessage.fanout.
 */
export function sendMessage(
  paths: BusPaths,
  from: string,
  to: string,
  priority: Priority,
  text: string,
  replyTo?: string,
  fanout?: { id: string; capability: string; recipients: string[] },
): string {
  validateAgentName(from);
  validateAgentName(to);
  validatePriority(priority);

  const pnum = PRIORITY_MAP[priority];
  const epochMs = Date.now();
  const rand = randomString(5);
  const msgId = `${epochMs}-${from}-${rand}`;
  const filename = `${pnum}-${epochMs}-from-${from}-${rand}.json`;

  // Security (H10): Sign message with HMAC-SHA256.
  const signingKey = loadSigningKey(paths.ctxRoot);
  const message: InboxMessage = {
    id: msgId,
    from,
    to,
    priority,
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
    text,
    reply_to: replyTo || null,
    ...(signingKey ? { sig: hmacSign(signingKey, signPayload(msgId, from, to, text)) } : {}),
    ...(fanout ? { fanout } : {}),
  };

  // Write to target agent's inbox
  const inboxDir = join(paths.ctxRoot, 'inbox', to);
  ensureDir(inboxDir);
  atomicWriteSync(join(inboxDir, filename), JSON.stringify(message));

  return msgId;
}

/**
 * Check inbox for pending messages.
 * Reads inbox directory, moves messages to inflight, returns sorted array.
 * Recovers stale inflight messages (>5 minutes old).
 * Identical to bash check-inbox.sh behavior.
 */
// Rate-limit state for lock-contention warnings (once per inbox per minute).
// A held lock is normal for microseconds; one that fails for a whole minute
// of 1s polls means the inbox is wedged (2026-07-01: 8 inboxes silently
// deadlocked for days behind orphaned .lock.d dirs with zero log evidence).
const lockWarnLastAt = new Map<string, number>();
const LOCK_WARN_INTERVAL_MS = 60_000;

/**
 * Result of {@link checkInboxWithStatus}.
 *
 * `skipped` separates two cases that a bare `[]` merges:
 *
 *   - `skipped: false` — the inbox was read. An empty `messages` means there
 *     is genuinely nothing pending.
 *
 *   - `skipped: true` — the lock could not be acquired, so the inbox was never
 *     opened. `messages: []` is the absence of a look, not an absence of mail.
 *
 * The distinction is easy to under-rate because delivery self-heals: the next
 * poll retries and stale inflight recovers after 5 minutes, so a skipped poll
 * costs only latency. It matters anyway because `bus check-inbox` prints this
 * to stdout, and an agent reading `[]` writes "inbox empty, nothing owed to
 * anyone" into its own session state — a durable claim derived from a value
 * that cannot support it. The warning at the skip site is rate-limited to once
 * per inbox per minute, so under a 1s poll 59 of every 60 skips are silent in
 * BOTH channels.
 */
export interface InboxCheck {
  messages: InboxMessage[];
  skipped: boolean;
}

export function checkInboxWithStatus(paths: BusPaths): InboxCheck {
  const { inbox, inflight } = paths;
  ensureDir(inbox);
  ensureDir(inflight);

  // Acquire lock
  if (!acquireLock(inbox)) {
    const now = Date.now();
    const last = lockWarnLastAt.get(inbox) ?? 0;
    if (now - last >= LOCK_WARN_INTERVAL_MS) {
      lockWarnLastAt.set(inbox, now);
      console.warn(`[bus/message] WARNING: could not acquire inbox lock at ${inbox} — delivery skipped this poll (stale .lock.d?)`);
    }
    return { messages: [], skipped: true };
  }
  lockWarnLastAt.delete(inbox);

  try {
    // Recover stale inflight messages (>5 min old)
    recoverStaleInflight(inflight, inbox, 300);

    // Read and sort messages by filename (priority then timestamp)
    const files = readdirSync(inbox)
      .filter(f => f.endsWith('.json') && !f.startsWith('.'))
      .sort();

    if (files.length === 0) {
      return { messages: [], skipped: false }; // looked, genuinely nothing there
    }

    // Security (H10): Load signing key for HMAC verification.
    const signingKey = loadSigningKey(paths.ctxRoot);

    const messages: InboxMessage[] = [];
    for (const file of files) {
      const srcPath = join(inbox, file);
      try {
        const content = readFileSync(srcPath, 'utf-8');
        const msg: InboxMessage = JSON.parse(content);

        // Security (H10): Verify HMAC signature if key is available and message has sig.
        if (signingKey && msg.sig) {
          const valid = hmacVerify(signingKey, signPayload(msg.id, msg.from, msg.to, msg.text), msg.sig);
          if (!valid) {
            console.error(`[bus/message] SECURITY: Message ${msg.id} from '${msg.from}' failed HMAC verification — rejecting`);
            const errDir = join(inbox, '.errors');
            ensureDir(errDir);
            try { renameSync(srcPath, join(errDir, file)); } catch { /* ignore */ }
            continue;
          }
        } else if (signingKey && !msg.sig) {
          // Signing key exists but message has no sig — legacy message, log warning
          console.warn(`[bus/message] WARNING: Unsigned message ${msg.id} from '${msg.from}' — accepted (legacy)`);
        }

        // Move to inflight
        const destPath = join(inflight, file);
        renameSync(srcPath, destPath);
        messages.push(msg);
      } catch {
        // Move corrupt files to .errors/
        const errDir = join(inbox, '.errors');
        ensureDir(errDir);
        try {
          renameSync(srcPath, join(errDir, file));
        } catch {
          // Ignore if move fails
        }
      }
    }

    // NOTE: `messages` can still be empty here if every file was quarantined
    // to .errors/ (HMAC failure or corrupt JSON). That is a THIRD empty case —
    // "looked, found mail, rejected all of it" — but unlike a skipped poll it
    // is already loud: each rejection logs at error/warn level unconditionally,
    // with no rate limit. Left out of `skipped` deliberately so the flag keeps
    // one meaning: the inbox was never opened.
    return { messages, skipped: false };
  } finally {
    releaseLock(inbox);
  }
}

/**
 * Back-compat wrapper over {@link checkInboxWithStatus}.
 *
 * @returns only the message array, DISCARDING whether the inbox was actually
 *          read. `[]` means "nothing pending" OR "could not look". Use
 *          {@link checkInboxWithStatus} anywhere that emptiness is reported to
 *          a human, recorded as state, or read as "nothing owed".
 */
export function checkInbox(paths: BusPaths): InboxMessage[] {
  return checkInboxWithStatus(paths).messages;
}

/**
 * Acknowledge a message by moving it from inflight to processed.
 * Identical to bash ack-inbox.sh behavior.
 *
 * First-ack-wins: if the acked message is one copy of a capability-tagged
 * fan-out (InboxMessage.fanout — see `sendToCapability` in bus/agents.ts),
 * this also cancels the sibling copies still sitting in the OTHER tagged
 * recipients' inbox/inflight, so only the first agent to ack processes it.
 * Cleanup is best-effort: a failure there never undoes the ack that already
 * succeeded.
 */
export function ackInbox(paths: BusPaths, messageId: string): void {
  const { inflight, processed } = paths;
  ensureDir(processed);

  // Find the file in inflight that contains this message ID
  let files: string[];
  try {
    files = readdirSync(inflight).filter(f => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const filePath = join(inflight, file);
    try {
      const content = readFileSync(filePath, 'utf-8');
      const msg = JSON.parse(content);
      if (msg.id === messageId) {
        renameSync(filePath, join(processed, file));
        if (msg.fanout?.id && Array.isArray(msg.fanout.recipients)) {
          try {
            cancelFanoutSiblings(paths.ctxRoot, msg.fanout.id, msg.fanout.recipients, msg.to);
          } catch {
            // Best-effort — the ack itself already succeeded.
          }
        }
        return;
      }
    } catch {
      // Skip corrupt files
    }
  }
}

/**
 * First-ack-wins cleanup for a capability-tagged fan-out (Gap 4 /
 * "angela-relay SPOF" fix — task_1788300871646_92090539). Called from
 * `ackInbox` once the winning copy has been acked: for every OTHER tagged
 * recipient, finds their still-pending copy of the SAME fan-out (matched by
 * `fanout.id`) in either `inbox/` (never checked) or `inflight/` (checked
 * but not yet acked) and moves it to a `.superseded/` quarantine dir —
 * mirroring the `.errors/` pattern `checkInboxWithStatus` already uses for
 * rejected messages. `.superseded/` is invisible to both `checkInboxWithStatus`
 * (only reads plain `*.json` directly under `inbox/`) and a later `ackInbox`
 * scan of `inflight/`, so a backup relay that hasn't gotten to the message
 * yet simply never sees it once someone else has already handled it — kept
 * on disk rather than deleted, for audit.
 */
function cancelFanoutSiblings(
  ctxRoot: string,
  fanoutId: string,
  recipients: string[],
  winner: string,
): void {
  for (const recipient of recipients) {
    if (recipient === winner) continue;
    for (const dirName of ['inbox', 'inflight'] as const) {
      const dir = join(ctxRoot, dirName, recipient);
      let siblingFiles: string[];
      try {
        siblingFiles = readdirSync(dir).filter(f => f.endsWith('.json'));
      } catch {
        continue;
      }
      for (const file of siblingFiles) {
        const filePath = join(dir, file);
        try {
          const sibling = JSON.parse(readFileSync(filePath, 'utf-8'));
          if (sibling?.fanout?.id === fanoutId) {
            const supersededDir = join(dir, '.superseded');
            ensureDir(supersededDir);
            renameSync(filePath, join(supersededDir, file));
          }
        } catch {
          // Corrupt/unreadable sibling file — leave it for its own recipient
          // to sort out; never let cleanup throw.
        }
      }
    }
  }
}

/**
 * Recover stale inflight messages (older than thresholdSeconds) back to inbox.
 */
function recoverStaleInflight(
  inflightDir: string,
  inboxDir: string,
  thresholdSeconds: number,
): void {
  const now = Math.floor(Date.now() / 1000);
  let files: string[];
  try {
    files = readdirSync(inflightDir).filter(f => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const filePath = join(inflightDir, file);
    try {
      const stat = statSync(filePath);
      const mtime = Math.floor(stat.mtimeMs / 1000);
      if (now - mtime > thresholdSeconds) {
        renameSync(filePath, join(inboxDir, file));
      }
    } catch {
      // Ignore stat/move errors
    }
  }
}
