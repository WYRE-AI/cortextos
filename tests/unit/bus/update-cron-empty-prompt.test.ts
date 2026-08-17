/**
 * tests/unit/bus/update-cron-empty-prompt.test.ts
 *
 * `bus update-cron --prompt ""` wiped a cron's prompt and printed
 * "Updated cron 'x' for y". The resulting cron still loads, still reports
 * `enabled` in list-crons, and still fires on schedule — it just injects
 * nothing. Every surface an operator checks looks healthy.
 *
 * The validation already existed and was on the wrong side of a two-path API:
 * handleUpdateCron (src/daemon/ipc-server.ts) has always rejected an empty
 * prompt; the CLI passed it straight through. These tests pin the guard at the
 * choke point (updateCron) so both paths are covered and a third cannot miss it.
 *
 * The load-bearing assertion is not that it throws — it is that the STORED
 * prompt survives a rejected update. A test that only asserts the throw would
 * pass against an implementation that threw after writing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let tmpRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'update-cron-prompt-test-'));
  process.env.CTX_ROOT = tmpRoot;
  vi.resetModules();
});

afterEach(() => {
  if (originalCtxRoot !== undefined) {
    process.env.CTX_ROOT = originalCtxRoot;
  } else {
    delete process.env.CTX_ROOT;
  }
  try { rmSync(tmpRoot, { recursive: true }); } catch { /* ignore */ }
});

async function importCrons() {
  return import('../../../src/bus/crons.js');
}

const AGENT = 'testagent';
const GOOD_PROMPT = 'Read HEARTBEAT.md and follow its instructions.';

async function seed() {
  const { addCron } = await importCrons();
  addCron(AGENT, {
    name: 'heartbeat',
    schedule: '4h',
    prompt: GOOD_PROMPT,
    enabled: true,
  });
}

describe('updateCron rejects an empty prompt at the choke point', () => {
  it('throws on an empty-string prompt', async () => {
    await seed();
    const { updateCron } = await importCrons();
    expect(() => updateCron(AGENT, 'heartbeat', { prompt: '' })).toThrow(/non-empty/i);
  });

  it('throws on a whitespace-only prompt', async () => {
    await seed();
    const { updateCron } = await importCrons();
    expect(() => updateCron(AGENT, 'heartbeat', { prompt: '   \n\t ' })).toThrow(/non-empty/i);
  });

  // The one that matters: the old prompt must still be on disk afterwards.
  it('leaves the stored prompt intact after a rejected update', async () => {
    await seed();
    const { updateCron, getCronByName } = await importCrons();

    expect(() => updateCron(AGENT, 'heartbeat', { prompt: '' })).toThrow();

    const after = getCronByName(AGENT, 'heartbeat');
    expect(after?.prompt).toBe(GOOD_PROMPT);
  });

  it('rejects the empty prompt even when the patch also carries valid fields', async () => {
    await seed();
    const { updateCron, getCronByName } = await importCrons();

    // A partially-applied patch would be worse than an outright failure.
    expect(() =>
      updateCron(AGENT, 'heartbeat', { prompt: '', schedule: '30m', enabled: false }),
    ).toThrow(/non-empty/i);

    const after = getCronByName(AGENT, 'heartbeat');
    expect(after?.prompt).toBe(GOOD_PROMPT);
    expect(after?.schedule).toBe('4h');
    expect(after?.enabled).toBe(true);
  });

  // Positive controls — the guard must not have made updateCron unusable.
  it('still accepts a non-empty prompt', async () => {
    await seed();
    const { updateCron, getCronByName } = await importCrons();

    expect(updateCron(AGENT, 'heartbeat', { prompt: 'new prompt text' })).toBe(true);
    expect(getCronByName(AGENT, 'heartbeat')?.prompt).toBe('new prompt text');
  });

  // cron-scheduler.ts patches last_fire_attempted_at and never touches prompt.
  // If the guard fired on an absent prompt it would break every cron fire.
  it('does not fire when the patch omits prompt entirely', async () => {
    await seed();
    const { updateCron, getCronByName } = await importCrons();

    const iso = '2026-08-16T16:00:00Z';
    expect(updateCron(AGENT, 'heartbeat', { last_fire_attempted_at: iso })).toBe(true);

    const after = getCronByName(AGENT, 'heartbeat');
    expect(after?.last_fire_attempted_at).toBe(iso);
    expect(after?.prompt).toBe(GOOD_PROMPT);
  });

  it('still returns false for a cron that does not exist', async () => {
    await seed();
    const { updateCron } = await importCrons();
    expect(updateCron(AGENT, 'no-such-cron', { prompt: 'valid' })).toBe(false);
  });
});
