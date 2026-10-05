/**
 * tests/integration/bus-create-experiment-cycle-defaults-cli.test.ts
 *
 * Regression test for task_1788740438657_41016651: `create-experiment`'s
 * --direction/--window/--kind flags declared commander-level defaults
 * ('higher'/'24h'/'intervention'), which means commander ALWAYS populates
 * opts.direction/opts.window/opts.kind even when the flag is omitted on the
 * real CLI invocation. createExperiment()'s own fallback chain
 * (options?.direction ?? cycleDefaults.direction ?? 'higher') could
 * therefore never reach cycleDefaults through the real call path — a cycle
 * registered with direction=lower/window=14d in experiments/config.json
 * was silently overridden back to higher/24h on every create-experiment
 * call that didn't pass the flag explicitly.
 *
 * This has to drive the actual compiled CLI as a subprocess (not just
 * createExperiment() directly, which already correctly falls back to
 * cycleDefaults when called as a plain function) — the bug lives
 * specifically in the commander option-parsing layer the unit tests for
 * createExperiment() never exercise.
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
let agentDir: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "create-experiment-cycle-cli-"));
  agentDir = mkdtempSync(join(tmpdir(), "create-experiment-cycle-agentdir-"));
  mkdirSync(join(agentDir, "experiments", "history"), { recursive: true });
});

afterEach(() => {
  for (const dir of [fakeHome, agentDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function writeCycleConfig(cycle: Record<string, unknown>): void {
  writeFileSync(
    join(agentDir, "experiments", "config.json"),
    JSON.stringify({ cycles: [cycle] }),
  );
}

async function runCreateExperiment(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fakeHome,
    CTX_AGENT_NAME: "testbot",
    // No CTX_FRAMEWORK_ROOT/CTX_ORG/CTX_PROJECT_ROOT — resolveEnv() then
    // leaves agentDir empty and the CLI action falls back to
    // `env.agentDir || process.cwd()`, i.e. the subprocess's cwd below.
  };
  delete env.CTX_FRAMEWORK_ROOT;
  delete env.CTX_ORG;
  delete env.CTX_PROJECT_ROOT;
  delete env.CTX_AGENT_DIR;
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [DIST_CLI, "bus", "create-experiment", ...args],
      { env, cwd: agentDir },
    );
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: typeof e.code === "number" ? e.code : 1 };
  }
}

function readExperiment(id: string): Record<string, unknown> {
  const path = join(agentDir, "experiments", "history", `${id}.json`);
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe.skipIf(!existsSync(DIST_CLI))(
  "create-experiment CLI — --direction/--window/--kind cycle-defaults fallback (task_1788740438657_41016651)",
  () => {
    it("picks up the matching cycle's direction/window when the flags are omitted", async () => {
      writeCycleConfig({
        name: "pr_review_cycles",
        agent: "testbot",
        metric: "pr_review_latency",
        metric_type: "quantitative",
        surface: "",
        direction: "lower",
        window: "14d",
        measurement: "",
        loop_interval: "7d",
        enabled: true,
        created_by: "testbot",
        created_at: "2026-01-01T00:00:00Z",
      });

      const { stdout, code } = await runCreateExperiment([
        "pr_review_latency",
        "Fewer review cycles per PR",
        "--baseline", "0.323",
      ]);
      expect(code).toBe(0);
      const id = stdout.trim().split("\n")[0];

      const exp = readExperiment(id);
      // Before the fix: commander's own 'higher'/'24h' defaults always won,
      // so this read back direction="higher", window="24h" regardless of
      // the registered cycle — silently inverting the eventual keep/discard
      // call and closing the measurement window 14 days early.
      expect(exp.direction).toBe("lower");
      expect(exp.window).toBe("14d");
    });

    it("an explicit --direction/--window still overrides the cycle (explicit always wins)", async () => {
      writeCycleConfig({
        name: "pr_review_cycles",
        agent: "testbot",
        metric: "pr_review_latency",
        metric_type: "quantitative",
        surface: "",
        direction: "lower",
        window: "14d",
        measurement: "",
        loop_interval: "7d",
        enabled: true,
        created_by: "testbot",
        created_at: "2026-01-01T00:00:00Z",
      });

      const { stdout, code } = await runCreateExperiment([
        "pr_review_latency",
        "Ad-hoc override of the registered cycle",
        "--baseline", "0.1",
        "--direction", "higher",
        "--window", "48h",
      ]);
      expect(code).toBe(0);
      const id = stdout.trim().split("\n")[0];

      const exp = readExperiment(id);
      expect(exp.direction).toBe("higher");
      expect(exp.window).toBe("48h");
    });

    it("falls back to the static higher/24h/intervention defaults when no cycle matches (unchanged behavior for non-cycle experiments)", async () => {
      const { stdout, code } = await runCreateExperiment([
        "some_adhoc_metric",
        "No registered cycle for this metric",
        "--baseline", "1",
      ]);
      expect(code).toBe(0);
      const id = stdout.trim().split("\n")[0];

      const exp = readExperiment(id);
      expect(exp.direction).toBe("higher");
      expect(exp.window).toBe("24h");
      expect(exp.kind).toBe("intervention");
    });
  },
);
