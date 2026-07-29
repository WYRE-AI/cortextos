import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { signAppJwt, findInstallation, mintInstallationToken, shouldRefuseInteractivePrint, redactForJson } = await import('../../../src/bus/github-app.js');

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const TEST_KEY = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('signAppJwt', () => {
  it('produces a 3-part RS256 JWT with the app id as issuer', () => {
    const jwt = signAppJwt('12345', TEST_KEY, 1_700_000_000);
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);

    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(payload.iss).toBe('12345');
    expect(payload.iat).toBe(1_700_000_000 - 60);
    expect(payload.exp).toBe(1_700_000_000 + 540);
  });
});

describe('findInstallation', () => {
  it('matches the installation by org login, case-insensitively', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([
      { id: 111, account: { login: 'some-other-org' }, repository_selection: 'all' },
      { id: 147038752, account: { login: 'wyre-technology' }, repository_selection: 'all' },
    ]));

    const result = await findInstallation('fake-jwt', 'Wyre-Technology');
    expect(result).toEqual({ id: 147038752, account_login: 'wyre-technology', repository_selection: 'all' });
  });

  it('throws when no installation exists for the org', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]));
    await expect(findInstallation('fake-jwt', 'wyre-technology')).rejects.toThrow(/No installation found/);
  });

  it('throws with the response body on a non-ok GitHub response', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ message: 'Bad credentials' }, false, 401));
    await expect(findInstallation('fake-jwt', 'wyre-technology')).rejects.toThrow(/401/);
  });
});

describe('shouldRefuseInteractivePrint', () => {
  it('refuses when stdout is a TTY and --force was not passed', () => {
    expect(shouldRefuseInteractivePrint(true, false)).toBe(true);
  });

  it('allows when --force overrides an interactive TTY', () => {
    expect(shouldRefuseInteractivePrint(true, true)).toBe(false);
  });

  it('allows when stdout is piped/captured (not a TTY), regardless of --force', () => {
    expect(shouldRefuseInteractivePrint(false, false)).toBe(false);
    expect(shouldRefuseInteractivePrint(false, true)).toBe(false);
  });
});

describe('redactForJson', () => {
  it('never includes the raw token, even via key enumeration', () => {
    const result = {
      token: 'ghs_super_secret_value',
      expires_at: '2026-07-17T23:00:00Z',
      org: 'wyre-technology',
      installation_id: 147038752,
    };
    const redacted = redactForJson(result);
    expect(redacted).toEqual({
      expires_at: '2026-07-17T23:00:00Z',
      org: 'wyre-technology',
      installation_id: 147038752,
    });
    expect(Object.keys(redacted)).not.toContain('token');
    expect(JSON.stringify(redacted)).not.toContain('ghs_super_secret_value');
  });
});

describe('mintInstallationToken', () => {
  it('signs a JWT, resolves the installation, then exchanges for an access token', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse([
        { id: 147038752, account: { login: 'wyre-technology' }, repository_selection: 'all' },
      ]))
      .mockResolvedValueOnce(jsonResponse({ token: 'ghs_minted123', expires_at: '2026-07-17T23:00:00Z' }));

    const result = await mintInstallationToken('4317194', TEST_KEY, 'wyre-technology');

    expect(result).toEqual({
      token: 'ghs_minted123',
      expires_at: '2026-07-17T23:00:00Z',
      org: 'wyre-technology',
      installation_id: 147038752,
    });

    // Second call is the POST to mint the token, against the resolved installation id
    const [url, init] = mockFetch.mock.calls[1];
    expect(url).toBe('https://api.github.com/app/installations/147038752/access_tokens');
    expect(init.method).toBe('POST');
  });
});
