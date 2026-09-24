/**
 * tests/integration/bus-gh-bot-wrapper.test.ts
 *
 * Coverage for bus/gh-bot.sh — the wrapper that mints a GitHub App
 * installation token via `cortextos bus gh-app-token` and execs `gh` with
 * GH_TOKEN set, so fleet-automation pushes/PRs authenticate as the bot
 * instead of silently falling back to whatever personal account is logged
 * into `gh` on a shared dev Mac (task_1790243111192 / task_1790243596388).
 *
 * `cortextos`, `cortex-secret`, and `gh` are all faked on PATH — this test
 * exercises the wrapper's own arg-parsing / org-detection / error-handling
 * logic, not the real token-minting flow (already covered by
 * tests/unit/bus/github-app.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(__dirname, "..", "..");
const WRAPPER = join(REPO_ROOT, "bus", "gh-bot.sh");

let workDir: string;
let fakeBin: string;
let fakeRepo: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "gh-bot-wrapper-"));
  fakeBin = join(workDir, "bin");
  mkdirSync(fakeBin, { recursive: true });
  fakeRepo = join(workDir, "repo");
  mkdirSync(fakeRepo, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function writeFakeExe(name: string, script: string): void {
  const p = join(fakeBin, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${script}\n`);
  chmodSync(p, 0o755);
}

async function initGitRepo(remoteUrl: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd: fakeRepo });
  await execFileAsync("git", ["remote", "add", "origin", remoteUrl], {
    cwd: fakeRepo,
  });
}

// Fake cortex-secret: forwards to whatever follows "--", same as the real
// `cortex-secret run --context <ctx> -- <cmd...>` shape.
const FAKE_CORTEX_SECRET = `
while [[ "$1" != "--" ]]; do shift; done
shift
exec "$@"
`;

// Fake cortextos: answers `bus gh-app-token --org <org>` with `token`,
// otherwise fails loudly so an unexpected invocation shows up in the test.
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

async function runWrapper(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("bash", [WRAPPER, ...args], {
      cwd,
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
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

describe.skipIf(!existsSync(WRAPPER))("bus/gh-bot.sh wrapper", () => {
  it("derives --org from the origin remote and forwards args to gh with GH_TOKEN set", async () => {
    await initGitRepo("git@github.com:WYRE-AI/conduit.git");
    writeFakeExe("cortextos", fakeGhAppToken("WYRE-AI", "fake-app-token-123"));
    writeFakeExe("cortex-secret", FAKE_CORTEX_SECRET);
    writeFakeExe(
      "gh",
      `
echo "GH_TOKEN=$GH_TOKEN"
echo "ARGS: $*"
`,
    );

    const { stdout, code } = await runWrapper(
      ["pr", "create", "--title", "x"],
      fakeRepo,
    );
    expect(code).toBe(0);
    expect(stdout).toContain("GH_TOKEN=fake-app-token-123");
    expect(stdout).toContain("ARGS: pr create --title x");
  });

  it("uses an explicit --org over remote detection (e.g. wyre-technology default vs WYRE-AI)", async () => {
    await initGitRepo("git@github.com:wyre-technology/cortextos.git");
    writeFakeExe("cortextos", fakeGhAppToken("WYRE-AI", "explicit-org-token"));
    writeFakeExe("cortex-secret", FAKE_CORTEX_SECRET);
    writeFakeExe("gh", `echo "GH_TOKEN=$GH_TOKEN"`);

    const { stdout, code } = await runWrapper(
      ["--org", "WYRE-AI", "pr", "list"],
      fakeRepo,
    );
    expect(code).toBe(0);
    expect(stdout).toContain("GH_TOKEN=explicit-org-token");
  });

  it("fails loudly when the org cannot be determined", async () => {
    // fakeRepo has no git remote at all (not even git-initialized)
    const { code, stderr } = await runWrapper(["pr", "list"], fakeRepo);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/could not determine the org/);
  });

  it("forces git-level pushes onto HTTPS with the bot token, even over an SSH origin", async () => {
    // `gh pr create` can push via system `git`, which authenticates
    // per the origin's protocol -- an SSH origin (this repo's own real
    // default) would otherwise push with the local SSH key, not the bot
    // token. The wrapper must hand `gh`'s child `git` process env-scoped
    // config that redirects github.com SSH URLs to HTTPS and attaches the
    // token as an Authorization header (verified end-to-end with a real
    // `git ls-remote` + GIT_TRACE against a fake SSH origin in a separate,
    // non-mocked check; here we assert the wrapper actually sets it).
    await initGitRepo("git@github.com:WYRE-AI/conduit.git");
    writeFakeExe("cortextos", fakeGhAppToken("WYRE-AI", "push-safe-token"));
    writeFakeExe("cortex-secret", FAKE_CORTEX_SECRET);
    writeFakeExe(
      "gh",
      `
echo "GIT_CONFIG_COUNT=$GIT_CONFIG_COUNT"
echo "GIT_CONFIG_KEY_0=$GIT_CONFIG_KEY_0"
echo "GIT_CONFIG_VALUE_0=$GIT_CONFIG_VALUE_0"
echo "GIT_CONFIG_KEY_1=$GIT_CONFIG_KEY_1"
echo "GIT_CONFIG_VALUE_1=$GIT_CONFIG_VALUE_1"
`,
    );

    const { stdout, code } = await runWrapper(
      ["pr", "create", "--title", "x"],
      fakeRepo,
    );
    expect(code).toBe(0);
    expect(stdout).toContain("GIT_CONFIG_COUNT=2");
    expect(stdout).toContain(
      "GIT_CONFIG_KEY_0=url.https://github.com/.insteadOf",
    );
    expect(stdout).toContain("GIT_CONFIG_VALUE_0=git@github.com:");
    expect(stdout).toContain(
      "GIT_CONFIG_KEY_1=http.https://github.com/.extraheader",
    );
    expect(stdout).toContain("GIT_CONFIG_VALUE_1=AUTHORIZATION: basic ");
    // The token must actually be in the header (base64 of
    // x-access-token:push-safe-token), not just any header.
    const expectedAuth = Buffer.from("x-access-token:push-safe-token").toString(
      "base64",
    );
    expect(stdout).toContain(expectedAuth);
  });

  it("fails loudly, and never runs gh, when token minting fails", async () => {
    await initGitRepo("git@github.com:WYRE-AI/conduit.git");
    writeFakeExe("cortextos", `echo "boom: bad creds" >&2; exit 1`);
    writeFakeExe("cortex-secret", FAKE_CORTEX_SECRET);
    writeFakeExe("gh", `echo "should not run"`);

    const { code, stderr, stdout } = await runWrapper(
      ["pr", "list"],
      fakeRepo,
    );
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/failed to mint/);
    expect(stdout).not.toContain("should not run");
  });
});
