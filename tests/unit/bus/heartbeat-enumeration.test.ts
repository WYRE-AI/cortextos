import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readAllHeartbeats, readAllHeartbeatRows } from '../../../src/bus/heartbeat.js';
import type { BusPaths } from '../../../src/types/index.js';

// `readAllHeartbeats` enumerates SUBDIRECTORIES OF state/ and consults no roster at
// all, so "which agents exist" is answered by a filesystem artifact:
//   - a state dir with no roster entry is reported as an agent (orphan -> phantom);
//   - a roster agent that has never beaten has no state dir, so it is ABSENT from the
//     output rather than flagged. Absence reads as "no such agent", not as a gap.
//
// EVERY FIXTURE BELOW IS SYNTHESISED. The never-beaten class does not exist in either
// live instance on this machine (roster-minus-state is empty in `default` AND in
// `wyre-gateway`), so a fixture sampled from live config is blind to exactly the case
// this function gets wrong. Sampling would have produced a green suite over a real bug.
describe('readAllHeartbeatRows — dual enumeration (roster UNION state)', () => {
  let ctxRoot: string;
  let frameworkRoot: string;
  let paths: BusPaths;
  const prevFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;

  const mkPaths = (root: string): BusPaths => ({
    ctxRoot: root,
    inbox: join(root, 'inbox'),
    inflight: join(root, 'inflight'),
    processed: join(root, 'processed'),
    logDir: join(root, 'logs'),
    stateDir: join(root, 'state', 'caller'),
    taskDir: join(root, 'tasks'),
    approvalDir: join(root, 'approvals'),
    analyticsDir: join(root, 'analytics'),
    deliverablesDir: join(root, 'deliverables'),
  });

  /** Give an agent a state dir with a heartbeat — i.e. it has beaten at least once. */
  const beat = (agent: string, over: Record<string, unknown> = {}) => {
    const d = join(ctxRoot, 'state', agent);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'heartbeat.json'), JSON.stringify({
      agent, org: 'testorg', status: 'online', current_task: '',
      mode: 'day', last_heartbeat: '2026-08-16T12:00:00Z', loop_interval: '', ...over,
    }));
  };

  /** Put an agent in the roster (dir scan + enabled-agents.json), WITHOUT a heartbeat. */
  const enroll = (agent: string, enabled = true) => {
    mkdirSync(join(frameworkRoot, 'orgs', 'testorg', 'agents', agent), { recursive: true });
    const f = join(ctxRoot, 'config', 'enabled-agents.json');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    let roster: Record<string, unknown> = {};
    try { roster = JSON.parse(readFileSync(f, 'utf-8')); } catch { /* first write */ }
    roster[agent] = { enabled, status: 'configured', org: 'testorg' };
    writeFileSync(f, JSON.stringify(roster));
  };

  const byName = (rows: Awaited<ReturnType<typeof readAllHeartbeatRows>>, n: string) =>
    rows.find(r => r.agent === n);

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'hb-enum-'));
    frameworkRoot = mkdtempSync(join(tmpdir(), 'hb-fw-'));
    process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
    paths = mkPaths(ctxRoot);
  });

  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
    rmSync(frameworkRoot, { recursive: true, force: true });
    if (prevFrameworkRoot === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
    else process.env.CTX_FRAMEWORK_ROOT = prevFrameworkRoot;
  });

  it('a normal agent (in roster AND has beaten) is source=roster+state with its heartbeat', () => {
    enroll('alpha');
    beat('alpha');
    const row = byName(readAllHeartbeatRows(paths, 'testorg'), 'alpha');
    expect(row?.source).toBe('roster+state');
    expect(row?.enabled).toBe(true);
    expect(row?.heartbeat?.last_heartbeat).toBe('2026-08-16T12:00:00Z');
  });

  // THE CASE THE CURRENT FUNCTION CANNOT REPORT. It has no state dir, so the state-dir
  // scan never reaches it and it is simply missing from the output.
  it('a roster agent that has NEVER beaten is PRESENT as source=roster-only, not absent', () => {
    enroll('never-beaten');
    const rows = readAllHeartbeatRows(paths, 'testorg');
    const row = byName(rows, 'never-beaten');
    expect(row).toBeDefined();
    expect(row?.source).toBe('roster-only');
    expect(row?.heartbeat).toBeNull();
    expect(row?.enabled).toBe(true);
  });

  it('REGRESSION: the old single-axis reader omits the never-beaten agent entirely', () => {
    enroll('never-beaten');
    beat('alpha');
    enroll('alpha');
    const old = readAllHeartbeats(paths).map(h => h.agent);
    expect(old).toContain('alpha');
    expect(old).not.toContain('never-beaten'); // the bug, pinned
  });

  // The `cortextos` row in the live `default` instance, and 5 more in `wyre-gateway`.
  it('a state dir with no roster entry is source=state-only (orphan), not a plain agent', () => {
    beat('phantom');
    const row = byName(readAllHeartbeatRows(paths, 'testorg'), 'phantom');
    expect(row?.source).toBe('state-only');
    expect(row?.enabled).toBeNull(); // unknown — it is not in the roster to have a flag
  });

  // lantern: disabled since 2026-06-10, currently rendered identically to a dead agent.
  it('a DISABLED agent is distinguishable from a dead one', () => {
    enroll('switched-off', false);
    beat('switched-off', { last_heartbeat: '2026-06-10T17:46:02Z' });
    enroll('alive-but-stale', true);
    beat('alive-but-stale', { last_heartbeat: '2026-06-10T17:46:02Z' });

    const rows = readAllHeartbeatRows(paths, 'testorg');
    expect(byName(rows, 'switched-off')?.enabled).toBe(false);
    expect(byName(rows, 'alive-but-stale')?.enabled).toBe(true);
    // Identical staleness, different meaning — the caller can now tell them apart.
    expect(byName(rows, 'switched-off')?.heartbeat?.last_heartbeat)
      .toBe(byName(rows, 'alive-but-stale')?.heartbeat?.last_heartbeat);
  });

  // The directory is the enumeration; the `agent` field is what gets displayed. Nothing
  // cross-checked them, so a mislabelled file reads as a plausible agent.
  it('flags a heartbeat whose agent field disagrees with its directory name', () => {
    beat('cortextos', { agent: 'warden' });
    const row = byName(readAllHeartbeatRows(paths, 'testorg'), 'cortextos');
    expect(row?.agent).toBe('cortextos');       // keyed on the DIRECTORY, authoritative
    expect(row?.nameMismatch).toBe('warden');   // and the disagreement is surfaced
  });

  it('non-agent state dirs without a heartbeat.json are not reported as agents', () => {
    mkdirSync(join(ctxRoot, 'state', 'oauth'), { recursive: true });
    mkdirSync(join(ctxRoot, 'state', 'usage'), { recursive: true });
    enroll('alpha'); beat('alpha');
    const names = readAllHeartbeatRows(paths, 'testorg').map(r => r.agent);
    expect(names).toContain('alpha');
    expect(names).not.toContain('oauth');
    expect(names).not.toContain('usage');
  });

  // A corrupt file must not vanish silently — that is the same "absence reads as healthy"
  // failure as the never-beaten case.
  it('a corrupt heartbeat.json is REPORTED, not silently skipped', () => {
    mkdirSync(join(ctxRoot, 'state', 'broken'), { recursive: true });
    writeFileSync(join(ctxRoot, 'state', 'broken', 'heartbeat.json'), '{not json');
    const row = byName(readAllHeartbeatRows(paths, 'testorg'), 'broken');
    expect(row).toBeDefined();
    expect(row?.unreadable).toBe(true);
    expect(row?.heartbeat).toBeNull();
  });

  it('an absent state directory yields roster rows rather than throwing', () => {
    enroll('alpha');
    const rows = readAllHeartbeatRows(paths, 'testorg');
    expect(rows.map(r => r.agent)).toEqual(['alpha']);
    expect(rows[0].source).toBe('roster-only');
  });

  // The roster has TWO halves and they are scoped differently: enabled-agents.json is
  // per-instance, but the directory scan is global (CTX_FRAMEWORK_ROOT). Sweeping several
  // instances with no org therefore imports one instance's agents into another's report,
  // where they surface as confident "NEVER BEATEN" rows for agents that do not belong to
  // it at all. Caught on a live --all-instances run, not by the suite above.
  it('scoping by org keeps another org\'s agents out of this instance\'s report', () => {
    mkdirSync(join(frameworkRoot, 'orgs', 'otherorg', 'agents', 'stranger'), { recursive: true });
    enroll('mine');

    const scoped = readAllHeartbeatRows(paths, 'testorg').map(r => r.agent);
    expect(scoped).toContain('mine');
    expect(scoped).not.toContain('stranger');

    // Unscoped is the contaminated reading the sweep produced.
    expect(readAllHeartbeatRows(paths).map(r => r.agent)).toContain('stranger');
  });

  it('accepts several orgs for one instance and unions them without duplicating', () => {
    mkdirSync(join(frameworkRoot, 'orgs', 'otherorg', 'agents', 'stranger'), { recursive: true });
    enroll('mine');
    beat('mine');
    const rows = readAllHeartbeatRows(paths, ['testorg', 'otherorg']);
    expect(rows.map(r => r.agent)).toEqual(['mine', 'stranger']);
    expect(rows.filter(r => r.agent === 'mine')).toHaveLength(1);
  });

  it('rows are stable-sorted by agent name so output diffs are readable', () => {
    enroll('zeta'); beat('zeta');
    enroll('alpha'); beat('alpha');
    beat('mid-orphan');
    expect(readAllHeartbeatRows(paths, 'testorg').map(r => r.agent))
      .toEqual(['alpha', 'mid-orphan', 'zeta']);
  });
});
