/**
 * tests/integration/gh-shim.test.ts
 *
 * Coverage for bin/gh-shim/gh — the transparent PATH shim that
 * auto-intercepts bare `gh` calls targeting an allowlisted org (today:
 * WYRE-AI, the only org wyre-agent-fleet is installed on) and mints/caches
 * a GitHub App token instead of falling back to whatever personal `gh
 * auth` login is on this shared Mac. Follow-up to bus/gh-bot.sh (opt-in
 * sibling); see task_1790244063432.
 *
 * `cortextos`, `cortex-secret`, and the "real" `gh` are all faked on a
 * second PATH directory placed AFTER the shim, so the shim's own
 * self-exclusion logic (stripping its own dir out of PATH before
 * resolving `gh`) is exercised for real, not assumed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  existsSync,
  readFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(__dirname, "..", "..");
const SHIM = join(REPO_ROOT, "bin", "gh-shim", "gh");

let workDir: string;
let realBin: string;
let fakeRepo: string;
let ctxRoot: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "gh-shim-"));
  realBin = join(workDir, "real-bin");
  mkdirSync(realBin, { recursive: true });
  fakeRepo = join(workDir, "repo");
  mkdirSync(fakeRepo, { recursive: true });
  ctxRoot = join(workDir, "ctxroot");
  mkdirSync(ctxRoot, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function writeFakeExe(name: string, script: string): void {
  const p = join(realBin, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${script}\n`);
  chmodSync(p, 0o755);
}

async function initGitRepo(remoteUrl: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd: fakeRepo });
  await execFileAsync("git", ["remote", "add", "origin", remoteUrl], {
    cwd: fakeRepo,
  });
}

const FAKE_CORTEX_SECRET = `
while [[ "$1" != "--" ]]; do shift; done
shift
exec "$@"
`;

function fakeGhAppToken(org: string, token: string): string {
  return `
if [[ "$*" == *"gh-app-token --org ${org}"* ]]; then
  echo "${token}"
  exit 0
fi
echo "unexpected cortextos call: $*" >&2
exit 1
`;
}

async function runShim(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const shimDir = join(REPO_ROOT, "bin", "gh-shim");
  try {
    const { stdout, stderr } = await execFileAsync(SHIM, args, {
      cwd,
      env: {
        ...process.env,
        // Shim dir first (as installed), real fakes behind it — exercises
        // the shim's own self-exclusion PATH-stripping logic for real.
        PATH: `${shimDir}:${realBin}:${process.env.PATH}`,
        CTX_ROOT: ctxRoot,
      },
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

describe.skipIf(!existsSync(SHIM))("bin/gh-shim/gh", () => {
  it("fails open silently for a non-allowlisted org", async () => {
    await initGitRepo("git@github.com:some-other-org/some-repo.git");
    writeFakeExe("cortextos", `echo "should not be called" >&2; exit 1`);
    writeFakeExe("gh", `echo "REAL_GH ARGS: $*"; echo "GH_TOKEN=$GH_TOKEN"`);

    const { stdout, stderr, code } = await runShim(["pr", "list"], fakeRepo);
    expect(code).toBe(0);
    expect(stdout).toContain("REAL_GH ARGS: pr list");
    expect(stdout).toContain("GH_TOKEN=");
    expect(stdout.trim().endsWith("GH_TOKEN=")).toBe(true); // empty, not injected
    expect(stderr).toBe("");
  });

  it("fails open silently when no org can be determined at all", async () => {
    writeFakeExe("cortextos", `echo "should not be called" >&2; exit 1`);
    writeFakeExe("gh", `echo "REAL_GH ARGS: $*"`);

    // fakeRepo is not even git-initialized here.
    const { stdout, code, stderr } = await runShim(["--help"], fakeRepo);
    expect(code).toBe(0);
    expect(stdout).toContain("REAL_GH ARGS: --help");
    expect(stderr).toBe("");
  });

  it("mints a token for an allowlisted org (via --repo) and injects GH_TOKEN", async () => {
    writeFakeExe("cortextos", fakeGhAppToken("WYRE-AI", "minted-token-1"));
    writeFakeExe("cortex-secret", FAKE_CORTEX_SECRET);
    writeFakeExe("gh", `echo "GH_TOKEN=$GH_TOKEN"`);

    const { stdout, code } = await runShim(
      ["pr", "view", "123", "--repo", "WYRE-AI/conduit"],
      fakeRepo,
    );
    expect(code).toBe(0);
    expect(stdout).toContain("GH_TOKEN=minted-token-1");
  });

  it("excludes GHCR/package-registry calls from bot-token routing even for an allowlisted org", async () => {
    // The App's `packages: write` installation permission does not reliably
    // cover the same surface a personal account's package scopes do --
    // caught live 2026-09-24 (maintainer): a real
    // orgs/WYRE-AI/packages/container/.../versions query 404'd through the
    // bot token where personal auth succeeds. No attribution benefit here
    // either (a package read creates no commit/PR/comment), so this must
    // always fall through to ambient auth, regardless of org.
    await initGitRepo("git@github.com:WYRE-AI/conduit.git");
    writeFakeExe("cortextos", `echo "should not be called" >&2; exit 1`);
    writeFakeExe(
      "gh",
      `echo "REAL_GH ARGS: $*"; echo "GH_TOKEN=[$GH_TOKEN]"`,
    );

    const { stdout, stderr, code } = await runShim(
      ["api", "orgs/WYRE-AI/packages/container/conduit/versions?per_page=100"],
      fakeRepo,
    );
    expect(code).toBe(0);
    expect(stdout).toContain("GH_TOKEN=[]");
    expect(stderr).toBe("");
  });

  it("mints a token for an allowlisted org via a `gh api repos/OWNER/REPO/...` positional path (no --repo flag)", async () => {
    // The canonical no-checkout invocation shape -- e.g. querying a PR's
    // comments from a temp dir or the daemon's own cwd, never `--repo`.
    writeFakeExe("cortextos", fakeGhAppToken("WYRE-AI", "minted-token-api"));
    writeFakeExe("cortex-secret", FAKE_CORTEX_SECRET);
    writeFakeExe("gh", `echo "GH_TOKEN=$GH_TOKEN"`);

    const { stdout, code } = await runShim(
      ["api", "repos/WYRE-AI/conduit/pulls/123/comments"],
      fakeRepo, // not a git checkout at all -- only the api path can find the org
    );
    expect(code).toBe(0);
    expect(stdout).toContain("GH_TOKEN=minted-token-api");
  });

  it("mints a token for an allowlisted org via cwd's origin remote", async () => {
    await initGitRepo("git@github.com:WYRE-AI/conduit.git");
    writeFakeExe("cortextos", fakeGhAppToken("WYRE-AI", "minted-token-2"));
    writeFakeExe("cortex-secret", FAKE_CORTEX_SECRET);
    writeFakeExe("gh", `echo "GH_TOKEN=$GH_TOKEN"`);

    const { stdout, code } = await runShim(["pr", "create"], fakeRepo);
    expect(code).toBe(0);
    expect(stdout).toContain("GH_TOKEN=minted-token-2");
  });

  it("reuses a cached token on a second call instead of minting again", async () => {
    await initGitRepo("git@github.com:WYRE-AI/conduit.git");
    // Fails on a SECOND call — proves the cache was used, not a fresh mint.
    writeFakeExe(
      "cortextos",
      `
COUNT_FILE="${join(workDir, "mint-count")}"
N=$(( $(cat "$COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$N" > "$COUNT_FILE"
if [[ "$N" -gt 1 ]]; then
  echo "minted more than once" >&2
  exit 1
fi
${fakeGhAppToken("WYRE-AI", "minted-once")}
`,
    );
    writeFakeExe("cortex-secret", FAKE_CORTEX_SECRET);
    writeFakeExe("gh", `echo "GH_TOKEN=$GH_TOKEN"`);

    const first = await runShim(["pr", "list"], fakeRepo);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("GH_TOKEN=minted-once");

    const second = await runShim(["pr", "list"], fakeRepo);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("GH_TOKEN=minted-once");
  });

  it("re-mints once the cached token is past its TTL", async () => {
    await initGitRepo("git@github.com:WYRE-AI/conduit.git");
    writeFakeExe("cortextos", fakeGhAppToken("WYRE-AI", "fresh-token"));
    writeFakeExe("cortex-secret", FAKE_CORTEX_SECRET);
    writeFakeExe("gh", `echo "GH_TOKEN=$GH_TOKEN"`);

    const cacheDir = join(ctxRoot, "state", "gh-shim");
    mkdirSync(cacheDir, { recursive: true });
    // Stale by construction: epoch 0 is far outside any real TTL window.
    writeFileSync(join(cacheDir, "wyre-ai.token"), "0\nstale-token\n");

    const { stdout, code } = await runShim(["pr", "list"], fakeRepo);
    expect(code).toBe(0);
    expect(stdout).toContain("GH_TOKEN=fresh-token");
  });

  it("falls open LOUDLY (warns, still runs gh with ambient auth) when minting fails on an allowlisted org", async () => {
    await initGitRepo("git@github.com:WYRE-AI/conduit.git");
    writeFakeExe("cortextos", `echo "boom: bad creds" >&2; exit 1`);
    writeFakeExe("cortex-secret", FAKE_CORTEX_SECRET);
    writeFakeExe("gh", `echo "GH_TOKEN=[$GH_TOKEN]"`);

    const { stdout, stderr, code } = await runShim(["pr", "list"], fakeRepo);
    expect(code).toBe(0);
    expect(stderr).toMatch(/WARNING.*failed to mint/);
    expect(stdout).toContain("GH_TOKEN=[]"); // no token injected, but gh still ran
  });

  it("writes the token cache atomically (temp file + rename, no partial file left behind)", async () => {
    await initGitRepo("git@github.com:WYRE-AI/conduit.git");
    writeFakeExe("cortextos", fakeGhAppToken("WYRE-AI", "cached-token"));
    writeFakeExe("cortex-secret", FAKE_CORTEX_SECRET);
    writeFakeExe("gh", `true`);

    await runShim(["pr", "list"], fakeRepo);

    const cacheFile = join(ctxRoot, "state", "gh-shim", "wyre-ai.token");
    expect(existsSync(cacheFile)).toBe(true);
    const contents = readFileSync(cacheFile, "utf-8");
    expect(contents.split("\n")[1]).toBe("cached-token");
    // No leftover .wyre-ai.token.XXXXXX temp files from the mktemp+mv step.
    const { readdirSync } = require("fs") as typeof import("fs");
    const leftovers = readdirSync(join(ctxRoot, "state", "gh-shim")).filter(
      (f: string) => f.startsWith("."),
    );
    expect(leftovers).toEqual([]);
  });
});
