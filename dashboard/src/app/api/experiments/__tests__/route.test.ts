/**
 * dashboard/src/app/api/experiments/__tests__/route.test.ts
 *
 * Regression test for a CodeRabbit finding on PR #189
 * (task_1789437846265_69785154): GET /api/experiments used to read the
 * static, append-only experiments/learnings.md file directly, so a decision
 * corrected after the fact via evaluate-experiment --decision or
 * correct-experiment-decision (which only ever touch the JSON record, never
 * the static file — see displayBaseline()/formatLearnings() in
 * src/bus/experiment.ts) would keep showing the pre-correction decision on
 * the dashboard forever. The route now regenerates `learnings` live from the
 * JSON history records on every call (see formatLearningsLive in route.ts).
 *
 * Uses the route handler directly with mocked filesystem
 * (CTX_FRAMEWORK_ROOT set before import).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

const rootTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'experiments-route-test-'));
process.env.CTX_FRAMEWORK_ROOT = rootTmp;

const expDir = path.join(rootTmp, 'orgs', 'testorg', 'agents', 'testbot', 'experiments');
const histDir = path.join(expDir, 'history');

function writeExperiment(id: string, overrides: Record<string, unknown>): void {
  fs.mkdirSync(histDir, { recursive: true });
  const base = {
    id,
    agent: 'testbot',
    metric: 'kb_ingest_fleet_freshness',
    hypothesis: 'test hypothesis',
    surface: '',
    direction: 'higher',
    window: '24h',
    measurement: '',
    status: 'completed',
    baseline_value: 64.3,
    result_value: 50,
    score: null,
    decision: 'discard',
    mechanical_decision: 'discard',
    next_baseline_value: 64.3,
    baseline_is_placeholder: false,
    needs_manual_review: false,
    learning: 'baseline was corrupted, real comparison favors keep',
    experiment_commit: null,
    tracking_commit: null,
    created_at: '2026-09-01T00:00:00.000Z',
    started_at: '2026-09-01T00:00:00.000Z',
    completed_at: '2026-09-01T01:00:00.000Z',
    changes_description: null,
    kind: 'intervention',
    approval_id: null,
  };
  fs.writeFileSync(
    path.join(histDir, `${id}.json`),
    JSON.stringify({ ...base, ...overrides }, null, 2),
  );
}

afterAll(() => {
  try {
    fs.rmSync(rootTmp, { recursive: true });
  } catch {
    /* ignore */
  }
});

let GET: (req: NextRequest) => Promise<Response>;

beforeAll(async () => {
  const mod = await import('../route');
  GET = mod.GET;
});

function makeReq(search = ''): NextRequest {
  return new NextRequest(`http://localhost/api/experiments${search ? '?' + search : ''}`);
}

describe('GET /api/experiments — learnings self-correction (marketing exp_1787745238_vzgah shape)', () => {
  it('reflects a corrected decision even when a stale static learnings.md disagrees', async () => {
    writeExperiment('exp_test_vzgah_shape', { decision: 'discard', mechanical_decision: 'discard' });

    // A stale static file exactly as correctExperimentDecision leaves it —
    // it never touches learnings.md, only the JSON record.
    fs.mkdirSync(expDir, { recursive: true });
    fs.writeFileSync(
      path.join(expDir, 'learnings.md'),
      '# Experiment Learnings\n\n## exp_test_vzgah_shape (discard)\n- **Result:** 50 (baseline: 64.3)\n',
    );

    let res = await GET(makeReq('agent=testbot&org=testorg'));
    let data = await res.json();
    expect(data.agents[0].learnings).toContain('## exp_test_vzgah_shape (discard)');

    // Simulate correctExperimentDecision flipping the JSON record — the
    // static file is deliberately left untouched, matching the real command.
    writeExperiment('exp_test_vzgah_shape', {
      decision: 'keep',
      mechanical_decision: 'discard',
      decision_corrected_at: '2026-09-15T00:00:00.000Z',
      decision_correction_reason: 'baseline_value was corrupted',
      next_baseline_value: 50,
    });

    res = await GET(makeReq('agent=testbot&org=testorg'));
    data = await res.json();
    expect(data.agents[0].learnings).toContain('## exp_test_vzgah_shape (keep)');
    expect(data.agents[0].learnings).not.toContain('(discard)');
    // baseline in the learnings text should also reflect the corrected
    // ratchet (effective value 50, since decision is now keep), not the
    // stale pre-correction baseline of 64.3.
    expect(data.agents[0].learnings).toContain('baseline: 50');

    // The keep/discard counts (computed separately, already live) must
    // agree with the regenerated text rather than drifting from it.
    expect(data.agents[0].stats.kept).toBe(1);
    expect(data.agents[0].stats.discarded).toBe(0);
  });

  it('a --score evaluation shows the score-based result line, not measured_value', async () => {
    writeExperiment('exp_test_scored', {
      id: 'exp_test_scored',
      score: 7,
      result_value: 0,
      decision: 'keep',
      mechanical_decision: 'keep',
    });

    const res = await GET(makeReq('agent=testbot&org=testorg'));
    const data = await res.json();
    const learnings: string = data.agents[0].learnings;
    expect(learnings).toContain('## exp_test_scored (keep)');
    expect(learnings).toContain('score 7 (measured_value: 0');
  });
});
