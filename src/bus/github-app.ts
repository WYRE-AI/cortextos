import { createSign } from 'node:crypto';

export interface Installation {
  id: number;
  account_login: string;
  repository_selection: 'all' | 'selected';
}

export interface MintTokenResult {
  token: string;
  expires_at: string;
  org: string;
  installation_id: number;
}

/**
 * A pipe/capture ($(...), file redirect) is never a TTY, so this only
 * blocks the token from landing directly in a visible terminal/session
 * transcript when the command is run bare — it never affects the
 * intended `GH_TOKEN=$(cortextos bus gh-app-token)` usage.
 */
export function shouldRefuseInteractivePrint(isStdoutTTY: boolean, force: boolean): boolean {
  return isStdoutTTY && !force;
}

/**
 * Metadata-only view of a mint result, safe for --json output. --json is
 * commonly captured into logs/CI artifacts (unlike plain-mode stdout,
 * which is meant for immediate single-use `$(...)` capture), so it must
 * never include the raw token.
 */
export function redactForJson(result: MintTokenResult): Omit<MintTokenResult, 'token'> {
  const { expires_at, org, installation_id } = result;
  return { expires_at, org, installation_id };
}

function b64url(input: string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Signs a short-lived (10min) RS256 JWT authenticating as the GitHub App
 * itself (not any installation) — required to mint installation tokens.
 */
export function signAppJwt(appId: string, privateKey: string, now = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  // iat backdated 60s for clock drift tolerance; GitHub caps exp at 10min.
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const unsigned = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${unsigned}.${signature}`;
}

async function githubApi(jwt: string, path: string, init: { method?: string } = {}): Promise<Response> {
  const response = await fetch(`https://api.github.com${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${path} returned ${response.status}: ${await response.text()}`);
  }
  return response;
}

/**
 * Looks up the App's installation on a given org login. Each org install
 * has its own installation_id — there is no fleet-wide id to hardcode.
 */
export async function findInstallation(jwt: string, orgLogin: string): Promise<Installation> {
  const response = await githubApi(jwt, '/app/installations');
  const installations = await response.json() as Array<{
    id: number;
    account: { login: string };
    repository_selection: 'all' | 'selected';
  }>;
  const match = installations.find((i) => i.account.login.toLowerCase() === orgLogin.toLowerCase());
  if (!match) {
    throw new Error(`No installation found for org "${orgLogin}" — has the App been installed there?`);
  }
  return { id: match.id, account_login: match.account.login, repository_selection: match.repository_selection };
}

/**
 * Mints a fresh ~1h installation access token. Callers should mint one
 * per invocation rather than caching across long-running sessions —
 * simpler and safer than a refresh loop, and cheap given gh CLI calls
 * are infrequent bursts, not a continuous stream.
 */
export async function mintInstallationToken(
  appId: string,
  privateKey: string,
  org: string,
): Promise<MintTokenResult> {
  const jwt = signAppJwt(appId, privateKey);
  const installation = await findInstallation(jwt, org);
  const response = await githubApi(jwt, `/app/installations/${installation.id}/access_tokens`, { method: 'POST' });
  const data = await response.json() as { token: string; expires_at: string };
  return {
    token: data.token,
    expires_at: data.expires_at,
    org: installation.account_login,
    installation_id: installation.id,
  };
}
