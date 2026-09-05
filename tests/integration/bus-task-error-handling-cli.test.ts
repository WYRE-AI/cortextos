/**
 * tests/integration/bus-task-error-handling-cli.test.ts
 *
 * Regression test for a real crash boss hit live: `cortextos bus
 * complete-task` / `update-task` on a task ID that doesn't resolve
 * (findTaskFile returns null) threw an uncaught exception past the
 * commander action handler — a raw Node stack dump ending in the
 * "Node.js vX.Y.Z" trailer, easily mistaken for a mysterious crash
 * when the top of the dump scrolls off (e.g. piped through `tail`).
 *
 * `claim-task`'s action already wraps its call in try/catch and prints
 * a clean one-line message via console.error + process.exit(1);
 * `complete-task` and `update-task` did not. Fixed by mirroring that
 * pattern. This test drives the actual compiled CLI as a subprocess
 * (not just the underlying task.ts functions, which already throw
 * correctly by design) so it exercises the real gap: whether the CLI
 * layer catches that throw or lets it become an uncaught exception.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(__dirname, "..", "..");
const DIST_CLI = join(REPO_ROOT, "dist", "cli.js");

let fakeHome: string;
const ORG = "testorg";

beforeEach(() => {
  // resolvePaths() derives ctxRoot from os.homedir(), not CTX_ROOT — so
  // isolation for this CLI-level test means overriding HOME, not CTX_ROOT.
  fakeHome = mkdtempSync(join(tmpdir(), "bus-task-error-cli-"));
  mkdirSync(join(fakeHome, ".cortextos", "default", "orgs", ORG, "tasks"), {
    recursive: true,
  });
});

afterEach(() => {
  try {
    rmSync(fakeHome, { recursive: true });
  } catch {
    /* ignore */
  }
});

function writeTask(id: string, overrides: Record<string, unknown> = {}): void {
  const task = {
    id,
    title: "test task",
    description: "",
    type: "agent",
    needs_approval: false,
    status: "pending",
    assigned_to: "dev",
    created_by: "dev",
    org: ORG,
    priority: "normal",
    project: "",
    kpi_key: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    completed_at: null,
    due_date: null,
    archived: false,
    ...overrides,
  };
  writeFileSync(
    join(fakeHome, ".cortextos", "default", "orgs", ORG, "tasks", `${id}.json`),
    JSON.stringify(task),
  );
}

async function runCli(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return runCliWithEnv(args, { CTX_AGENT_NAME: "dev", CTX_ORG: ORG });
}

// Lets a test override or OMIT specific env vars (e.g. to test the
// missing-identity path, which needs CTX_AGENT_NAME genuinely absent —
// not just overridden to a different value).
async function runCliWithEnv(
  args: string[],
  envOverrides: Record<string, string | undefined>,
  execOpts: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: fakeHome };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [DIST_CLI, ...args],
      { env, ...execOpts },
    );
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

function readAudit(id: string): Array<{ event: string; agent: string; [k: string]: unknown }> {
  const auditPath = join(
    fakeHome,
    ".cortextos",
    "default",
    "orgs",
    ORG,
    "tasks",
    "audit",
    `${id}.jsonl`,
  );
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe.skipIf(!existsSync(DIST_CLI))(
  "bus complete-task / update-task — error handling",
  () => {
    it("complete-task on a nonexistent id exits 1 with a clean one-line message, not an uncaught-exception dump", async () => {
      const { stdout, stderr, code } = await runCli([
        "bus",
        "complete-task",
        "task_nonexistent_000",
        "--result",
        "x",
      ]);

      expect(code).toBe(1);
      expect(stderr.trim()).toBe(
        `Task task_nonexistent_000 not found in any org under ${join(fakeHome, ".cortextos", "default")}/orgs/`,
      );
      // The regression signature: an uncaught exception's dump ends with
      // this trailer line, and starts with a raw source-line + caret dump.
      // Neither should appear once the action handler catches cleanly.
      expect(stderr).not.toMatch(/Node\.js v\d/);
      expect(stderr).not.toContain("at completeTask");
      expect(stdout).toBe("");
    });

    it("update-task on a nonexistent id exits 1 with a clean one-line message, not an uncaught-exception dump", async () => {
      const { stdout, stderr, code } = await runCli([
        "bus",
        "update-task",
        "task_nonexistent_000",
        "completed",
      ]);

      expect(code).toBe(1);
      expect(stderr.trim()).toBe(
        `Task task_nonexistent_000 not found in any org under ${join(fakeHome, ".cortextos", "default")}/orgs/`,
      );
      expect(stderr).not.toMatch(/Node\.js v\d/);
      expect(stderr).not.toContain("at updateTask");
      expect(stdout).toBe("");
    });

    it("complete-task on a real task still succeeds (the fix does not swallow the happy path)", async () => {
      writeTask("task_real_001");
      const { stdout, code } = await runCli([
        "bus",
        "complete-task",
        "task_real_001",
        "--result",
        "done",
      ]);

      expect(code).toBe(0);
      expect(stdout).toContain("Completed task_real_001");
    });

    it("update-task on a real task still succeeds (the fix does not swallow the happy path)", async () => {
      writeTask("task_real_002");
      const { stdout, code } = await runCli([
        "bus",
        "update-task",
        "task_real_002",
        "in_progress",
      ]);

      expect(code).toBe(0);
      expect(stdout).toContain("Updated task_real_002 -> in_progress");
    });

    it("update-task --assignee reroutes a task without a status argument", async () => {
      writeTask("task_real_003", { assigned_to: "boss" });
      const { stdout, code } = await runCli([
        "bus",
        "update-task",
        "task_real_003",
        "--assignee",
        "dev",
      ]);

      expect(code).toBe(0);
      expect(stdout).toContain("assignee -> dev");
    });

    it("update-task --project changes the project without a status argument", async () => {
      writeTask("task_real_004");
      const { stdout, code } = await runCli([
        "bus",
        "update-task",
        "task_real_004",
        "--project",
        "conduit",
      ]);

      expect(code).toBe(0);
      expect(stdout).toContain("project -> conduit");
    });

    it("update-task with neither status nor --assignee/--project/--priority/--append-desc exits 1 with a clean message", async () => {
      writeTask("task_real_005");
      const { stdout, stderr, code } = await runCli([
        "bus",
        "update-task",
        "task_real_005",
      ]);

      expect(code).toBe(1);
      expect(stderr.trim()).toBe(
        "Nothing to update — pass a status, --assignee, --project, --priority, and/or --append-desc",
      );
      expect(stdout).toBe("");
    });

    it("update-task --priority changes the priority without a status argument", async () => {
      writeTask("task_real_006");
      const { stdout, code } = await runCli([
        "bus",
        "update-task",
        "task_real_006",
        "--priority",
        "high",
      ]);

      expect(code).toBe(0);
      expect(stdout).toContain("priority -> high");
    });

    it("update-task --priority rejects an invalid level with a clean exit 1", async () => {
      writeTask("task_real_007");
      const { stdout, stderr, code } = await runCli([
        "bus",
        "update-task",
        "task_real_007",
        "--priority",
        "nonsense",
      ]);

      expect(code).toBe(1);
      expect(stderr).toContain("Invalid priority 'nonsense'");
      expect(stdout).toBe("");
    });

    it("update-task --append-desc appends without overwriting, and without requiring a status", async () => {
      writeTask("task_real_008", { description: "Original claim." });
      const { stdout, code } = await runCli([
        "bus",
        "update-task",
        "task_real_008",
        "--append-desc",
        "Correction.",
      ]);

      expect(code).toBe(0);
      expect(stdout).toContain("description appended");
    });

    // CLI actor-resolution coverage (CodeRabbit finding on #137): the
    // underlying updateTask() function is covered directly in
    // tests/unit/bus/task.test.ts, but that never exercises the CLI's own
    // opts.agent || env.agentName resolution, its hard-fail-when-neither
    // branch, or that the resolved actor actually reaches the audit log
    // through the full `cortextos bus update-task` invocation.
    it("update-task --agent takes precedence over CTX_AGENT_NAME and is recorded as the audit actor", async () => {
      writeTask("task_actor_001", { assigned_to: "grower" });
      const { code } = await runCliWithEnv(
        ["bus", "update-task", "task_actor_001", "in_progress", "--agent", "boss"],
        { CTX_AGENT_NAME: "dev", CTX_ORG: ORG },
      );

      expect(code).toBe(0);
      const audit = readAudit("task_actor_001");
      expect(audit).toHaveLength(1);
      expect(audit[0].agent).toBe("boss");
      // The bug this PR fixes: without the --agent override, the acting
      // agent would previously have been misrecorded as the task's own
      // pre-mutation assigned_to ("grower"), not the actual caller.
      expect(audit[0].agent).not.toBe("grower");
    });

    it("update-task falls back to CTX_AGENT_NAME when --agent is omitted", async () => {
      writeTask("task_actor_002", { assigned_to: "grower" });
      const { code } = await runCliWithEnv(
        ["bus", "update-task", "task_actor_002", "in_progress"],
        { CTX_AGENT_NAME: "dev", CTX_ORG: ORG },
      );

      expect(code).toBe(0);
      const audit = readAudit("task_actor_002");
      expect(audit).toHaveLength(1);
      expect(audit[0].agent).toBe("dev");
    });

    it("update-task exits 1 with a clean message when neither --agent nor CTX_AGENT_NAME is present", async () => {
      // resolveEnv() falls back to basename(process.cwd()) when
      // CTX_AGENT_NAME is unset, which is truthy for almost any real cwd —
      // so the CLI's own guard is only reachable when that fallback ALSO
      // comes back empty. basename('/') === '' is the one real cwd value
      // that triggers it; run from cwd '/' to genuinely exercise the guard
      // rather than a case resolveEnv() silently rescues.
      writeTask("task_actor_003");
      const { stdout, stderr, code } = await runCliWithEnv(
        ["bus", "update-task", "task_actor_003", "in_progress"],
        { CTX_AGENT_NAME: undefined, CTX_ORG: ORG },
        { cwd: "/" },
      );

      expect(code).toBe(1);
      expect(stderr.trim()).toBe("ERROR: --agent or CTX_AGENT_NAME required");
      expect(stdout).toBe("");
      // No audit entry should have been written for a rejected call.
      expect(readAudit("task_actor_003")).toHaveLength(0);
    });

    it("update-task on a reassignment records the ACTING agent, not the agent losing the task", async () => {
      // Direct regression for the original defect this PR fixes: boss
      // reroutes a task away from grower. The audit's `agent` field must
      // name boss (who caused the change), not grower (who is losing it).
      writeTask("task_actor_004", { assigned_to: "grower" });
      const { code } = await runCliWithEnv(
        ["bus", "update-task", "task_actor_004", "--assignee", "dev", "--agent", "boss"],
        { CTX_AGENT_NAME: "boss", CTX_ORG: ORG },
      );

      expect(code).toBe(0);
      const audit = readAudit("task_actor_004");
      expect(audit).toHaveLength(1);
      expect(audit[0].agent).toBe("boss");
      expect(audit[0].agent).not.toBe("grower");
    });
  },
);
