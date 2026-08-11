import { defineConfig } from 'tsup';
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';

export default defineConfig({
  entry: {
    cli: 'src/cli/index.ts',
    daemon: 'src/daemon/index.ts',
    'hooks/hook-permission-telegram': 'src/hooks/hook-permission-telegram.ts',
    'hooks/hook-ask-telegram': 'src/hooks/hook-ask-telegram.ts',
    'hooks/hook-planmode-telegram': 'src/hooks/hook-planmode-telegram.ts',
    'hooks/hook-crash-alert': 'src/hooks/hook-crash-alert.ts',
    'hooks/hook-compact-telegram': 'src/hooks/hook-compact-telegram.ts',
    'hooks/hook-extract-facts': 'src/hooks/hook-extract-facts.ts',
    'hooks/hook-idle-flag': 'src/hooks/hook-idle-flag.ts',
    'hooks/hook-activity-beat': 'src/hooks/hook-activity-beat.ts',
    'hooks/hook-context-status': 'src/hooks/hook-context-status.ts',
    'hooks/hook-loop-detector': 'src/hooks/hook-loop-detector.ts',
    'hooks/hook-subagent-priming': 'src/hooks/hook-subagent-priming.ts',
  },
  format: ['cjs'],
  target: 'node20',
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: false,
  shims: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  external: ['node-pty'],
  // task_1785551337187: dist/ is gitignored — before this, there was no way
  // to determine after the fact which commit a running daemon process's
  // in-memory code came from, short of correlating OS process-start
  // timestamps against git log by hand (see the 2026-08-01 daemon-restart
  // reconciliation, docs/runbook/daemon-restart-2026-08.md appendix, for
  // the specific case this made genuinely unresolvable). Stamp git HEAD +
  // build time into dist/ so it's a lookup instead of a forensic
  // reconstruction. Best-effort: a build must never fail just because git
  // info isn't available (e.g. building from a tarball without a .git dir).
  onSuccess: async () => {
    try {
      const gitSha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
      const manifest = {
        gitSha,
        builtAt: new Date().toISOString(),
      };
      writeFileSync(join('dist', 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    } catch {
      // best-effort; missing git info shouldn't fail the build
    }
  },
});
