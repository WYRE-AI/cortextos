/**
 * tests/unit/bus/cron-phase-across-remove-add.test.ts
 *
 * END-TO-END phase preservation across remove-then-add, driven through the
 * REAL addCron / removeCron / readCrons path against a temporary CTX_ROOT.
 *
 * WHY THIS FILE EXISTS AND WHY IT IS NOT IN cron-scheduler.test.ts:
 * an earlier version of this fix was "verified" by calling computeReferenceMs
 * with a hand-built `{ createdAt: <fresh>, stateFire: <old> }` pair. That test
 * was green and mutation-sensitive and proved nothing, because the real system
 * does not produce that pair — removeCron deleted the crons.json entry (taking
 * last_fired_at with it) and nothing wrote cron-state.json, so the live code
 * path had NO fire record at all and fell through to the fresh created_at.
 *
 * Mutation testing verifies a contract's sensitivity; it cannot ask whether the
 * contract is ever reached. So this test never constructs an input: it performs
 * the actual sequence an operator performs when editing a cron's prompt, then
 * reads back exactly what the scheduler reads (cron-scheduler.ts:477,516-520)
 * and asserts the phase off that.
 *
 * cron-scheduler.test.ts mocks src/bus/crons.js wholesale, which is precisely
 * what this test must not do.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { addCron, removeCron, readCrons, updateCron } from '../../../src/bus/crons';
import { readCronState } from '../../../src/bus/cron-state';
import { computeReferenceMs, nextFireFromCron } from '../../../src/daemon/cron-scheduler';
import type { CronDefinition } from '../../../src/types/index';

const AGENT = 'phase-test-agent';

// boss's check-approvals, 2026-08-15: a 2h cron that had fired at 16:14Z, whose
// prompt was edited at 17:20Z. Correct next fire is 18:14Z. The incident moved
// it to 19:20Z, straddling and losing a window it had been covering.
const LAST_FIRE = '2026-08-15T16:14:00.000Z';
const EDIT_TIME = '2026-08-15T17:20:00.000Z';
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

let ctxRoot: string;
let originalCtxRoot: string | undefined;

/** Exactly what the scheduler reads to anchor a cron (cron-scheduler.ts:477,516-520). */
function schedulerReferenceFor(def: CronDefinition): number {
  const stateFile = readCronState(join(ctxRoot, 'state', AGENT));
  const stateFire = stateFile.crons.find((r) => r.name === def.name)?.last_fire;
  return computeReferenceMs(
    {
      createdAt: def.created_at,
      lastFiredAt: def.last_fired_at,
      lastFireAttemptedAt: def.last_fire_attempted_at,
      stateFire,
    },
    Date.parse(EDIT_TIME),
  );
}

beforeEach(() => {
  originalCtxRoot = process.env.CTX_ROOT;
  ctxRoot = mkdtempSync(join(tmpdir(), 'cron-phase-'));
  process.env.CTX_ROOT = ctxRoot;
});

afterEach(() => {
  if (originalCtxRoot === undefined) delete process.env.CTX_ROOT;
  else process.env.CTX_ROOT = originalCtxRoot;
  rmSync(ctxRoot, { recursive: true, force: true });
});

describe('cron phase survives a prompt edit (real remove-then-add path)', () => {
  /** Add a cron and give it a fire history, the way a live cron acquires one. */
  function addAndFire(schedule: string): void {
    addCron(AGENT, {
      name: 'check-approvals',
      prompt: 'original prompt',
      schedule,
      enabled: true,
      created_at: '2026-08-15T10:00:00.000Z',
    });
    updateCron(AGENT, 'check-approvals', {
      last_fired_at: LAST_FIRE,
      last_fire_attempted_at: LAST_FIRE,
    });
  }

  /** What the CLI actually does to change a prompt: add-cron refuses to overwrite. */
  function editPromptViaRemoveThenAdd(schedule: string): void {
    expect(removeCron(AGENT, 'check-approvals')).toBe(true);
    addCron(AGENT, {
      name: 'check-approvals',
      prompt: 'edited prompt — one extra rule',
      schedule,
      enabled: true,
      created_at: EDIT_TIME, // handleAddCron stamps a fresh one on EVERY add
    });
  }

  it('PRECONDITION: remove-then-add really does destroy the crons.json fire fields', () => {
    addAndFire('2h');
    editPromptViaRemoveThenAdd('2h');

    const def = readCrons(AGENT).find((c) => c.name === 'check-approvals')!;
    expect(def.prompt).toBe('edited prompt — one extra rule');
    // If this ever goes green-by-accident the rest of the file proves nothing.
    expect(def.last_fired_at).toBeUndefined();
    expect(def.last_fire_attempted_at).toBeUndefined();
    expect(def.created_at).toBe(EDIT_TIME);
  });

  it('leaves the fire behind as a tombstone in cron-state.json', () => {
    addAndFire('2h');
    expect(readCronState(join(ctxRoot, 'state', AGENT)).crons).toHaveLength(0);

    editPromptViaRemoveThenAdd('2h');

    const records = readCronState(join(ctxRoot, 'state', AGENT)).crons;
    expect(records).toHaveLength(1);
    expect(records[0].name).toBe('check-approvals');
    // The ORIGINAL fire time, not "now" — stamping now would re-phase just as
    // badly while looking like it worked.
    expect(records[0].last_fire).toBe(LAST_FIRE);
  });

  // THE INCIDENT. Red before the fix (reference = fresh created_at = 17:20Z,
  // next fire 19:20Z — the exact wrong value from 2026-08-15).
  it('a 2h interval cron keeps its :14 phase across a prompt edit', () => {
    addAndFire('2h');
    editPromptViaRemoveThenAdd('2h');

    const def = readCrons(AGENT).find((c) => c.name === 'check-approvals')!;
    const reference = schedulerReferenceFor(def);

    expect(new Date(reference).toISOString()).toBe(LAST_FIRE);
    expect(new Date(reference + TWO_HOURS_MS).toISOString()).toBe('2026-08-15T18:14:00.000Z');
  });

  it('a cron that never fired has no tombstone and still anchors on created_at', () => {
    addCron(AGENT, {
      name: 'never-fired',
      prompt: 'p',
      schedule: '2h',
      enabled: true,
      created_at: '2026-08-15T10:00:00.000Z',
    });
    expect(removeCron(AGENT, 'never-fired')).toBe(true);

    expect(readCronState(join(ctxRoot, 'state', AGENT)).crons).toHaveLength(0);

    addCron(AGENT, {
      name: 'never-fired',
      prompt: 'p2',
      schedule: '2h',
      enabled: true,
      created_at: EDIT_TIME,
    });
    const def = readCrons(AGENT).find((c) => c.name === 'never-fired')!;
    // No fire history anywhere, so created_at is the anchor — the 10e3011f
    // never-fired behaviour, unchanged.
    expect(new Date(schedulerReferenceFor(def)).toISOString()).toBe(EDIT_TIME);
  });

  it('removing a cron that does not exist writes no tombstone and returns false', () => {
    expect(removeCron(AGENT, 'no-such-cron')).toBe(false);
    expect(readCronState(join(ctxRoot, 'state', AGENT)).crons).toHaveLength(0);
  });

  it('a cron EXPRESSION was never exposed to this — same fire from either anchor', () => {
    // Asserting the reference here would just re-assert the tombstone. The
    // claim being tested is different and stronger: an expression's phase does
    // not DEPEND on the reference, which is why converting to one was a sound
    // workaround before any of this was fixed. So compute the next fire from
    // the pre-fix anchor (the fresh created_at) and the post-fix anchor (the
    // preserved fire) and show they agree.
    const fromEditStamp = nextFireFromCron('14 */2 * * *', Date.parse(EDIT_TIME));
    const fromRealFire = nextFireFromCron('14 */2 * * *', Date.parse(LAST_FIRE));

    expect(new Date(fromEditStamp).toISOString()).toBe('2026-08-15T18:14:00.000Z');
    // The interval cron lands on 19:20Z from that same bad anchor; the
    // expression lands on :14 regardless.
    expect(new Date(fromRealFire).toISOString()).toBe('2026-08-15T18:14:00.000Z');
  });
});
