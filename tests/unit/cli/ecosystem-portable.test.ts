import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import { buildEcosystemConfig } from '../../../src/cli/ecosystem';

// Night-queue audit fix (task_1783987166988): `cortextos ecosystem` used to
// OVERWRITE the portable tracked template with machine-baked absolute paths —
// every setup run (setup.ts auto-runs it) dirtied the checkout, and
// .gitignore listed the already-tracked file (inert). The generator now EMITS
// the portable template itself: all machine-specific resolution (paths,
// platform, dashboard presence) happens at LOAD time inside the emitted JS,
// so generation is pure + idempotent and the checkout stays clean.

const require_ = createRequire(import.meta.url);

function loadConfig(content: string, dir: string, env: Record<string, string | undefined> = {}) {
  const file = join(dir, `ecosystem-${Math.random().toString(36).slice(2)}.config.js`);
  writeFileSync(file, content, 'utf-8');
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    delete require_.cache[require_.resolve(file)];
    return require_(file);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('buildEcosystemConfig — portable, idempotent emission', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('emits ZERO generate-time machine paths — all resolution is load-time', () => {
    const content = buildEcosystemConfig({ instance: 'default', org: '' });
    // No absolute path from THIS machine may appear.
    expect(content).not.toContain(process.cwd());
    expect(content).not.toMatch(/\/Users\/|\/home\/|C:\\\\/);
    // The load-time resolution idioms must.
    expect(content).toContain("process.env.CTX_FRAMEWORK_ROOT || __dirname");
    expect(content).toContain("path.join(os.homedir(), '.cortextos', INSTANCE_ID)");
  });

  it('is idempotent: same options → byte-identical output', () => {
    const a = buildEcosystemConfig({ instance: 'default', org: '' });
    const b = buildEcosystemConfig({ instance: 'default', org: '' });
    expect(a).toBe(b);
  });

  it('DRIFT GUARD: default-options output IS the tracked ecosystem.config.js, byte-for-byte', () => {
    const tracked = readFileSync(join(__dirname, '../../../ecosystem.config.js'), 'utf-8');
    expect(buildEcosystemConfig({ instance: 'default', org: '' })).toBe(tracked);
  });

  it('emitted config LOADS and resolves the daemon script relative to its own location', () => {
    // realpathSync: require() canonicalizes macOS /var -> /private/var symlinks,
    // so __dirname inside the loaded config is the REAL path of the temp dir.
    dir = mkdtempSync(join(tmpdir(), 'eco-portable-'));
    const real = realpathSync(dir);
    const cfg = loadConfig(buildEcosystemConfig({ instance: 'default', org: '' }), dir, {
      CTX_FRAMEWORK_ROOT: undefined,
      CTX_INSTANCE_ID: undefined,
      CTX_ROOT: undefined,
      CTX_ORG: undefined,
    });
    const daemon = cfg.apps.find((a: any) => a.name === 'cortextos-daemon');
    expect(daemon).toBeDefined();
    expect(daemon.script).toBe(join(real, 'dist', 'daemon.js'));
    expect(daemon.cwd).toBe(real);
    expect(daemon.env.CTX_FRAMEWORK_ROOT).toBe(real);
  });

  it('emitted config instance-suffixes the pm2 name at LOAD time (env wins over baked default)', () => {
    dir = mkdtempSync(join(tmpdir(), 'eco-portable-'));
    const cfg = loadConfig(buildEcosystemConfig({ instance: 'default', org: '' }), dir, {
      CTX_INSTANCE_ID: 'wyre-gateway',
      CTX_FRAMEWORK_ROOT: undefined,
      CTX_ROOT: undefined,
    });
    expect(cfg.apps[0].name).toBe('cortextos-daemon-wyre-gateway');
    expect(cfg.apps[0].env.CTX_INSTANCE_ID).toBe('wyre-gateway');
  });

  it('bakes instance/org OPTIONS as load-time fallback values only (not paths)', () => {
    dir = mkdtempSync(join(tmpdir(), 'eco-portable-'));
    const cfg = loadConfig(buildEcosystemConfig({ instance: 'acme-inst', org: 'acme' }), dir, {
      CTX_INSTANCE_ID: undefined,
      CTX_ORG: undefined,
      CTX_FRAMEWORK_ROOT: undefined,
      CTX_ROOT: undefined,
    });
    expect(cfg.apps[0].name).toBe('cortextos-daemon-acme-inst');
    expect(cfg.apps[0].env.CTX_ORG).toBe('acme');
  });

  it('includes the dashboard app at LOAD time only when dashboard/package.json exists next to the config', () => {
    dir = mkdtempSync(join(tmpdir(), 'eco-portable-'));
    const content = buildEcosystemConfig({ instance: 'default', org: '' });
    const without = loadConfig(content, dir, { CTX_FRAMEWORK_ROOT: undefined });
    expect(without.apps.some((a: any) => a.name === 'cortextos-dashboard')).toBe(false);

    mkdirSync(join(dir, 'dashboard'), { recursive: true });
    writeFileSync(join(dir, 'dashboard', 'package.json'), '{}', 'utf-8');
    const withDash = loadConfig(content, dir, { CTX_FRAMEWORK_ROOT: undefined });
    expect(withDash.apps.some((a: any) => a.name === 'cortextos-dashboard')).toBe(true);
  });
});
