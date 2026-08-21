/**
 * tests/unit/cli/kb-query-leading-dash.test.ts
 *
 * Regression test for task_1786910207793_59268544: `cortextos bus kb-query`
 * cannot query any string beginning with '-'. Commander parses a leading-dash
 * positional as an unrecognized option before the action handler ever runs,
 * so `kb-query '- some fact' --org wyre` failed with "unknown option '-'" at
 * rc=1 and EMPTY STDOUT — indistinguishable from a genuine no-match to a
 * caller checking stdout. This mattered in practice: probes drawn from
 * markdown bullet lines (which start with '-') scored false MISSes in the
 * kb_ingest_fleet_freshness measurement.
 *
 * Two things are exercised against the real commander parser via
 * busCommand.parseAsync (not just the pure shielding function in isolation),
 * per the project's "a broken probe returns a confident answer" lesson —
 * a unit test on shieldKbQueryLeadingDash alone would not prove commander
 * actually accepts the shielded token:
 *
 *   1. The bug reproduces without the shield (positive control — proves this
 *      test would have caught the original defect, not just the fix).
 *   2. Applying shieldKbQueryLeadingDash before parseAsync fixes it, and the
 *      sentinel is stripped back off before reaching queryKnowledgeBase.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryKnowledgeBaseMock = vi.fn().mockReturnValue({
  results: [],
  total: 0,
  query: '',
  collection: 'shared-testorg',
});

vi.mock('../../../src/bus/knowledge-base.js', () => ({
  queryKnowledgeBase: (...args: unknown[]) => queryKnowledgeBaseMock(...args),
  ingestKnowledgeBase: vi.fn(),
  ensureKBDirs: vi.fn(),
}));

import { busCommand, shieldKbQueryLeadingDash } from '../../../src/cli/bus';

function mockExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__PROCESS_EXIT_${code}__`);
  }) as never);
}

beforeEach(() => {
  queryKnowledgeBaseMock.mockClear();
});

describe('kb-query leading-dash argument', () => {
  it('control: reproduces the original bug when the shield is skipped', async () => {
    // Commander writes its own parse errors straight to process.stderr
    // (not console.error), so that's what has to be spied on here.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = mockExit();

    await expect(
      busCommand.parseAsync(['node', 'bus', 'kb-query', '- some fact', '--org', 'testorg']),
    ).rejects.toThrow(/__PROCESS_EXIT_/);

    expect(exitSpy).toHaveBeenCalled();
    expect(queryKnowledgeBaseMock).not.toHaveBeenCalled();
    const errText = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errText).toMatch(/unknown option/i);
  });

  it('fix: shieldKbQueryLeadingDash lets a leading-dash query reach queryKnowledgeBase intact', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const argv = shieldKbQueryLeadingDash([
      'node', 'bus', 'kb-query', '- some fact', '--org', 'testorg',
    ]);

    await busCommand.parseAsync(argv);

    expect(errSpy).not.toHaveBeenCalled();
    expect(queryKnowledgeBaseMock).toHaveBeenCalledTimes(1);
    const [, question] = queryKnowledgeBaseMock.mock.calls[0];
    expect(question).toBe('- some fact');
  });

  it('is a no-op for a normal (non-dash) query', () => {
    const argv = ['node', 'bus', 'kb-query', 'ordinary question', '--org', 'testorg'];
    expect(shieldKbQueryLeadingDash(argv)).toEqual(argv);
  });

  it('does not shield a real kb-query flag (e.g. --json)', () => {
    const argv = ['node', 'bus', 'kb-query', '--json'];
    expect(shieldKbQueryLeadingDash(argv)).toEqual(argv);
  });

  it('does not touch argv when kb-query is not the invoked command', () => {
    const argv = ['node', 'bus', 'list-tasks', '--status', 'pending'];
    expect(shieldKbQueryLeadingDash(argv)).toEqual(argv);
  });

  it('leaves a bare "--" alone (commander\'s own escape, not a flag to shield)', () => {
    const argv = ['node', 'bus', 'kb-query', '--', '- some fact'];
    expect(shieldKbQueryLeadingDash(argv)).toEqual(argv);
  });
});
