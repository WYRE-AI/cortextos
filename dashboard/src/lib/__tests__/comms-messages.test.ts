import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { readMessagesNewestFirst } from '../comms-messages';

let ctxRoot: string;

/**
 * Write a bus message using the real on-disk naming convention:
 *   <priority>-<epoch-ms>-from-<agent>-<nonce>.json
 */
function writeMsg(
  rel: string,
  epoch: number,
  msg: Partial<{ id: string; from: string; to: string; text: string; timestamp: string }>,
) {
  const dir = join(ctxRoot, rel);
  mkdirSync(dir, { recursive: true });
  const id = msg.id ?? `id-${epoch}`;
  writeFileSync(
    join(dir, `2-${epoch}-from-${msg.from ?? 'alice'}-${id}.json`),
    JSON.stringify({
      id,
      from: msg.from ?? 'alice',
      to: msg.to ?? 'bob',
      priority: 'normal',
      timestamp: msg.timestamp ?? new Date(epoch).toISOString(),
      text: msg.text ?? 'hello',
      reply_to: null,
    }),
  );
}

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'comms-msgs-'));
});
afterEach(() => {
  rmSync(ctxRoot, { recursive: true, force: true });
});

describe('readMessagesNewestFirst', () => {
  it('returns messages newest-first across inbox, inflight and processed', () => {
    writeMsg('processed/alice', 1700000000000, { id: 'oldest' });
    writeMsg('inbox/alice', 1700000002000, { id: 'newest' });
    writeMsg('inbox/alice/inflight', 1700000001000, { id: 'middle' });

    const got = readMessagesNewestFirst(ctxRoot, 10, () => true);
    expect(got.map((m) => m.id)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('stops reading once `want` messages are collected', () => {
    for (let i = 0; i < 50; i++) {
      writeMsg('processed/alice', 1700000000000 + i * 1000, { id: `m${i}` });
    }
    const got = readMessagesNewestFirst(ctxRoot, 5, () => true);
    // The newest five, not an arbitrary five — this is what makes the early
    // stop equivalent to "read everything, sort desc, slice".
    expect(got.map((m) => m.id)).toEqual(['m49', 'm48', 'm47', 'm46', 'm45']);
  });

  it('applies the accept predicate before counting toward `want`', () => {
    writeMsg('processed/alice', 1700000003000, { id: 'keep-2', from: 'alice' });
    writeMsg('processed/alice', 1700000002000, { id: 'drop-1', from: 'zed' });
    writeMsg('processed/alice', 1700000001000, { id: 'keep-1', from: 'alice' });

    const got = readMessagesNewestFirst(ctxRoot, 2, (m) => m.from === 'alice');
    expect(got.map((m) => m.id)).toEqual(['keep-2', 'keep-1']);
  });

  it('deduplicates by message id across directories', () => {
    // The same message can exist in inbox and processed mid-ACK.
    writeMsg('inbox/alice', 1700000001000, { id: 'dupe' });
    writeMsg('processed/alice', 1700000000000, { id: 'dupe' });

    const got = readMessagesNewestFirst(ctxRoot, 10, () => true);
    expect(got).toHaveLength(1);
    expect(got[0].id).toBe('dupe');
  });

  it('skips corrupt and incomplete files without aborting the scan', () => {
    writeMsg('processed/alice', 1700000002000, { id: 'good' });
    mkdirSync(join(ctxRoot, 'processed/alice'), { recursive: true });
    writeFileSync(join(ctxRoot, 'processed/alice/2-1700000001500-from-alice-bad.json'), '{not json');
    writeFileSync(
      join(ctxRoot, 'processed/alice/2-1700000001400-from-alice-partial.json'),
      JSON.stringify({ id: 'partial', from: 'alice' }), // missing to/timestamp
    );

    const got = readMessagesNewestFirst(ctxRoot, 10, () => true);
    expect(got.map((m) => m.id)).toEqual(['good']);
  });

  it('still returns messages whose filename has no parseable epoch', () => {
    writeMsg('processed/alice', 1700000000000, { id: 'normal' });
    mkdirSync(join(ctxRoot, 'processed/alice'), { recursive: true });
    writeFileSync(
      join(ctxRoot, 'processed/alice/legacy-name.json'),
      JSON.stringify({
        id: 'legacy',
        from: 'alice',
        to: 'bob',
        priority: 'normal',
        timestamp: '2023-11-14T22:13:20.000Z',
        text: 'hi',
        reply_to: null,
      }),
    );

    const got = readMessagesNewestFirst(ctxRoot, 10, () => true);
    // Unparseable names sort last (epoch 0) but must not be dropped.
    expect(got.map((m) => m.id)).toEqual(['normal', 'legacy']);
  });

  it('returns an empty list when no message directories exist', () => {
    expect(readMessagesNewestFirst(ctxRoot, 10, () => true)).toEqual([]);
  });
});
