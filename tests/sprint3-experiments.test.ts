import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createExperiment,
  runExperiment,
  evaluateExperiment,
  listExperiments,
  listAllExperiments,
  gatherContext,
  manageCycle,
  validateExperimentBaseline,
  linkExperimentApproval,
} from '../src/bus/experiment.js';
import type { BusPaths, ApprovalStatus } from '../src/types/index.js';

describe('Sprint 3: Experiment Framework', () => {
  const testDir = join(tmpdir(), `cortextos-sprint3-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(join(testDir, 'experiments', 'history'), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe('createExperiment', () => {
    it('generates valid ID and JSON', () => {
      const id = createExperiment(testDir, 'testbot', 'engagement_rate', 'Shorter posts get more likes');
      expect(id).toMatch(/^exp_\d+_[a-z0-9]{5}$/);

      const filePath = join(testDir, 'experiments', 'history', `${id}.json`);
      expect(existsSync(filePath)).toBe(true);

      const exp = JSON.parse(readFileSync(filePath, 'utf-8').trim());
      expect(exp.id).toBe(id);
      expect(exp.agent).toBe('testbot');
      expect(exp.metric).toBe('engagement_rate');
      expect(exp.hypothesis).toBe('Shorter posts get more likes');
      expect(exp.status).toBe('proposed');
      expect(exp.baseline_value).toBeNull();
      expect(exp.result_value).toBeNull();
      expect(exp.decision).toBeNull();
      expect(exp.direction).toBe('higher');
      expect(exp.window).toBe('24h');
      expect(exp.started_at).toBeNull();
      expect(exp.completed_at).toBeNull();
      expect(exp.changes_description).toBeNull();
    });

    it('accepts optional surface, direction, window', () => {
      const id = createExperiment(testDir, 'testbot', 'bounce_rate', 'Less text = lower bounce', {
        surface: 'experiments/surfaces/bounce/current.md',
        direction: 'lower',
        window: '48h',
      });

      const filePath = join(testDir, 'experiments', 'history', `${id}.json`);
      const exp = JSON.parse(readFileSync(filePath, 'utf-8').trim());
      expect(exp.surface).toBe('experiments/surfaces/bounce/current.md');
      expect(exp.direction).toBe('lower');
      expect(exp.window).toBe('48h');
    });

    it('inherits measurement/direction/window/surface from a matching cycle in config.json', () => {
      // Write an experiments/config.json with a cycle for this metric.
      mkdirSync(join(testDir, 'experiments'), { recursive: true });
      writeFileSync(
        join(testDir, 'experiments', 'config.json'),
        JSON.stringify({
          cycles: [
            {
              name: 'retention-cycle',
              agent: 'testbot',
              metric: 'retention',
              metric_type: 'quantitative',
              surface: 'experiments/surfaces/retention/current.md',
              direction: 'higher',
              window: '7d',
              measurement: 'count(distinct users_returning_in_7d) / count(distinct signups)',
              loop_interval: '7d',
              enabled: true,
              created_by: 'testbot',
              created_at: '2026-04-01T00:00:00Z',
            },
          ],
        }),
      );

      const id = createExperiment(testDir, 'testbot', 'retention', 'Better onboarding improves retention');

      const exp = JSON.parse(
        readFileSync(join(testDir, 'experiments', 'history', `${id}.json`), 'utf-8').trim(),
      );
      expect(exp.measurement).toBe('count(distinct users_returning_in_7d) / count(distinct signups)');
      expect(exp.surface).toBe('experiments/surfaces/retention/current.md');
      expect(exp.window).toBe('7d');
      expect(exp.direction).toBe('higher');
    });

    it('explicit options win over matching-cycle defaults', () => {
      mkdirSync(join(testDir, 'experiments'), { recursive: true });
      writeFileSync(
        join(testDir, 'experiments', 'config.json'),
        JSON.stringify({
          cycles: [
            {
              name: 'ctr-cycle',
              agent: 'testbot',
              metric: 'ctr',
              direction: 'higher',
              window: '24h',
              measurement: 'clicks / impressions',
              surface: 'default-surface.md',
              enabled: true,
              created_by: 'testbot',
              created_at: '2026-04-01T00:00:00Z',
              metric_type: 'quantitative',
              loop_interval: '24h',
            },
          ],
        }),
      );

      const id = createExperiment(testDir, 'testbot', 'ctr', 'test', {
        direction: 'lower',
        measurement: 'custom-override',
      });
      const exp = JSON.parse(
        readFileSync(join(testDir, 'experiments', 'history', `${id}.json`), 'utf-8').trim(),
      );
      expect(exp.direction).toBe('lower'); // overrode cycle
      expect(exp.measurement).toBe('custom-override'); // overrode cycle
      expect(exp.window).toBe('24h'); // inherited from cycle
      expect(exp.surface).toBe('default-surface.md'); // inherited from cycle
    });

    it('falls through to static defaults when no matching cycle exists', () => {
      mkdirSync(join(testDir, 'experiments'), { recursive: true });
      writeFileSync(
        join(testDir, 'experiments', 'config.json'),
        JSON.stringify({
          cycles: [
            {
              name: 'other-metric-cycle',
              agent: 'testbot',
              metric: 'different_metric',
              direction: 'higher',
              window: '7d',
              measurement: 'irrelevant',
              surface: '',
              enabled: true,
              created_by: 'testbot',
              created_at: '2026-04-01T00:00:00Z',
              metric_type: 'quantitative',
              loop_interval: '7d',
            },
          ],
        }),
      );

      const id = createExperiment(testDir, 'testbot', 'unrelated_metric', 'test');
      const exp = JSON.parse(
        readFileSync(join(testDir, 'experiments', 'history', `${id}.json`), 'utf-8').trim(),
      );
      expect(exp.measurement).toBe('');
      expect(exp.direction).toBe('higher'); // static default
      expect(exp.window).toBe('24h'); // static default
    });

    it('defaults kind to intervention when not specified', () => {
      const id = createExperiment(testDir, 'testbot', 'engagement_rate', 'test');
      const exp = JSON.parse(readFileSync(join(testDir, 'experiments', 'history', `${id}.json`), 'utf-8').trim());
      expect(exp.kind).toBe('intervention');
    });

    it('accepts kind: snapshot for recurring qualitative scores', () => {
      const id = createExperiment(testDir, 'testbot', 'system_effectiveness', 'test', { kind: 'snapshot' });
      const exp = JSON.parse(readFileSync(join(testDir, 'experiments', 'history', `${id}.json`), 'utf-8').trim());
      expect(exp.kind).toBe('snapshot');
    });

    it('accepts an explicit baseline value', () => {
      const id = createExperiment(testDir, 'testbot', 'engagement_rate', 'test', { baseline: 12.5 });
      const exp = JSON.parse(readFileSync(join(testDir, 'experiments', 'history', `${id}.json`), 'utf-8').trim());
      expect(exp.baseline_value).toBe(12.5);
    });

    it('defaults baseline to null (not 0) when --baseline is omitted', () => {
      const id = createExperiment(testDir, 'testbot', 'engagement_rate', 'test');
      const exp = JSON.parse(readFileSync(join(testDir, 'experiments', 'history', `${id}.json`), 'utf-8').trim());
      expect(exp.baseline_value).toBeNull();
    });
  });

  describe('validateExperimentBaseline (create-experiment CLI guard)', () => {
    it('throws when --baseline was omitted (raw undefined)', () => {
      expect(() => validateExperimentBaseline(undefined)).toThrow('no --baseline given');
    });

    it('accepts an explicit "0" so a genuine from-zero baseline is not mistaken for an omission', () => {
      expect(() => validateExperimentBaseline('0')).not.toThrow();
    });

    it('accepts any other explicit numeric string', () => {
      expect(() => validateExperimentBaseline('12.5')).not.toThrow();
    });
  });

  describe('runExperiment', () => {
    it('transitions proposed -> running', () => {
      const id = createExperiment(testDir, 'testbot', 'ctr', 'Bold CTA improves CTR');
      const result = runExperiment(testDir, id, 'Changed button color to red');

      expect(result.status).toBe('running');
      expect(result.started_at).toBeTruthy();
      expect(result.changes_description).toBe('Changed button color to red');

      // active.json should exist
      const activePath = join(testDir, 'experiments', 'active.json');
      expect(existsSync(activePath)).toBe(true);
      const active = JSON.parse(readFileSync(activePath, 'utf-8').trim());
      expect(active.id).toBe(id);
      expect(active.status).toBe('running');
    });

    it('throws if experiment is not proposed', () => {
      const id = createExperiment(testDir, 'testbot', 'ctr', 'test');
      runExperiment(testDir, id);
      expect(() => runExperiment(testDir, id)).toThrow("expected 'proposed'");
    });
  });

  describe('runExperiment — approval refusing guard', () => {
    const approvalRoot = join(testDir, 'approvals-root');

    function mkPaths(): BusPaths {
      return {
        ctxRoot: approvalRoot,
        inbox: join(approvalRoot, 'inbox'),
        inflight: join(approvalRoot, 'inflight'),
        processed: join(approvalRoot, 'processed'),
        logDir: join(approvalRoot, 'logs'),
        stateDir: join(approvalRoot, 'state'),
        taskDir: join(approvalRoot, 'tasks'),
        approvalDir: join(approvalRoot, 'orgs', 'TestOrg', 'approvals'),
        analyticsDir: join(approvalRoot, 'analytics'),
        deliverablesDir: join(approvalRoot, 'deliverables'),
      };
    }

    // Writes a minimal but shape-complete Approval record directly to the
    // bucket getApproval actually reads from ('pending' vs 'resolved') —
    // mirrors what createApproval/updateApproval produce, without needing
    // Telegram/activity-channel plumbing live for a unit test.
    function writeApproval(paths: BusPaths, approvalId: string, status: ApprovalStatus): void {
      const bucket = status === 'pending' ? 'pending' : 'resolved';
      const dir = join(paths.approvalDir, bucket);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${approvalId}.json`),
        JSON.stringify({
          id: approvalId,
          title: 'Run experiment: test',
          requesting_agent: 'testbot',
          org: 'TestOrg',
          category: 'other',
          status,
          description: '',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          resolved_at: status === 'pending' ? null : '2026-01-01T00:00:00Z',
          resolved_by: status === 'pending' ? null : 'aaron',
        }),
      );
    }

    it('linkExperimentApproval persists approval_id onto the experiment record', () => {
      const id = createExperiment(testDir, 'testbot', 'ctr', 'linked test');
      const linked = linkExperimentApproval(testDir, id, 'approval_123_abcde');
      expect(linked.approval_id).toBe('approval_123_abcde');

      const filePath = join(testDir, 'experiments', 'history', `${id}.json`);
      const onDisk = JSON.parse(readFileSync(filePath, 'utf-8').trim());
      expect(onDisk.approval_id).toBe('approval_123_abcde');
    });

    it('a freshly created experiment has approval_id: null', () => {
      const id = createExperiment(testDir, 'testbot', 'ctr', 'unlinked test');
      const filePath = join(testDir, 'experiments', 'history', `${id}.json`);
      const onDisk = JSON.parse(readFileSync(filePath, 'utf-8').trim());
      expect(onDisk.approval_id).toBeNull();
    });

    it('refuses to start when the linked approval is pending — does not reach running', () => {
      const paths = mkPaths();
      const id = createExperiment(testDir, 'testbot', 'ctr', 'pending-blocked');
      linkExperimentApproval(testDir, id, 'approval_pending_1');
      writeApproval(paths, 'approval_pending_1', 'pending');

      expect(() => runExperiment(testDir, id, undefined, paths)).toThrow('refusing to start until it is approved');

      const onDisk = JSON.parse(
        readFileSync(join(testDir, 'experiments', 'history', `${id}.json`), 'utf-8').trim(),
      );
      expect(onDisk.status).toBe('proposed');
    });

    it('refuses to start when the linked approval is rejected — same discriminator as pending', () => {
      const paths = mkPaths();
      const id = createExperiment(testDir, 'testbot', 'ctr', 'rejected-blocked');
      linkExperimentApproval(testDir, id, 'approval_rejected_1');
      writeApproval(paths, 'approval_rejected_1', 'rejected');

      expect(() => runExperiment(testDir, id, undefined, paths)).toThrow('refusing to start until it is approved');

      const onDisk = JSON.parse(
        readFileSync(join(testDir, 'experiments', 'history', `${id}.json`), 'utf-8').trim(),
      );
      expect(onDisk.status).toBe('proposed');
    });

    it('refuses to start when the linked approval cannot be found at all', () => {
      const paths = mkPaths();
      const id = createExperiment(testDir, 'testbot', 'ctr', 'missing-approval');
      linkExperimentApproval(testDir, id, 'approval_does_not_exist');

      expect(() => runExperiment(testDir, id, undefined, paths)).toThrow('status: not found');
    });

    it('refuses to start when approval_id is linked but no paths are supplied — fails closed, not open', () => {
      const id = createExperiment(testDir, 'testbot', 'ctr', 'no-paths-supplied');
      linkExperimentApproval(testDir, id, 'approval_whatever');

      expect(() => runExperiment(testDir, id)).toThrow('no approval context was supplied');
    });

    it('starts normally once the linked approval is approved', () => {
      const paths = mkPaths();
      const id = createExperiment(testDir, 'testbot', 'ctr', 'approved-allowed');
      linkExperimentApproval(testDir, id, 'approval_approved_1');
      writeApproval(paths, 'approval_approved_1', 'approved');

      const result = runExperiment(testDir, id, 'shipped', paths);
      expect(result.status).toBe('running');
      expect(result.started_at).toBeTruthy();
    });

    it('an experiment with no approval_id proceeds unaffected even when paths are supplied', () => {
      const paths = mkPaths();
      const id = createExperiment(testDir, 'testbot', 'ctr', 'no-approval-required');
      const result = runExperiment(testDir, id, undefined, paths);
      expect(result.status).toBe('running');
    });
  });

  describe('evaluateExperiment', () => {
    it('refuses to evaluate an experiment created without --baseline', () => {
      const id = createExperiment(testDir, 'testbot', 'engagement', 'No baseline set');
      runExperiment(testDir, id);
      expect(() => evaluateExperiment(testDir, id, 42)).toThrow('no baseline_value');
    });

    it('keeps when higher is better and measured > baseline', () => {
      const id = createExperiment(testDir, 'testbot', 'engagement', 'More emojis', {
        direction: 'higher',
        baseline: 0,
      });
      runExperiment(testDir, id);
      const result = evaluateExperiment(testDir, id, 42, { learning: 'Emojis work' });

      expect(result.status).toBe('completed');
      expect(result.decision).toBe('keep');
      expect(result.result_value).toBe(42);
      expect(result.baseline_value).toBe(0); // frozen — what this cycle was actually compared against
      expect(result.next_baseline_value).toBe(42); // ratchet: what the NEXT cycle should use
      expect(result.completed_at).toBeTruthy();
      expect(result.learning).toBe('Emojis work');

      // active.json should be removed
      const activePath = join(testDir, 'experiments', 'active.json');
      expect(existsSync(activePath)).toBe(false);

      // results.tsv should exist with data
      const tsvPath = join(testDir, 'experiments', 'results.tsv');
      expect(existsSync(tsvPath)).toBe(true);
      const tsvContent = readFileSync(tsvPath, 'utf-8');
      expect(tsvContent).toContain('experiment_id\tagent');
      expect(tsvContent).toContain(id);

      // learnings.md should exist with entry
      const learningsPath = join(testDir, 'experiments', 'learnings.md');
      expect(existsSync(learningsPath)).toBe(true);
      const learnings = readFileSync(learningsPath, 'utf-8');
      expect(learnings).toContain(id);
      expect(learnings).toContain('Emojis work');
    });

    it('discards when measured < baseline (direction=higher)', () => {
      const id = createExperiment(testDir, 'testbot', 'engagement', 'Remove images', {
        baseline: 0,
      });
      runExperiment(testDir, id);

      // Measured 0 vs baseline 0 should discard (not strictly greater)
      const result = evaluateExperiment(testDir, id, 0);
      expect(result.decision).toBe('discard');
      expect(result.baseline_value).toBe(0); // frozen, unchanged
      expect(result.next_baseline_value).toBe(0); // discard: target doesn't move
    });

    it('keeps when lower is better and measured < baseline', () => {
      const id = createExperiment(testDir, 'testbot', 'bounce_rate', 'Simplify nav', {
        direction: 'lower',
        baseline: 0,
      });
      runExperiment(testDir, id);
      // baseline is 0, measured -5 is lower -> keep
      const result = evaluateExperiment(testDir, id, -5);
      expect(result.decision).toBe('keep');
    });

    it('throws if experiment is not running', () => {
      const id = createExperiment(testDir, 'testbot', 'ctr', 'test');
      expect(() => evaluateExperiment(testDir, id, 10)).toThrow("expected 'running'");
    });

    describe('baseline_is_placeholder / needs_manual_review (murph, exp_1787745238_vzgah shape)', () => {
      it('defaults to false when not marked as a placeholder', () => {
        const id = createExperiment(testDir, 'testbot', 'kb_freshness', 'test', { baseline: 5 });
        runExperiment(testDir, id);
        const result = evaluateExperiment(testDir, id, 10);
        expect(result.needs_manual_review).toBe(false);
      });

      it('flags needs_manual_review on completion when baseline_is_placeholder was set at creation', () => {
        const id = createExperiment(testDir, 'testbot', 'kb_freshness', 'No real prior baseline exists', {
          baseline: 0,
          baselineIsPlaceholder: true,
        });
        const exp = JSON.parse(
          readFileSync(join(testDir, 'experiments', 'history', `${id}.json`), 'utf-8').trim(),
        );
        expect(exp.baseline_is_placeholder).toBe(true);
        expect(exp.needs_manual_review).toBe(false); // not yet evaluated

        runExperiment(testDir, id);
        const result = evaluateExperiment(testDir, id, 3);
        // Decision is still computed mechanically (3 > 0 = keep) — it just isn't trusted silently.
        expect(result.decision).toBe('keep');
        expect(result.needs_manual_review).toBe(true);
      });
    });

    describe('--baseline override (marketing, exp_1786858829_uzaff shape, task_1788524506203)', () => {
      it('refuses a --baseline override with no --justification', () => {
        const id = createExperiment(testDir, 'testbot', 'accept_rate', 'test', { baseline: 37.6 });
        runExperiment(testDir, id);
        expect(() => evaluateExperiment(testDir, id, 48.65, { baseline: 50.77 })).toThrow(
          'no --justification',
        );
      });

      it('reproduces the real bug without an override: stale stored baseline mechanically reads keep', () => {
        // The stored baseline_value (37.6) is from a non-adjacent window and
        // reads as an improvement; this is exactly what happened to
        // exp_1786858829_uzaff before the correction — no override given.
        const id = createExperiment(testDir, 'testbot', 'accept_rate', 'cookie copy test', {
          direction: 'higher',
          baseline: 37.6,
        });
        runExperiment(testDir, id);
        const result = evaluateExperiment(testDir, id, 48.65);
        expect(result.decision).toBe('keep'); // the bug, reproduced — 48.65 > 37.6
      });

      it('uses the override for the decision without touching stored baseline_value', () => {
        const id = createExperiment(testDir, 'testbot', 'accept_rate', 'cookie copy test v2', {
          direction: 'higher',
          baseline: 37.6,
        });
        runExperiment(testDir, id);
        const result = evaluateExperiment(testDir, id, 48.65, {
          baseline: 50.77,
          justification: 'Adjacent matched-window remeasurement supersedes the stale 08-16 baseline',
        });

        expect(result.decision).toBe('discard'); // 48.65 < 50.77 — correct call
        expect(result.baseline_value).toBe(37.6); // frozen, untouched — historical fact preserved
        expect(result.next_baseline_value).toBe(50.77); // discard: ratchet uses the OVERRIDE, not the stale stored value
        expect(result.learning).toContain('BASELINE OVERRIDE');
        expect(result.learning).toContain('50.77');
        expect(result.learning).toContain('37.6');
        expect(result.learning).toContain('Adjacent matched-window remeasurement');
      });

      it('a keep with an override still ratchets forward to the override-driven effective value', () => {
        const id = createExperiment(testDir, 'testbot', 'accept_rate', 'cookie copy test v3', {
          direction: 'higher',
          baseline: 10,
        });
        runExperiment(testDir, id);
        const result = evaluateExperiment(testDir, id, 60, {
          baseline: 50,
          justification: 'Fresher comparison point',
        });
        expect(result.decision).toBe('keep'); // 60 > 50
        expect(result.next_baseline_value).toBe(60); // keep: ratchet is the effective (measured) value
      });
    });

    describe('--score (qualitative metrics)', () => {
      it('keeps result_value as the raw measuredValue passed, even when score is given (task_1786464752094)', () => {
        const id = createExperiment(testDir, 'testbot', 'tone', 'Warmer replies', {
          direction: 'higher',
          baseline: 5,
        });
        runExperiment(testDir, id);
        // Placeholder measuredValue (0) + a real qualitative score (7).
        const result = evaluateExperiment(testDir, id, 0, { score: 7 });

        expect(result.result_value).toBe(0); // NOT overwritten by the score
        expect(result.score).toBe(7); // independent field
      });

      it('decides keep/discard using score, not the placeholder measuredValue', () => {
        const id = createExperiment(testDir, 'testbot', 'tone', 'Warmer replies', {
          direction: 'higher',
          baseline: 5,
        });
        runExperiment(testDir, id);
        // measuredValue (0) alone would discard (0 < 5); score (7) should keep (7 > 5).
        const result = evaluateExperiment(testDir, id, 0, { score: 7 });

        expect(result.decision).toBe('keep');
        expect(result.baseline_value).toBe(5); // frozen — the true prior baseline, not clobbered
        expect(result.next_baseline_value).toBe(7); // next eval's baseline is the score, not the placeholder
      });

      it('refuses --score alongside a non-zero measured_value (score-vs-value ambiguity, adoption exp_1786934595_ltugf)', () => {
        const id = createExperiment(testDir, 'testbot', 'manual_steps', 'Fewer manual steps', {
          direction: 'lower',
          baseline: 9,
        });
        runExperiment(testDir, id);
        // A real measurement (8) AND a score (9) together is ambiguous — refuse rather than
        // silently let score win and discard the real measurement.
        expect(() => evaluateExperiment(testDir, id, 8, { score: 9 })).toThrow(
          '--score 9 given alongside a non-zero measured_value (8)',
        );
      });

      it('score is null when not given, on both a scored-metric and a plain-metric evaluation', () => {
        const id = createExperiment(testDir, 'testbot', 'ctr', 'test', { baseline: 0 });
        runExperiment(testDir, id);
        const result = evaluateExperiment(testDir, id, 42);

        expect(result.score).toBeNull();
        expect(result.result_value).toBe(42);
      });

      it('results.tsv records measured_value and score as independent columns, score TRAILING (not inserted mid-row)', () => {
        const id = createExperiment(testDir, 'testbot', 'tone', 'Warmer replies', {
          direction: 'higher',
          baseline: 5,
        });
        runExperiment(testDir, id);
        evaluateExperiment(testDir, id, 0, { score: 7 });

        const tsvPath = join(testDir, 'experiments', 'results.tsv');
        const lines = readFileSync(tsvPath, 'utf-8').split('\n').filter(Boolean);
        expect(lines[0]).toBe('experiment_id\tagent\tmetric\tmeasured_value\tbaseline\tdecision\thypothesis\ttimestamp\tscore');
        const cols = lines[1].split('\t');
        expect(cols[3]).toBe('0'); // measured_value: the raw placeholder
        expect(cols[4]).toBe('7'); // baseline: the effective (score-driven) value on keep
        expect(cols[8]).toBe('7'); // score: independent, trailing column
      });

      it('results.tsv leaves the score column empty for a plain (unscored) evaluation', () => {
        const id = createExperiment(testDir, 'testbot', 'ctr', 'test', { baseline: 0 });
        runExperiment(testDir, id);
        evaluateExperiment(testDir, id, 42);

        const tsvPath = join(testDir, 'experiments', 'results.tsv');
        const lines = readFileSync(tsvPath, 'utf-8').split('\n').filter(Boolean);
        const cols = lines[1].split('\t');
        expect(cols[3]).toBe('42');
        expect(cols[8]).toBe('');
      });

      it('a scored row appended to a PRE-EXISTING 8-column results.tsv stays aligned with the old header (cortextos#90 review finding)', () => {
        const expDir = join(testDir, 'experiments');
        const tsvPath = join(expDir, 'results.tsv');
        // Seed a results.tsv exactly as it looked before `score` existed —
        // 8 columns, no score column at all (e.g. walter's own live
        // theta-wave file). A mid-row insert of `score` would shift every
        // column after it out of alignment with this header.
        writeFileSync(
          tsvPath,
          'experiment_id\tagent\tmetric\tmeasured_value\tbaseline\tdecision\thypothesis\ttimestamp\n' +
            'exp_old_1\ttestbot\tctr\t10\t5\tkeep\told hypothesis\t2026-05-01T00:00:00.000Z\n',
          'utf-8',
        );

        const id = createExperiment(testDir, 'testbot', 'tone', 'Warmer replies', {
          direction: 'higher',
          baseline: 5,
        });
        runExperiment(testDir, id);
        evaluateExperiment(testDir, id, 0, { score: 7 });

        const lines = readFileSync(tsvPath, 'utf-8').split('\n').filter(Boolean);
        expect(lines).toHaveLength(3); // header + pre-existing row + new row
        expect(lines[0]).toBe(
          'experiment_id\tagent\tmetric\tmeasured_value\tbaseline\tdecision\thypothesis\ttimestamp',
        ); // untouched — still the OLD 8-column header, never rewritten
        expect(lines[1]).toBe(
          'exp_old_1\ttestbot\tctr\t10\t5\tkeep\told hypothesis\t2026-05-01T00:00:00.000Z',
        ); // untouched
        const newCols = lines[2].split('\t');
        // First 8 columns line up exactly with the old header's positions —
        // score is a 9th, trailing column any positional reader of the old
        // 8-column shape simply never sees.
        expect(newCols).toHaveLength(9);
        expect(newCols[0]).toBe(id);
        expect(newCols[3]).toBe('0'); // measured_value
        expect(newCols[4]).toBe('7'); // baseline (effective value on keep)
        expect(newCols[5]).toBe('keep'); // decision
        expect(newCols[6]).toBe('Warmer replies'); // hypothesis
        expect(newCols[8]).toBe('7'); // score, trailing
      });
    });
  });

  describe('listExperiments', () => {
    it('returns all experiments sorted by created_at desc', () => {
      createExperiment(testDir, 'bot1', 'metric_a', 'hyp1');
      createExperiment(testDir, 'bot2', 'metric_b', 'hyp2');
      const list = listExperiments(testDir);
      expect(list).toHaveLength(2);
      // Most recent first
      expect(new Date(list[0].created_at).getTime()).toBeGreaterThanOrEqual(
        new Date(list[1].created_at).getTime(),
      );
    });

    it('filters by status', () => {
      const id1 = createExperiment(testDir, 'bot1', 'ctr', 'h1');
      createExperiment(testDir, 'bot1', 'ctr', 'h2');
      runExperiment(testDir, id1);

      const running = listExperiments(testDir, { status: 'running' });
      expect(running).toHaveLength(1);
      expect(running[0].id).toBe(id1);

      const proposed = listExperiments(testDir, { status: 'proposed' });
      expect(proposed).toHaveLength(1);
    });

    it('filters by metric', () => {
      createExperiment(testDir, 'bot1', 'ctr', 'h1');
      createExperiment(testDir, 'bot1', 'engagement', 'h2');

      const ctrOnly = listExperiments(testDir, { metric: 'ctr' });
      expect(ctrOnly).toHaveLength(1);
      expect(ctrOnly[0].metric).toBe('ctr');
    });

    it('filters by agent', () => {
      createExperiment(testDir, 'alpha', 'ctr', 'h1');
      createExperiment(testDir, 'beta', 'ctr', 'h2');

      const alphaOnly = listExperiments(testDir, { agent: 'alpha' });
      expect(alphaOnly).toHaveLength(1);
      expect(alphaOnly[0].agent).toBe('alpha');
    });

    it('returns empty array when no experiments exist', () => {
      const emptyDir = join(testDir, 'empty-agent');
      mkdirSync(emptyDir, { recursive: true });
      const list = listExperiments(emptyDir);
      expect(list).toEqual([]);
    });
  });

  describe('gatherContext', () => {
    it('calculates keep rate from completed experiments', () => {
      // Create 3 experiments: 2 keep, 1 discard
      const id1 = createExperiment(testDir, 'testbot', 'engagement', 'h1', { baseline: 0 });
      runExperiment(testDir, id1);
      evaluateExperiment(testDir, id1, 10); // keep (10 > 0)

      const id2 = createExperiment(testDir, 'testbot', 'engagement', 'h2', { baseline: 0 });
      runExperiment(testDir, id2);
      evaluateExperiment(testDir, id2, 5); // keep (5 > 0)

      const id3 = createExperiment(testDir, 'testbot', 'engagement', 'h3', { baseline: 0 });
      runExperiment(testDir, id3);
      evaluateExperiment(testDir, id3, 0); // discard (0 not > 0)

      const ctx = gatherContext(testDir, 'testbot');
      expect(ctx.agent).toBe('testbot');
      expect(ctx.total_experiments).toBe(3);
      expect(ctx.keeps).toBe(2);
      expect(ctx.discards).toBe(1);
      expect(ctx.keep_rate).toBeCloseTo(2 / 3);
      expect(ctx.learnings).toContain('Experiment Learnings');
      expect(ctx.results_tsv).toContain('experiment_id');
    });

    it('never goes stale relative to list-experiments after a record is corrected post-completion (task_1787278742191_41460753 item D, adoption\'s exp_1786934595_ltugf shape)', () => {
      const id = createExperiment(testDir, 'testbot', 'manual_steps', 'test', {
        direction: 'lower',
        baseline: 9,
      });
      runExperiment(testDir, id);
      evaluateExperiment(testDir, id, 8); // correctly decides keep (8 < 9)

      // Simulate a hand-correction to the persisted record — e.g. a decision
      // fixed after the fact, exactly as adoption did for exp_1786934595_ltugf
      // (no update-experiment CLI exists yet; this is how corrections happen
      // today). The physical results.tsv/learnings.md written at evaluate
      // time are NOT touched by this — they still say the pre-correction
      // decision, same as the real incident.
      const filePath = join(testDir, 'experiments', 'history', `${id}.json`);
      const corrected = JSON.parse(readFileSync(filePath, 'utf-8').trim());
      expect(corrected.decision).toBe('keep');
      corrected.decision = 'discard';
      writeFileSync(filePath, JSON.stringify(corrected, null, 2));

      const fromList = listExperiments(testDir, { agent: 'testbot' }).find(e => e.id === id);
      expect(fromList?.decision).toBe('discard');

      const ctx = gatherContext(testDir, 'testbot');
      // gatherContext must reflect the CORRECTED record, not the stale
      // physical files written at original evaluate-experiment time.
      expect(ctx.discards).toBe(1);
      expect(ctx.keeps).toBe(0);
      expect(ctx.results_tsv).toContain(`${id}\ttestbot\tmanual_steps\t8\t9\tdiscard`);
      expect(ctx.learnings).toContain(`## ${id} (discard)`);
    });

    it('reads IDENTITY.md and GOALS.md if present', () => {
      const { writeFileSync } = require('fs');
      writeFileSync(join(testDir, 'IDENTITY.md'), '# Test Agent\nI am a test agent.\n');
      writeFileSync(join(testDir, 'GOALS.md'), '# Goals\n- Be awesome\n');

      const ctx = gatherContext(testDir, 'testbot');
      expect(ctx.identity).toContain('Test Agent');
      expect(ctx.goals).toContain('Be awesome');
    });

    it('returns empty strings when no experiments exist', () => {
      const emptyDir = join(testDir, 'empty');
      mkdirSync(emptyDir, { recursive: true });
      const ctx = gatherContext(emptyDir, 'testbot');
      expect(ctx.total_experiments).toBe(0);
      expect(ctx.keeps).toBe(0);
      expect(ctx.discards).toBe(0);
      expect(ctx.keep_rate).toBe(0);
      expect(ctx.learnings).toBe('');
      expect(ctx.results_tsv).toBe('');
    });
  });

  describe('manageCycle', () => {
    it('creates a cycle', () => {
      const cycles = manageCycle(testDir, 'create', {
        name: 'daily-engagement',
        agent: 'testbot',
        metric: 'engagement_rate',
        surface: 'surfaces/engagement.md',
        direction: 'higher',
        window: '24h',
      });

      expect(cycles).toHaveLength(1);
      expect(cycles[0].name).toBe('daily-engagement');
      expect(cycles[0].metric).toBe('engagement_rate');

      // Verify config.json was written
      const configPath = join(testDir, 'experiments', 'config.json');
      expect(existsSync(configPath)).toBe(true);
    });

    it('modifies an existing cycle', () => {
      manageCycle(testDir, 'create', {
        name: 'weekly',
        agent: 'testbot',
        metric: 'ctr',
      });

      const cycles = manageCycle(testDir, 'modify', {
        name: 'weekly',
        metric: 'bounce_rate',
        direction: 'lower',
      });

      expect(cycles).toHaveLength(1);
      expect(cycles[0].metric).toBe('bounce_rate');
      expect(cycles[0].direction).toBe('lower');
    });

    it('removes a cycle', () => {
      manageCycle(testDir, 'create', {
        name: 'to-remove',
        agent: 'testbot',
        metric: 'ctr',
      });

      const cycles = manageCycle(testDir, 'remove', { name: 'to-remove' });
      expect(cycles).toHaveLength(0);
    });

    it('lists cycles', () => {
      manageCycle(testDir, 'create', { name: 'c1', agent: 'a', metric: 'm1' });
      manageCycle(testDir, 'create', { name: 'c2', agent: 'b', metric: 'm2' });

      const cycles = manageCycle(testDir, 'list', {});
      expect(cycles).toHaveLength(2);
    });

    it("list with agent filter returns only that agent's cycles", () => {
      manageCycle(testDir, 'create', { name: 'c1', agent: 'alice', metric: 'm1' });
      manageCycle(testDir, 'create', { name: 'c2', agent: 'alice', metric: 'm2' });
      manageCycle(testDir, 'create', { name: 'c3', agent: 'widgetbot', metric: 'm3' });

      const aliceCycles = manageCycle(testDir, 'list', { agent: 'alice' });
      expect(aliceCycles.map((c) => c.name).sort()).toEqual(['c1', 'c2']);

      const widgetCycles = manageCycle(testDir, 'list', { agent: 'widgetbot' });
      expect(widgetCycles.map((c) => c.name)).toEqual(['c3']);

      // No filter still returns all (back-compat)
      const all = manageCycle(testDir, 'list', {});
      expect(all).toHaveLength(3);
    });

    it('throws when modifying non-existent cycle', () => {
      expect(() => manageCycle(testDir, 'modify', { name: 'ghost' })).toThrow('not found');
    });

    it('throws when removing non-existent cycle', () => {
      expect(() => manageCycle(testDir, 'remove', { name: 'ghost' })).toThrow('not found');
    });

    it('throws when creating without required fields', () => {
      expect(() => manageCycle(testDir, 'create', { name: 'x' })).toThrow('requires');
    });
  });

  describe('listAllExperiments (task_1785723303692: fleet-wide, not caller-only)', () => {
    // Own framework/ctx root, distinct from testDir's flat experiments/history
    // fixture used by the single-agent tests above.
    const frameworkRoot = join(tmpdir(), `cortextos-fleet-${Date.now()}`);

    afterEach(() => {
      try {
        rmSync(frameworkRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it('aggregates experiments across every agent, including namespaced personal agents', () => {
      const sharedDir = join(frameworkRoot, 'orgs', 'wyre', 'agents', 'boss');
      const personalDir = join(frameworkRoot, 'orgs', 'wyre', 'engineers', 'aaron', 'agents', 'sidekick');
      mkdirSync(sharedDir, { recursive: true });
      mkdirSync(personalDir, { recursive: true });

      createExperiment(sharedDir, 'boss', 'engagement_rate', 'Shorter posts get more likes');
      createExperiment(personalDir, 'aaron/sidekick', 'response_time', 'Caching cuts latency');

      // No ctxRoot / enabled-agents.json needed — pure directory scan.
      const experiments = listAllExperiments(frameworkRoot, '');
      expect(experiments).toHaveLength(2);
      expect(experiments.map(e => e.agent).sort()).toEqual(['aaron/sidekick', 'boss']);
    });

    it('applies status/metric filters across the whole fleet, not per-agent', () => {
      const agentA = join(frameworkRoot, 'orgs', 'wyre', 'agents', 'alpha');
      const agentB = join(frameworkRoot, 'orgs', 'wyre', 'agents', 'beta');
      mkdirSync(agentA, { recursive: true });
      mkdirSync(agentB, { recursive: true });

      const idA = createExperiment(agentA, 'alpha', 'ctr', 'hypothesis A');
      createExperiment(agentB, 'beta', 'ctr', 'hypothesis B');
      runExperiment(agentA, idA); // moves idA to 'running'; beta's stays 'proposed'

      const running = listAllExperiments(frameworkRoot, '', { status: 'running' });
      expect(running).toHaveLength(1);
      expect(running[0].agent).toBe('alpha');
    });

    it('returns empty, not throws, when frameworkRoot has no orgs directory yet', () => {
      const emptyRoot = join(tmpdir(), `cortextos-empty-${Date.now()}`);
      expect(listAllExperiments(emptyRoot, '')).toEqual([]);
    });
  });
});
