// src/daemon/account-preflight.ts
// Default preflight for the rotation manager: a one-word OPUS inference ping.
// Opus because limits are model-bucketed — a haiku pass proves nothing about
// the bucket the fleet burns. The usage API is NOT an option: setup-tokens
// (sk-ant-oat01) lack the user:profile scope and 403.

import { execFile } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { PreflightResult } from './rotation-manager.js';

const PREFLIGHT_TIMEOUT_MS = 3 * 60_000;
const FLEET_MODEL = 'claude-opus-4-8';

export function classifyPreflightOutput(exitCode: number, output: string): PreflightResult {
  if (/hit your .*limit/i.test(output)) return 'limit';
  return exitCode === 0 ? 'ok' : 'error';
}

export function preflightAccount(accessToken: string): Promise<PreflightResult> {
  return new Promise((resolve) => {
    // Isolated config dir: never let the daemon's keychain login answer for the token.
    const configDir = mkdtempSync(join(tmpdir(), 'ctx-preflight-'));
    const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: accessToken, CLAUDE_CONFIG_DIR: configDir };
    execFile('claude', ['-p', 'reply with exactly: ok', '--model', FLEET_MODEL],
      { env, timeout: PREFLIGHT_TIMEOUT_MS },
      (err, stdout, stderr) => {
        try { rmSync(configDir, { recursive: true, force: true }); } catch { /* ignore */ }
        const code = err ? ((err as { code?: number }).code ?? 1) : 0;
        resolve(classifyPreflightOutput(typeof code === 'number' ? code : 1, `${stdout}\n${stderr}`));
      });
  });
}
