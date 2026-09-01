import { execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, appendFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ensureDir } from '../utils/atomic.js';
import { TelegramAPI } from '../telegram/api.js';
import type { BusPaths, TaskStatus } from '../types/index.js';
import { discoverAllAgents, resolveAgentDir } from '../utils/agent-dir.js';
import { resolvePaths } from '../utils/paths.js';
import { sendMessage } from './message.js';
import { listTasks, checkTaskDependenciesWithStatus } from './task.js';

// --- Types ---

export interface AgentGoalStatus {
  agent: string;
  org: string;
  status: 'fresh' | 'stale' | 'missing' | 'no_timestamp' | 'parse_error';
  updated?: string;
  age_days?: number;
  stale: boolean;
  reason?: string;
}

export interface GoalStalenessReport {
  summary: { total: number; stale: number; fresh: number; threshold_days: number };
  agents: AgentGoalStatus[];
}

// --- Functions ---

/**
 * Plan a self-restart. Creates a marker file and logs the reason.
 * The daemon handles the actual restart via IPC.
 * Mirrors bash bus/self-restart.sh.
 */
export function selfRestart(paths: BusPaths, agentName: string, reason?: string): void {
  const resolvedReason = reason || 'no reason specified';

  // Create restart marker
  ensureDir(paths.stateDir);
  writeFileSync(join(paths.stateDir, '.restart-planned'), resolvedReason + '\n', 'utf-8');

  // Append to restarts.log
  ensureDir(paths.logDir);
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const logLine = `[${timestamp}] SELF-RESTART: ${resolvedReason}\n`;
  appendFileSync(join(paths.logDir, 'restarts.log'), logLine, 'utf-8');
}

/**
 * Plan a hard restart (fresh session, no --continue).
 * Creates .force-fresh marker file; daemon checks this on next restart.
 * Mirrors bash bus/hard-restart.sh.
 */
export function hardRestart(paths: BusPaths, agentName: string, reason?: string): void {
  const resolvedReason = reason || 'no reason specified';

  // Create force-fresh marker (agent-process.ts checks this on restart)
  ensureDir(paths.stateDir);
  writeFileSync(join(paths.stateDir, '.force-fresh'), resolvedReason + '\n', 'utf-8');

  // Also create restart marker so crash-alert knows it was planned
  writeFileSync(join(paths.stateDir, '.restart-planned'), resolvedReason + '\n', 'utf-8');

  // Append to restarts.log
  ensureDir(paths.logDir);
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const logLine = `[${timestamp}] HARD-RESTART: ${resolvedReason}\n`;
  appendFileSync(join(paths.logDir, 'restarts.log'), logLine, 'utf-8');
}

/**
 * Check goal staleness for all agents across all orgs.
 * Mirrors bash bus/check-goal-staleness.sh.
 *
 * task_1785723303692: previously reimplemented its own orgs/<org>/agents/*
 * scan inline, which — unlike discoverAllAgents — never covered namespaced
 * personal agents (orgs/<org>/engineers/<eng>/agents/*). A personal agent's
 * stale GOALS.md would silently never surface here. Migrated onto the same
 * canonical enumerator list-agents/list-experiments use, so this class of
 * drift is structurally impossible going forward — one enumerator, not three.
 */
export function checkGoalStaleness(
  projectRoot: string,
  thresholdDays: number = 7,
  ctxRoot?: string,
): GoalStalenessReport {
  const agents: AgentGoalStatus[] = [];
  const thresholdMs = thresholdDays * 86400 * 1000;
  const now = Date.now();

  // ctxRoot is optional for backward compatibility with existing callers/tests
  // that only ever exercised the directory-scan half; discoverAllAgents treats
  // a falsy ctxRoot as "skip the enabled-agents.json lookup", not an error.
  const discovered = discoverAllAgents(projectRoot, ctxRoot ?? '');

  for (const { name: agentName, org: orgName } of discovered) {
    const agentDir = resolveAgentDir(projectRoot, orgName, agentName);
    const goalsFile = join(agentDir, 'GOALS.md');

    if (!existsSync(goalsFile)) {
      agents.push({
        agent: agentName,
        org: orgName,
        status: 'missing',
        stale: true,
        reason: 'no GOALS.md file',
      });
      continue;
    }

    // Read and parse GOALS.md
    let content: string;
    try {
      content = readFileSync(goalsFile, 'utf-8');
    } catch {
      agents.push({
        agent: agentName,
        org: orgName,
        status: 'missing',
        stale: true,
        reason: 'could not read GOALS.md',
      });
      continue;
    }

    // Find "## Updated" section and get the next line
    const lines = content.split('\n');
    let updatedLine: string | null = null;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('## Updated')) {
        // Get next non-empty line
        for (let j = i + 1; j < lines.length; j++) {
          const trimmed = lines[j].trim();
          if (trimmed && !trimmed.startsWith('##')) {
            updatedLine = trimmed;
            break;
          }
        }
        break;
      }
    }

    if (!updatedLine) {
      agents.push({
        agent: agentName,
        org: orgName,
        status: 'no_timestamp',
        stale: true,
        reason: 'no Updated timestamp in GOALS.md',
      });
      continue;
    }

    // Parse ISO 8601 timestamp — goals.json writes a trailing "(by <agent>)"
    // attribution suffix (e.g. "2026-07-28T12:03:06Z (by boss)") that
    // Date() cannot tolerate after a valid ISO string, so strip it first.
    const isoTimestamp = updatedLine.replace(/\s*\([^()]*\)\s*$/, '').trim();
    const parsedDate = new Date(isoTimestamp);
    if (isNaN(parsedDate.getTime())) {
      agents.push({
        agent: agentName,
        org: orgName,
        status: 'parse_error',
        updated: updatedLine,
        stale: true,
        reason: 'could not parse timestamp',
      });
      continue;
    }

    const ageMs = now - parsedDate.getTime();
    const ageDays = Math.floor(ageMs / 86400000);
    const isStale = ageMs > thresholdMs;

    agents.push({
      agent: agentName,
      org: orgName,
      status: isStale ? 'stale' : 'fresh',
      updated: updatedLine,
      age_days: ageDays,
      stale: isStale,
      reason: isStale
        ? `${ageDays} days since last update (threshold: ${thresholdDays})`
        : undefined,
    });
  }

  const total = agents.length;
  const staleCount = agents.filter(a => a.stale).length;
  const freshCount = agents.filter(a => !a.stale).length;

  return {
    summary: {
      total,
      stale: staleCount,
      fresh: freshCount,
      threshold_days: thresholdDays,
    },
    agents,
  };
}

// --- Stale blocker sweep ---

export interface StaleBlockerEntry {
  task_id: string;
  org: string;
  title: string;
  status: TaskStatus;
  assigned_to: string;
  kind: 'resolved_dependency' | 'unverified_external_ref';
  detail: string;
}

export interface StaleBlockerReport {
  summary: {
    scanned: number;
    resolved_dependency: number;
    // task_1786777242641: count of scanned tasks that actually carry a
    // non-empty blocked_by — the only ones the resolved_dependency check can
    // evaluate. Without this, "resolved_dependency: 0" is indistinguishable
    // from "checked N tasks, found none stale" vs "0 of N were even
    // checkable" — a partially-measurable instrument that can now return
    // plausible non-zero values is more misleading than a wholly blind one.
    resolved_dependency_eligible: number;
    unverified_external_ref: number;
  };
  entries: StaleBlockerEntry[];
}

// task_1786068529924: catches "PR #67", "PR#67", "pr # 67" — deliberately
// loose on whitespace/case since these are freeform prose mentions, not a
// structured field.
const PR_REFERENCE_REGEX = /\bPR\s*#\s*(\d+)\b/gi;

// task_1786548092193 (analyst/forge, 2026-08-12 first live run): the bare
// regex above matches ANY "PR #NN" mention, including precedent-citation
// prose ("...same shape as the action1 precedent, PR #306...") that isn't
// naming a blocker at all — false-positived a task as unblockable when the
// cited PR predated the task by weeks and never touched its actual subject.
//
// Fix is an exclude-list, not a require-list: look at the text immediately
// around each match for precedent-citation phrasing and drop that specific
// mention if found, rather than requiring an explicit "blocked on"/"pending"
// cue be present. A require-list would suppress genuine free-form blocking
// mentions that don't happen to use one of a fixed set of phrases (e.g.
// "can't proceed until PR#67 lands") — the false-positive class here is
// narrow and nameable (precedent/example citation), so exclude it
// specifically rather than narrowing the whole match surface.
//
// No trailing \b: several cues end in a non-word char ("e.g."), and \b only
// holds at a word/non-word transition — a trailing \b after "e.g." silently
// never matches, since both the "." and the space after it are non-word.
const PRECEDENT_CITATION_CUE_REGEX =
  /\b(same (shape|pattern|approach|idiom) as|see .{0,10}for (the )?pattern|per the .{0,40}precedent|precedent|e\.g\.|for example|prior art)/i;

// Some cues fully precede the reference ("same shape as ... PR #306"); one
// straddles it ("see PR #12 for the pattern" — the reference sits INSIDE the
// cue phrase, not before it). Rather than special-case that shape, replace
// the matched "PR #NN" text with a same-length placeholder and test the cue
// regex against a window of the RESULT — "see PR #12 for the pattern"
// becomes "see [PRREF] for the pattern", which the "see .{0,10}for pattern"
// alternative matches straightforwardly on either side of the placeholder.
//
// The before-window is clamped to never reach past the END of the PREVIOUS
// PR reference in the same text (if any) — not a generic sentence-boundary
// regex, which breaks on abbreviation periods ("e.g." itself contains two
// periods, so a naive [.!?]-boundary split truncates the window right after
// "e.g."'s own trailing period and discards the very cue it's meant to
// preserve). Clamping to the prior PR mention's end is a more targeted
// anchor for the actual failure mode: an earlier citation's own trailing
// context ("...precedent, PR #306. ") leaking into a later, separate,
// genuinely blocking mention's window ("...blocked on PR#67").
const PRECEDENT_CUE_WINDOW_BEFORE = 80;
const PRECEDENT_CUE_WINDOW_AFTER = 40;

// task_1788228644615 (grower's report, 2026-09-01): a PR reference that has
// already been investigated and explicitly dismissed as a false positive
// keeps re-flagging identically on every subsequent scan — grower's #1424
// case hit this 6 times for zero new information, because each re-verify
// note RE-MENTIONS the same "PR #NNNN" string right next to its dismissal
// (e.g. "...same tool artifact (bare 'PR #1424' text match)"), and the
// precedent-citation check above only looks at the window around the
// ORIGINAL mention, not later re-mentions appended by the checker's own
// follow-up notes.
//
// "tool artifact" is deliberately the only cue here, not a broader set like
// "already resolved" — that phrase is common enough in ordinary prose that
// using it as a suppression trigger risks silently hiding a genuinely still-
// open reference that happens to share the wording. "tool artifact" is the
// specific, narrow phrase this org's own re-verify convention already
// converged on for exactly this dismissal (verified against the live task
// corpus before adding: appears exactly twice across every task on disk,
// both instances being this exact case) — same "narrow explicit cue over
// broad heuristic" choice the precedent-citation regex already makes.
//
// Unlike isPrecedentCitation, this checks ALL occurrences of a given PR
// reference in the full text, not just the one matchAll happened to find —
// a dismissal note appended much later (often hundreds of characters past
// the original mention) is exactly the shape that needs catching, and a
// windowed check anchored only to the first occurrence would miss it.
const DISMISSAL_MARKER_CUE_REGEX = /\btool artifact\b/gi;
const DISMISSAL_CUE_WINDOW = 120;

// task_1788276323687 (grower, non-author review of the PR that introduced
// isDismissedElsewhere): the marker check above had no negation awareness —
// "this is NOT a tool artifact, PR #67 is a genuine still-open blocker"
// matched the bare phrase and wrongly suppressed a real blocker, the exact
// failure this whole mechanism exists to prevent, just from the opposite
// direction (a false dismissal instead of a missing one). A negated mention
// of the idiom is plausible prose for an agent re-verifying a genuinely open
// reference while explicitly ruling the idiom out, not a contrived case.
//
// Fix stays in the same "narrow explicit cue" register as the marker itself:
// look at the ~20 chars immediately before each "tool artifact" match for a
// negation word ANYWHERE in that span (not anchored to sit directly against
// the match), and only count that occurrence as a genuine dismissal if no
// negation appears in its lookback. A window can contain multiple
// occurrences of the marker phrase; one negated occurrence does not
// invalidate another, genuinely un-negated one elsewhere in the same window.
//
// Deliberately NOT anchored to end immediately before the marker (e.g. via a
// trailing `$` after the negation word) — grower's own follow-up review
// found that an anchored version still missed "not really a tool artifact"
// (task_1788276326374's sibling finding), because the intervening adverb
// broke the adjacency. A short, unanchored lookback catches that case too,
// and the risk of an unrelated earlier "not" (negating something else in the
// same sentence) falsely suppressing a genuine dismissal is bounded by the
// window staying short — verified against exactly that shape ("task is not
// resolved, separately it is a tool artifact...") before choosing 20 chars:
// the unrelated negation sits outside the window, the genuine marker still
// counts as a dismissal.
const NEGATION_CUE_REGEX = /\b(not|isn't|isnt|wasn't|wasnt|never|no longer)\b/i;
const NEGATION_LOOKBACK = 20;

function hasGenuineDismissalMarker(window: string): boolean {
  for (const m of window.matchAll(DISMISSAL_MARKER_CUE_REGEX)) {
    const matchIndex = m.index ?? 0;
    const precedingStart = Math.max(0, matchIndex - NEGATION_LOOKBACK);
    const preceding = window.slice(precedingStart, matchIndex);
    if (!NEGATION_CUE_REGEX.test(preceding)) {
      return true;
    }
  }
  return false;
}

function isDismissedElsewhere(text: string, prRef: string): boolean {
  const escaped = prRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mentionRegex = new RegExp(escaped, 'gi');
  for (const m of text.matchAll(mentionRegex)) {
    const matchIndex = m.index ?? 0;
    const windowStart = Math.max(0, matchIndex - DISMISSAL_CUE_WINDOW);
    const windowEnd = matchIndex + m[0].length + DISMISSAL_CUE_WINDOW;
    if (hasGenuineDismissalMarker(text.slice(windowStart, windowEnd))) {
      return true;
    }
  }
  return false;
}

function isPrecedentCitation(
  text: string,
  matchIndex: number,
  matchLength: number,
  previousMatchEnd: number,
): boolean {
  const windowStart = Math.max(0, matchIndex - PRECEDENT_CUE_WINDOW_BEFORE, previousMatchEnd);
  const before = text.slice(windowStart, matchIndex);
  const after = text.slice(matchIndex + matchLength, matchIndex + matchLength + PRECEDENT_CUE_WINDOW_AFTER);
  const withPlaceholder = `${before}[PRREF]${after}`;
  return PRECEDENT_CITATION_CUE_REGEX.test(withPlaceholder);
}

/**
 * Sweep every org's blocked tasks for blockers that have already resolved.
 *
 * Two distinct, non-overlapping checks — deliberately not merged into one
 * fuzzy pass, because they have different confidence levels:
 *
 * 1. `resolved_dependency` — the task's own `blocked_by` DAG (a structured
 *    field, see Task.blocked_by) lists only completed deps, via the same
 *    `checkTaskDependencies` used by claimTask/updateTask. Zero ambiguity:
 *    if the task system itself would consider this task unblocked, but the
 *    task is still sitting at status=blocked, that's a stale blocker.
 *
 * 2. `unverified_external_ref` — freeform "PR #NN" mentions in the title or
 *    description (e.g. "blocked on PR#67"). There is no structured field
 *    naming which repo a bare PR number belongs to (task_1786068529924's
 *    own research pass confirmed this), and guessing a repo from context is
 *    exactly the kind of silent-wrong-answer this sweep exists to prevent.
 *    These are surfaced for manual/agent follow-up, not auto-resolved.
 *
 * Mirrors `checkGoalStaleness`'s fleet-wide-by-default shape (task_1785723303692
 * / #65: a fleet scan that silently covers only a subset is a recurring bug
 * class here) — every org under ctxRoot is scanned, not just the caller's own.
 *
 * Takes `ctxRoot` directly (not `instanceId` + an internal homedir() join)
 * so tests can point it at a tmpdir fixture instead of the real filesystem —
 * same testability shape `checkGoalStaleness` already uses via its `projectRoot`
 * param.
 */
export function checkStaleBlockers(ctxRoot: string): StaleBlockerReport {
  const entries: StaleBlockerEntry[] = [];
  let scanned = 0;
  let resolvedDependencyEligible = 0;

  const orgsDir = join(ctxRoot, 'orgs');
  const orgs = existsSync(orgsDir)
    ? readdirSync(orgsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
    : [];

  for (const org of orgs) {
    // Only taskDir/ctxRoot are read (listTasks + checkTaskDependencies'
    // cross-org fallback); the rest of BusPaths is unused here but built out
    // for type-completeness, mirroring resolvePaths()'s own layout exactly.
    const orgBase = join(ctxRoot, 'orgs', org);
    const paths: BusPaths = {
      ctxRoot,
      inbox: join(ctxRoot, 'inbox', '_stale-blocker-scan'),
      inflight: join(ctxRoot, 'inflight', '_stale-blocker-scan'),
      processed: join(ctxRoot, 'processed', '_stale-blocker-scan'),
      logDir: join(ctxRoot, 'logs', '_stale-blocker-scan'),
      stateDir: join(ctxRoot, 'state', '_stale-blocker-scan'),
      taskDir: join(orgBase, 'tasks'),
      approvalDir: join(orgBase, 'approvals'),
      analyticsDir: join(orgBase, 'analytics'),
      deliverablesDir: join(orgBase, 'deliverables'),
    };
    const blocked = listTasks(paths, { status: 'blocked' });
    scanned += blocked.length;

    for (const task of blocked) {
      if ((task.blocked_by?.length ?? 0) > 0) {
        resolvedDependencyEligible++;
        const { open: openDeps, unresolved } = checkTaskDependenciesWithStatus(paths, task.id);
        // An incomplete scan cannot support "blocked_by are all completed" —
        // that detail string names the deps as a fact. Skip rather than assert.
        if (openDeps.length === 0 && !unresolved) {
          entries.push({
            task_id: task.id,
            org,
            title: task.title,
            status: task.status,
            assigned_to: task.assigned_to,
            kind: 'resolved_dependency',
            detail: `blocked_by [${task.blocked_by!.join(', ')}] are all completed, but task is still status=blocked.`,
          });
          continue;
        }
      }

      const text = `${task.title} ${task.description}`;
      // matchAll yields matches left-to-right; previousMatchEnd tracks the
      // prior match's end so each mention's precedent-cue window can be
      // clamped against it (see isPrecedentCitation's doc comment).
      let previousMatchEnd = 0;
      const keptRefs: string[] = [];
      for (const m of text.matchAll(PR_REFERENCE_REGEX)) {
        const matchIndex = m.index ?? 0;
        if (!isPrecedentCitation(text, matchIndex, m[0].length, previousMatchEnd)) {
          keptRefs.push(`PR #${m[1]}`);
        }
        previousMatchEnd = matchIndex + m[0].length;
      }
      const refs = [...new Set(keptRefs)].filter(ref => !isDismissedElsewhere(text, ref));
      if (refs.length > 0) {
        entries.push({
          task_id: task.id,
          org,
          title: task.title,
          status: task.status,
          assigned_to: task.assigned_to,
          kind: 'unverified_external_ref',
          detail: `Mentions ${refs.join(', ')} — repo not structurally determinable from the task record, needs manual check.`,
        });
      }
    }
  }

  const resolvedCount = entries.filter(e => e.kind === 'resolved_dependency').length;
  const unverifiedCount = entries.filter(e => e.kind === 'unverified_external_ref').length;

  return {
    summary: {
      scanned,
      resolved_dependency: resolvedCount,
      resolved_dependency_eligible: resolvedDependencyEligible,
      unverified_external_ref: unverifiedCount,
    },
    entries,
  };
}

export interface PullDrift {
  behind: boolean;
  local_head: string;
  origin_head: string;
  commits_behind: number;
  commit_summaries: string[];
  truncated: boolean;
}

export interface BuildDrift {
  stale: boolean;
  local_head: string;
  built_sha: string | null;
  built_at: string | null;
  built_dirty?: boolean;
  reason?: string;
}

export interface DeployDriftReport {
  status: 'clean' | 'drift' | 'error';
  /**
   * WHICH drift is present. `status` deliberately collapses both so a cron can
   * alert on one field (see checkDeployDrift's docstring) — but the two have
   * OPPOSITE remedies, so a consumer that acts must read this, not `status`.
   *
   * - `pull`  — main has something the tree does not. Benign. Fix: pull, then build.
   * - `build` — dist has something main does not, or is behind it. Fix: build.
   * - `both`  — pull-and-build, as one action; the gap between the steps is the exposure.
   *
   * Added after 2026-08-15, where a cron offered a rebuild for pull drift in the
   * language of restoring sync. It was right that day by accident.
   */
  drift_kind?: 'pull' | 'build' | 'both';
  checked_at: string;
  pull_drift?: PullDrift;
  build_drift?: BuildDrift;
  error?: string;
  hint?: string;
}

export const COMMIT_LOG_LIMIT = 20;

/**
 * Detect the "merged != live on the fleet binary" gap root-caused 2026-08-11
 * (see continuity reference/cortextos-fleet-cli-deploy-mechanism): the fleet
 * `cortextos` CLI is a global npm-link to this checkout's gitignored,
 * tsup-built `dist/`, with no auto-deploy. A framework PR merging to
 * `origin/main` does nothing for the running fleet until someone pulls AND
 * rebuilds on this host — #77 shipped invisible for 3 commits' worth of time
 * because the checkout sat behind.
 *
 * Two independent drift checks, deliberately not conflated (they have
 * different fixes):
 *
 * 1. **Pull drift** — local HEAD vs `origin/main` after a fetch. Fix: `git
 *    pull --ff-only`.
 * 2. **Build drift** — `dist/build-manifest.json`'s stamped `gitSha` (written
 *    by every `npm run build`, see tsup.config.ts's `onSuccess` hook — added
 *    for daemon-restart forensics, task_1785551337187, reused here rather
 *    than adding a second stamping mechanism) vs local HEAD. Comparing
 *    against local HEAD, not origin — this check answers "does dist/ match
 *    what's actually checked out," independent of whether the checkout
 *    itself is also behind. Deliberately NOT using dist/cli.js's mtime: a
 *    `git checkout`/`pull` sets file mtimes to checkout time regardless of
 *    content, so mtime doesn't reliably indicate "built from the newest
 *    commit" — the SHA stamp is the robust signal the task called for.
 *    A gitSha match alone isn't sufficient, though: a build from a DIRTY
 *    tree stamps the same gitSha as a clean build at that commit (this
 *    exact gap left the live fleet on unmerged code briefly during this
 *    task's own review — a build ran while this PR's branch was checked
 *    out). `manifest.dirty` (also stamped by the `onSuccess` hook) is
 *    checked independently so a dirty-tree build is flagged even when the
 *    sha matches.
 *
 * Either drift sets `status: 'drift'` so a cron consumer can alert on a
 * single field rather than re-deriving it from both sub-reports.
 */
export function checkDeployDrift(frameworkRoot: string): DeployDriftReport {
  const checked_at = new Date().toISOString();
  const execOpts = { cwd: frameworkRoot, encoding: 'utf-8' as const, timeout: 30000, stdio: 'pipe' as const };

  try {
    execSync('git rev-parse --is-inside-work-tree', execOpts);
  } catch {
    return { status: 'error', checked_at, error: 'not a git repository', hint: `${frameworkRoot} is not inside a git work tree` };
  }

  try {
    execSync('git remote get-url origin', execOpts);
  } catch {
    return { status: 'error', checked_at, error: 'no origin remote configured' };
  }

  try {
    execSync('git fetch origin main', execOpts);
  } catch {
    return { status: 'error', checked_at, error: 'failed to fetch origin/main', hint: 'Check network and repo access' };
  }

  let localHead: string, originHead: string;
  try {
    localHead = execSync('git rev-parse HEAD', execOpts).trim();
    originHead = execSync('git rev-parse origin/main', execOpts).trim();
  } catch {
    return { status: 'error', checked_at, error: 'failed to resolve HEAD or origin/main' };
  }

  const behind = localHead !== originHead;
  let commitsBehind = 0;
  let commitSummaries: string[] = [];
  if (behind) {
    try {
      commitsBehind = parseInt(execSync('git rev-list HEAD..origin/main --count', execOpts).trim(), 10);
    } catch { /* default 0 */ }
    try {
      commitSummaries = execSync(`git log HEAD..origin/main --oneline -${COMMIT_LOG_LIMIT}`, execOpts)
        .trim().split('\n').filter(Boolean);
    } catch { /* leave empty */ }
  }

  const pull_drift: PullDrift = {
    behind,
    local_head: localHead,
    origin_head: originHead,
    commits_behind: commitsBehind,
    commit_summaries: commitSummaries,
    truncated: commitsBehind > COMMIT_LOG_LIMIT,
  };

  const manifestPath = join(frameworkRoot, 'dist', 'build-manifest.json');
  let build_drift: BuildDrift;
  if (!existsSync(manifestPath)) {
    build_drift = {
      stale: true,
      local_head: localHead,
      built_sha: null,
      built_at: null,
      reason: 'dist/build-manifest.json not found — dist/ has never been built, or was built before manifest stamping was added; run npm run build',
    };
  } else {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { gitSha?: string; builtAt?: string; dirty?: boolean };
      const builtSha = manifest.gitSha ?? null;
      const builtDirty = manifest.dirty === true;
      const shaMismatch = builtSha !== localHead;
      // A dirty-tree build stamps the same gitSha as a clean build at that
      // commit — sha-match alone can't tell them apart, so dirty is checked
      // independently rather than folded into shaMismatch.
      const stale = shaMismatch || builtDirty;
      let reason: string | undefined;
      if (shaMismatch) {
        // BEHIND vs DIVERGENT — same symptom, very different situations, and
        // until 2026-08-15 both produced the identical "run npm run build".
        // If built_sha is an ANCESTOR of HEAD, dist is merely old: everything
        // in it is reviewed code that was on main. If it is NOT an ancestor,
        // dist was built from a commit that is not in this history at all —
        // a branch checked out in the shared tree — so the fleet is running
        // code nobody chose to deploy. Asked of git rather than by comparing
        // symbols: a name-based probe against a minified bundle collides
        // (`hasTelegram` matching `hasTelegramMessage` cost an hour that day).
        let ancestor: boolean | null = null;
        // Shape-guard before interpolation: builtSha is read from a file on
        // disk, so it is not trusted input for a shell string. A non-SHA value
        // leaves ancestor null and falls through to the neutral wording.
        if (builtSha && /^[0-9a-f]{7,40}$/.test(builtSha)) {
          try {
            execSync(`git merge-base --is-ancestor ${builtSha} HEAD`, execOpts);
            ancestor = true;
          } catch {
            // Non-zero means "not an ancestor" — but it also means "unknown
            // commit" (a build from a branch since deleted/pruned). Both are
            // divergent provenance for this purpose; neither is plain staleness.
            ancestor = false;
          }
        }
        reason = ancestor === false
          ? `dist/ was built from a different commit than local HEAD — ${builtSha} is NOT an ancestor of HEAD, so dist contains code that is not in this history (a branch build in the shared tree, or a commit since pruned). Verify what is in it BEFORE rebuilding; a rebuild silently discards it.`
          : 'dist/ was built from an earlier commit than local HEAD — dist is behind; run npm run build';
      } else if (builtDirty) {
        reason = 'dist/ was built from a dirty working tree (uncommitted changes present at build time) — commit or stash, then run npm run build';
      }
      build_drift = {
        stale,
        local_head: localHead,
        built_sha: builtSha,
        built_at: manifest.builtAt ?? null,
        built_dirty: builtDirty,
        ...(reason ? { reason } : {}),
      };
    } catch {
      build_drift = {
        stale: true,
        local_head: localHead,
        built_sha: null,
        built_at: null,
        reason: 'dist/build-manifest.json exists but could not be parsed',
      };
    }
  }

  const drift_kind: DeployDriftReport['drift_kind'] =
    pull_drift.behind && build_drift.stale ? 'both'
      : pull_drift.behind ? 'pull'
        : build_drift.stale ? 'build'
          : undefined;

  return {
    status: (pull_drift.behind || build_drift.stale) ? 'drift' : 'clean',
    ...(drift_kind ? { drift_kind } : {}),
    checked_at,
    pull_drift,
    build_drift,
  };
}

/**
 * Post a message to the org's Telegram activity channel.
 *
 * Returns false if not configured (silent fail — callers can ignore the
 * return value and treat activity-channel posting as best-effort).
 *
 * `replyMarkup` is an optional Telegram inline keyboard (or any reply
 * markup shape). When provided, the message ships with the keyboard
 * attached — used for interactive workflows like approval Approve/Deny
 * buttons posted alongside approval creation. Leaving it undefined
 * preserves the prior one-way notification shape exactly.
 *
 * Mirrors bash bus/post-activity.sh.
 */
export async function postActivity(
  orgDir: string,
  ctxRoot: string,
  org: string,
  message: string,
  replyMarkup?: object,
): Promise<boolean> {
  // Look for activity-channel.env
  const candidates = [
    join(orgDir, 'activity-channel.env'),
    join(ctxRoot, 'orgs', org, 'activity-channel.env'),
  ];

  let configPath: string | null = null;
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      configPath = candidate;
      break;
    }
  }

  if (!configPath) {
    return false;
  }

  // Parse the env file
  let botToken: string | undefined;
  let chatId: string | undefined;

  try {
    const content = readFileSync(configPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (key === 'ACTIVITY_BOT_TOKEN') botToken = value;
      if (key === 'ACTIVITY_CHAT_ID') chatId = value;
    }
  } catch {
    return false;
  }

  if (!botToken || !chatId) {
    return false;
  }

  try {
    const api = new TelegramAPI(botToken);
    await api.sendMessage(chatId, message, replyMarkup);
    return true;
  } catch {
    return false;
  }
}

export interface BusBroadcastResult {
  /** Agents whose inbox accepted the broadcast message. */
  delivered: string[];
  /** Agents that were targeted but whose delivery threw (e.g. unresolvable paths). */
  skipped: string[];
}

/**
 * Bus-native activity broadcast — the fallback used when no Telegram
 * activity channel is configured (activity-channel.env absent). Fans the
 * message out as a normal-priority inbox message to every enabled agent in
 * the sender's org except the sender itself.
 *
 * Telegram-independent by design: a fleet can contain bus-only agents (no
 * BOT_TOKEN at all), and fleet-wide broadcast must not depend on a Telegram
 * chat id existing anywhere.
 */
export function broadcastActivityViaBus(
  frameworkRoot: string,
  ctxRoot: string,
  instanceId: string,
  org: string,
  sender: string,
  message: string,
): BusBroadcastResult {
  const delivered: string[] = [];
  const skipped: string[] = [];
  const recipients = discoverAllAgents(frameworkRoot, ctxRoot).filter(
    (a) => a.enabled && a.org === org && a.name !== sender,
  );
  for (const agent of recipients) {
    try {
      const recipientPaths = resolvePaths(agent.name, instanceId, org, ctxRoot);
      sendMessage(recipientPaths, sender, agent.name, 'normal', `[ACTIVITY] ${message}`);
      delivered.push(agent.name);
    } catch {
      skipped.push(agent.name);
    }
  }
  return { delivered, skipped };
}
