/**
 * tests/unit/cli/bus-list-experiments-format.test.ts
 *
 * `list-experiments` was the one list-* command using a vestigial `--json`
 * boolean (never actually read in the action body — output was always JSON
 * regardless) instead of the `--format <fmt>` convention `list-tasks` and
 * `list-agents` both use. Docs/skills referencing `--format json` on this
 * command failed with `error: unknown option '--format'`
 * (task_1787846430357_63858939). This covers the fix: `--format text|json`,
 * default `json` (matching prior always-JSON behavior).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createExperiment } from '../../../src/bus/experiment';

let agentDir: string;
const originalAgentDir = process.env.CTX_AGENT_DIR;
const originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
const TEST_AGENT = 'boris';

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'bus-list-experiments-test-'));
  mkdirSync(join(agentDir, 'experiments', 'history'), { recursive: true });
  process.env.CTX_AGENT_DIR = agentDir;
  // No CTX_FRAMEWORK_ROOT — exercises the env.agentDir-only branch (no
  // --agent flag), same as running list-experiments from an agent's own dir.
  delete process.env.CTX_FRAMEWORK_ROOT;
});

afterEach(() => {
  if (originalAgentDir !== undefined) process.env.CTX_AGENT_DIR = originalAgentDir;
  else delete process.env.CTX_AGENT_DIR;
  if (originalFrameworkRoot !== undefined) process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
  else delete process.env.CTX_FRAMEWORK_ROOT;
  try { rmSync(agentDir, { recursive: true }); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

import { busCommand } from '../../../src/cli/bus';

describe('bus list-experiments --format', () => {
  it('--format json (default) prints valid JSON — prior always-JSON behavior preserved', async () => {
    createExperiment(agentDir, TEST_AGENT, 'p95_latency', 'caching helps');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'list-experiments']);

    const out = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].metric).toBe('p95_latency');
  });

  it('--format text renders a table, not JSON', async () => {
    createExperiment(agentDir, TEST_AGENT, 'p95_latency', 'caching helps');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'list-experiments', '--format', 'text']);

    const out = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(() => JSON.parse(out)).toThrow();
    expect(out).toContain('Experiments (1)');
    expect(out).toContain('p95_latency');
  });

  it('an unknown --format value falls back to json rather than erroring', async () => {
    createExperiment(agentDir, TEST_AGENT, 'p95_latency', 'caching helps');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'list-experiments', '--format', 'nonsense']);

    const out = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('--format text on an empty result says so instead of an empty table', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'list-experiments', '--format', 'text']);

    const out = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(out).toContain('No experiments found.');
  });
});
