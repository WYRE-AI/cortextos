/**
 * tests/integration/kb-delete-cli.test.ts
 *
 * `kb-delete --scope` used to default to 'shared' when omitted. A KB delete
 * is a destructive ChromaDB operation with no undo, and `orgs/` (where every
 * agent's private-scope content lives) is gitignored repo-wide — there is
 * no git history to recover a delete that silently ran against the wrong
 * collection. Fixed to refuse instead of guess (task from closing
 * cortextos#130 as superseded, which had this right and #130 didn't ship).
 *
 * `kb-ingest --scope` had the identical defect (default 'shared'), flagged
 * in review as worse than delete's: a wrong-scope ingest doesn't just touch
 * the wrong collection, it silently WRITES agent-private content into the
 * shared one with no error signal. Fixed the same way, covered here too.
 *
 * Drives the real compiled CLI as a subprocess so it exercises the actual
 * gap: whether the CLI layer refuses BEFORE ever touching the knowledge
 * base, not just whether the underlying function validates.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(__dirname, "..", "..");
const DIST_CLI = join(REPO_ROOT, "dist", "cli.js");

async function runCli(
  args: string[],
  fakeHome: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [DIST_CLI, ...args],
      { env: { ...process.env, HOME: fakeHome, CTX_AGENT_NAME: "dev", CTX_ORG: "testorg" } },
    );
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

describe.skipIf(!existsSync(DIST_CLI))("bus kb-delete — --scope is required, never defaults", () => {
  it("omitting --scope refuses with exit 1, before ever touching the knowledge base", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "kb-delete-cli-"));
    try {
      const { stdout, stderr, code } = await runCli(
        ["bus", "kb-delete", "/some/file.md", "--org", "testorg"],
        fakeHome,
      );

      expect(code).toBe(1);
      expect(stderr).toContain("Invalid scope");
      expect(stderr).toContain("shared, private");
      expect(stdout).toBe("");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("an invalid --scope value refuses with exit 1, not a silent fallback", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "kb-delete-cli-"));
    try {
      const { stdout, stderr, code } = await runCli(
        ["bus", "kb-delete", "/some/file.md", "--org", "testorg", "--scope", "everything"],
        fakeHome,
      );

      expect(code).toBe(1);
      expect(stderr).toContain("Invalid scope");
      expect(stdout).toBe("");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("--scope shared passes CLI validation (proceeds to the graceful missing-config warn, not a crash)", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "kb-delete-cli-"));
    try {
      const { stderr, code } = await runCli(
        ["bus", "kb-delete", "/some/file.md", "--org", "testorg", "--scope", "shared"],
        fakeHome,
      );

      // No KB configured in this fresh fake HOME — the underlying function's
      // own graceful missing-config path handles it (warn + exit 0), which
      // proves --scope validation didn't block a legitimate value.
      expect(code).toBe(0);
      expect(stderr).not.toContain("Invalid scope");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!existsSync(DIST_CLI))("bus kb-ingest — --scope is required, never defaults", () => {
  it("omitting --scope refuses with exit 1, before ever touching the knowledge base", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "kb-ingest-cli-"));
    try {
      const { stdout, stderr, code } = await runCli(
        ["bus", "kb-ingest", "/some/file.md", "--org", "testorg"],
        fakeHome,
      );

      expect(code).toBe(1);
      expect(stderr).toContain("Invalid scope");
      expect(stdout).toBe("");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("--scope private passes CLI validation (proceeds to the graceful missing-config warn, not a crash)", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "kb-ingest-cli-"));
    try {
      const { stderr, code } = await runCli(
        ["bus", "kb-ingest", "/some/file.md", "--org", "testorg", "--scope", "private"],
        fakeHome,
      );

      expect(code).toBe(0);
      expect(stderr).not.toContain("Invalid scope");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
