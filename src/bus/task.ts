import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, appendFileSync } from 'fs';
import { join } from 'path';
import type { Task, Priority, TaskStatus, BusPaths, StaleTaskReport, ArchiveReport } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { randomDigits } from '../utils/random.js';
import { validatePriority, validateTaskId } from '../utils/validate.js';
import { logEvent } from './event.js';

/**
 * Create a new task. Identical JSON format to bash create-task.sh.
 */
export function createTask(
  paths: BusPaths,
  agentName: string,
  org: string,
  title: string,
  options: {
    description?: string;
    assignee?: string;
    priority?: Priority;
    project?: string;
    needsApproval?: boolean;
    dueDate?: string;
    blockedBy?: string[];
    blocks?: string[];
  } = {},
): string {
  const {
    description = '',
    assignee = agentName,
    priority = 'normal',
    project = '',
    needsApproval = false,
    dueDate = '',
    blockedBy = [],
    blocks = [],
  } = options;

  validatePriority(priority);

  const epoch = Date.now();
  // 8 digits: same-millisecond collision probability is ~1e-8 instead of ~1e-3.
  // Two createTask calls in the same ms with a 3-digit suffix collided in CI
  // (run 25618845172), making the new task's id equal to its declared blocker
  // and tripping detectCycleOrThrow with "X ultimately blocks itself via X".
  const rand = randomDigits(8);
  const taskId = `task_${epoch}_${rand}`;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Dependency validation FIRST — a cycle must never be allowed to
  // leave partial state on disk. Earlier iteration wrote the task
  // JSON before detectCycleOrThrow ran, so a failed cycle check left
  // a dangling task with a one-way edge and no symmetric peer update.
  // Order is now: validate → write task → mutate peers → audit. The
  // cycle walker gets a `virtual` description of the not-yet-written
  // task so chains that pass through it are still detectable.
  const virtualTask = { id: taskId, blocked_by: blockedBy };
  if (blockedBy.length) detectCycleOrThrow(paths, taskId, blockedBy, virtualTask);
  if (blocks.length) {
    for (const downId of blocks) detectCycleOrThrow(paths, downId, [taskId], virtualTask);
  }

  const task: Task = {
    id: taskId,
    title,
    description,
    type: 'agent',
    needs_approval: needsApproval,
    status: 'pending',
    assigned_to: assignee,
    created_by: agentName,
    org,
    priority,
    project,
    kpi_key: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
    due_date: dueDate || null,
    archived: false,
    ...(blockedBy.length ? { blocked_by: [...blockedBy] } : {}),
    ...(blocks.length ? { blocks: [...blocks] } : {}),
  };

  ensureDir(paths.taskDir);
  atomicWriteSync(join(paths.taskDir, `${taskId}.json`), JSON.stringify(task));

  // Cycle-safe now: validation already passed, so symmetric-edge
  // maintenance is just mutating peer JSONs.
  for (const depId of blockedBy) addSymmetricEdge(paths, depId, 'blocks', taskId);
  for (const downId of blocks) addSymmetricEdge(paths, downId, 'blocked_by', taskId);

  appendTaskAudit(paths, taskId, { event: 'create', agent: agentName, to: 'pending', note: title });

  return taskId;
}

/**
 * Mutate an existing task to add an edge to its blocks/blocked_by list.
 * No-op if the peer id is already present. Used to maintain symmetric
 * edges when a new task declares its dependencies.
 */
function addSymmetricEdge(
  paths: BusPaths,
  taskId: string,
  field: 'blocks' | 'blocked_by',
  peerId: string,
): void {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) return; // Peer task missing — surfaced at resolution time.
  try {
    const task = JSON.parse(readFileSync(filePath, 'utf-8')) as Task;
    const list = task[field] ?? [];
    if (!list.includes(peerId)) {
      task[field] = [...list, peerId];
      atomicWriteSync(filePath, JSON.stringify(task));
    }
  } catch { /* best-effort */ }
}

/**
 * Walk the dependency DAG rooted at `newTaskId` depth-first along its
 * proposed `blocked_by` edges and throw if the walk re-enters
 * `newTaskId`. Only checks the `blocked_by` direction — cycles are
 * topologically symmetric, so walking one direction catches them all.
 *
 * `virtual` lets the caller describe a task that does not yet exist
 * on disk (the task being created). Without this, running the check
 * BEFORE the task JSON is written would miss cycles that pass
 * through the new task itself.
 */
function detectCycleOrThrow(
  paths: BusPaths,
  newTaskId: string,
  initialBlockers: string[],
  virtual?: { id: string; blocked_by: string[] },
): void {
  const seen = new Set<string>();
  const stack = [...initialBlockers];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === newTaskId) {
      throw new Error(`Dependency cycle: ${newTaskId} ultimately blocks itself via ${cur}`);
    }
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (virtual && cur === virtual.id) {
      if (virtual.blocked_by.length) stack.push(...virtual.blocked_by);
      continue;
    }
    const filePath = findTaskFile(paths, cur);
    if (!filePath) continue; // Missing peer is not a cycle, just a dangling ref.
    try {
      const task = JSON.parse(readFileSync(filePath, 'utf-8')) as Task;
      if (task.blocked_by?.length) stack.push(...task.blocked_by);
    } catch { /* skip */ }
  }
}

/**
 * Result of {@link findTaskFileWithStatus}.
 *
 * `unreadable` separates two cases that a bare `path: null` merges:
 *
 *   - `unreadable: false` — every candidate directory was scanned and the task
 *     is genuinely not on disk. Callers may treat this as real absence.
 *
 *   - `unreadable: true` — a directory that EXISTS could not be read, so the
 *     scan aborted early. The task may well be present. `path: null` here is
 *     the absence of a lookup, not the absence of a task.
 *
 * NEVER read `path === null` alone as "no such task" — see {@link findTaskFile}.
 */
export interface TaskFileLookup {
  path: string | null;
  unreadable: boolean;
}

/**
 * Result of {@link checkTaskDependenciesWithStatus}.
 *
 * `unresolved: true` means the dependency picture is INCOMPLETE — the task or
 * one of its blockers could not be read. An empty `open` is then meaningless
 * and must never be rendered as "ready to work".
 */
export interface TaskDependencyCheck {
  open: Array<{ id: string; status: TaskStatus | 'missing' }>;
  unresolved: boolean;
}

/**
 * Resolve blockers for `taskId`: returns the list of tasks in its
 * `blocked_by` that are NOT yet completed, plus whether the picture is
 * complete. `open: []` AND `unresolved: false` = good to go.
 * A missing peer is reported as `{ id, status: 'missing' }` so callers
 * can distinguish "dependency cleared" from "dependency references a
 * task that no longer exists".
 *
 * The `unresolved` flag exists because an empty `open` list is consumed as an
 * affirmative all-clear in both call sites — the CLI prints "ready to work",
 * and the drift scanner emits a `resolved_dependency` finding whose detail
 * asserts the blockers "are all completed". That sentence is built from
 * `blocked_by` alone, so on an unreadable tree it states as fact something no
 * code ever read. A gate that cannot verify must hold, not open.
 */
export function checkTaskDependenciesWithStatus(
  paths: BusPaths,
  taskId: string,
): TaskDependencyCheck {
  const lookup = findTaskFileWithStatus(paths, taskId);
  if (!lookup.path) return { open: [], unresolved: lookup.unreadable };
  const filePath = lookup.path;
  let task: Task;
  try { task = JSON.parse(readFileSync(filePath, 'utf-8')) as Task; }
  catch { return { open: [], unresolved: true }; } // found it, could not parse it
  const deps = task.blocked_by ?? [];
  const open: Array<{ id: string; status: TaskStatus | 'missing' }> = [];
  let unresolved = false;
  for (const depId of deps) {
    const depLookup = findTaskFileWithStatus(paths, depId);
    if (!depLookup.path) {
      // A dep we could not LOOK UP is not a dep we know is gone. Both land in
      // `open` so the gate stays shut either way, but only the first is a fact.
      if (depLookup.unreadable) unresolved = true;
      open.push({ id: depId, status: 'missing' });
      continue;
    }
    try {
      const dep = JSON.parse(readFileSync(depLookup.path, 'utf-8')) as Task;
      if (dep.status !== 'completed') open.push({ id: depId, status: dep.status });
    } catch {
      unresolved = true;
      open.push({ id: depId, status: 'missing' });
    }
  }
  return { open, unresolved };
}

/**
 * Back-compat wrapper over {@link checkTaskDependenciesWithStatus}.
 *
 * @returns only the open-blocker list, DISCARDING whether that list is
 *          trustworthy. An empty array means "no open blockers" OR "could not
 *          tell". Use {@link checkTaskDependenciesWithStatus} anywhere the
 *          result gates an action or is shown to a human.
 */
export function checkTaskDependencies(
  paths: BusPaths,
  taskId: string,
): Array<{ id: string; status: TaskStatus | 'missing' }> {
  return checkTaskDependenciesWithStatus(paths, taskId).open;
}

/**
 * Find the on-disk path of a task file by ID, supporting cross-org lookup.
 *
 * cortextOS's standard dispatch pattern is an orchestrator in one org
 * filing tasks that get assigned to specialists in other orgs. Before
 * this helper existed, updateTask
 * and completeTask hardcoded `join(paths.taskDir, taskId + '.json')` — which
 * points at the CURRENT agent's org tasks dir — so the specialist could not
 * drive the lifecycle of any task that was filed from a sibling org. Every
 * cross-org assignment required a manual workaround dance where the filer
 * ran update/complete on behalf of the assignee.
 *
 * This helper fixes that by using a two-tier lookup:
 *
 *   1. Fast path: check the caller's OWN org tasks dir first. Most tasks
 *      live there and this check pays zero scan cost when it hits.
 *   2. Fallback: scan every sibling org under `<ctxRoot>/orgs/*` for a
 *      matching task file. Only runs when the fast path missed, so
 *      same-org operations take no perf hit.
 *
 * Task IDs are generated as `task_<epoch_ms>_<3digit_random>` so real
 * collisions are effectively impossible — but if the scan ever finds the
 * same ID in multiple orgs (e.g. due to a bug in ID generation or a manual
 * file copy), we warn loudly naming the task ID, the match count, AND the
 * org names so an operator can investigate without having to grep the IDs
 * themselves. We still return the first match and keep operations flowing;
 * erroring on a theoretical collision would be worse UX than the warn.
 *
 * Exported because the helper is a useful primitive for any future caller
 * that needs cross-org task lookup (e.g. a hypothetical `get-task` command,
 * task-graph visualization, or cross-org list-tasks flag).
 */
export function findTaskFileWithStatus(paths: BusPaths, taskId: string): TaskFileLookup {
  // Reject path-traversal task ids before they reach any join() below. This is
  // the chokepoint for updateTask/claimTask/completeTask/checkTaskDependencies.
  validateTaskId(taskId);
  // Fast path: same-org lookup.
  const sameOrg = join(paths.taskDir, `${taskId}.json`);
  if (existsSync(sameOrg)) return { path: sameOrg, unreadable: false };

  // Fallback: cross-org scan.
  const orgsRoot = join(paths.ctxRoot, 'orgs');
  const matches: Array<{ path: string; org: string }> = [];
  try {
    for (const entry of readdirSync(orgsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(orgsRoot, entry.name, 'tasks', `${taskId}.json`);
      if (existsSync(candidate)) {
        matches.push({ path: candidate, org: entry.name });
      }
    }
  } catch {
    // orgs/ missing or unreadable — the prefix scan still covers the
    // caller's own taskDir (which is not guaranteed to live under orgs/).
    // It re-derives `unreadable` from its own sweep, so the flag reflects
    // whether ANY dir was left unscanned rather than just this one throw.
    return findTaskFileByPrefix(paths, taskId, orgsRoot);
  }

  if (matches.length === 0) return findTaskFileByPrefix(paths, taskId, orgsRoot);
  if (matches.length > 1) {
    const orgList = matches.map((m) => m.org).join(', ');
    console.warn(
      `[task] Ambiguous task id ${taskId}: found in ${matches.length} orgs (${orgList}). ` +
      `Operating on the first match in org '${matches[0].org}'. ` +
      `Review task ID generation if this recurs.`,
    );
  }
  return { path: matches[0].path, unreadable: false };
}

/**
 * Back-compat wrapper over {@link findTaskFileWithStatus}, kept because most
 * callers genuinely do not care why the lookup came back empty.
 *
 * @returns the task file path, or `null` for BOTH "no such task" and "the scan
 *          could not be completed". That collapse is the entire reason
 *          {@link findTaskFileWithStatus} exists — use it wherever a `null` is
 *          about to be reported to a human, written into a finding, or treated
 *          as an affirmative all-clear.
 */
export function findTaskFile(paths: BusPaths, taskId: string): string | null {
  return findTaskFileWithStatus(paths, taskId).path;
}

/**
 * Tier 3 of findTaskFile: unique-prefix resolution. list-tasks' display
 * truncated ids for a long time (fixed in #14), so operators habitually
 * copy prefixes — and a prefix that misses the exact-match tiers used to
 * dead-end in "not found" even though the task was sitting right there.
 * A prefix that matches exactly one task resolves to it; an ambiguous
 * prefix throws NAMING every candidate (so the operator can see what to
 * disambiguate to) rather than silently picking one; no match falls
 * through to the caller's existing not-found error.
 *
 * Returns a {@link TaskFileLookup} rather than a bare `string | null` so the
 * "scan aborted" path stays distinguishable from "scan completed, found
 * nothing" — see {@link findTaskFileWithStatus}.
 */
function findTaskFileByPrefix(
  paths: BusPaths,
  taskIdPrefix: string,
  orgsRoot: string,
): TaskFileLookup {
  const prefixMatches: Array<{ path: string; id: string; org: string }> = [];
  const scanDir = (tasksDir: string, org: string): void => {
    if (!existsSync(tasksDir)) return;
    for (const f of readdirSync(tasksDir)) {
      if (!f.endsWith('.json') || !f.startsWith(taskIdPrefix)) continue;
      prefixMatches.push({
        path: join(tasksDir, f),
        id: f.slice(0, -'.json'.length),
        org,
      });
    }
  };
  try {
    // The caller's own taskDir is not guaranteed to live under orgs/
    // (the fast path in findTaskFile makes the same assumption), so scan
    // it explicitly, then the sibling orgs — skipping the own dir if the
    // orgs sweep would visit it again.
    scanDir(paths.taskDir, 'own');
    if (existsSync(orgsRoot)) {
      for (const entry of readdirSync(orgsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const tasksDir = join(orgsRoot, entry.name, 'tasks');
        if (tasksDir === paths.taskDir) continue;
        scanDir(tasksDir, entry.name);
      }
    }
  } catch {
    // A tasks dir EXISTS but could not be read (EACCES/EIO/ENOTDIR). Absence is
    // already handled by the existsSync guards above and never lands here, so
    // this is unambiguously "the scan aborted", not "there was nothing to find".
    return { path: null, unreadable: true };
  }
  if (prefixMatches.length === 1) return { path: prefixMatches[0].path, unreadable: false };
  if (prefixMatches.length > 1) {
    const candidates = prefixMatches.map((m) => `${m.id} (org: ${m.org})`).join(', ');
    throw new Error(
      `Ambiguous task id prefix '${taskIdPrefix}': matches ${prefixMatches.length} tasks — ` +
      `${candidates}. Use the full task id.`,
    );
  }
  return { path: null, unreadable: false }; // scan completed, genuinely no match
}

/**
 * Update a task's status, and/or reroute it to a new
 * assignee/project/priority, and/or append to its description, and/or append
 * blocker edges.
 * Matches bash update-task.sh behavior for the status-only case, with the
 * cross-org fallback from findTaskFile so an assignee in one org can drive
 * the lifecycle of a task filed by an orchestrator in a sibling org.
 *
 * `status` is optional so a caller can reassign/re-project/re-prioritize a task
 * without restating (and risking accidentally churning) its current status —
 * create-task is the only place assignee/project/priority are otherwise settable.
 * At least one of status/assignee/project/priority/appendDesc/blockedBy must
 * be given.
 *
 * `appendDesc` deliberately APPENDS rather than replaces: a task description
 * cannot otherwise be corrected after creation, which twice in one hour drove
 * agents to invent lossy workarounds (cancel-and-refile churning the task ID,
 * or parking the correction in daily memory where a task reader never sees
 * it) — see task_1786776657887_48026218. Keeping the original text visible
 * alongside the addition matters specifically when the addition is a
 * correction: a retraction next to the false claim it retracts is legible in
 * a way that a silent overwrite is not.
 *
 * `opts.blockedBy` is ADDITIVE, never a replace: a gate normally emerges
 * AFTER creation (that's why a task transitions to `blocked` at all), and
 * create-task already owns the initial full list. IDs already present in
 * blocked_by are silently deduped rather than re-validated or re-audited —
 * only genuinely new edges go through the cycle check and get a symmetric
 * `blocks` edge written on the peer, mirroring createTask's own
 * validate-before-write / mutate-peers-after-write ordering so a rejected
 * cycle never leaves partial state on disk.
 */
export function updateTask(
  paths: BusPaths,
  taskId: string,
  status?: TaskStatus,
  opts: {
    assignee?: string;
    project?: string;
    priority?: Priority;
    appendDesc?: string;
    blockedBy?: string[];
  } = {},
): void {
  const blockedByInput = opts.blockedBy ?? [];
  if (
    status === undefined &&
    opts.assignee === undefined &&
    opts.project === undefined &&
    opts.priority === undefined &&
    opts.appendDesc === undefined &&
    blockedByInput.length === 0
  ) {
    throw new Error(
      'updateTask requires at least one of: status, assignee, project, priority, appendDesc, blockedBy',
    );
  }
  if (opts.priority !== undefined) validatePriority(opts.priority);
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) {
    throw new Error(
      `Task ${taskId} not found in any org under ${paths.ctxRoot}/orgs/`,
    );
  }
  let prevStatus: TaskStatus | undefined;
  let auditAgent: string | undefined;
  const noteParts: string[] = [];
  let newBlockers: string[] = [];
  try {
    const content = readFileSync(filePath, 'utf-8');
    const task: Task = JSON.parse(content);
    prevStatus = task.status;
    auditAgent = task.assigned_to;

    const currentBlockedBy = task.blocked_by ?? [];
    newBlockers = blockedByInput.filter(depId => !currentBlockedBy.includes(depId));
    if (newBlockers.length) {
      // Cycle check BEFORE any field mutation, same ordering rule createTask
      // enforces — a rejected cycle must never leave partial state on disk.
      // The virtual task carries the FULL post-update blocked_by set (old +
      // new), not just the new edges, so a cycle running back through an
      // already-existing blocker is still caught.
      const virtualTask = { id: taskId, blocked_by: [...currentBlockedBy, ...newBlockers] };
      detectCycleOrThrow(paths, taskId, newBlockers, virtualTask);
      task.blocked_by = [...currentBlockedBy, ...newBlockers];
      noteParts.push(`blocked_by: +[${newBlockers.join(', ')}]`);
    }

    if (status !== undefined) task.status = status;
    if (opts.assignee !== undefined && opts.assignee !== task.assigned_to) {
      noteParts.push(`assignee: ${task.assigned_to} -> ${opts.assignee}`);
      task.assigned_to = opts.assignee;
    }
    if (opts.project !== undefined && opts.project !== task.project) {
      noteParts.push(`project: '${task.project}' -> '${opts.project}'`);
      task.project = opts.project;
    }
    if (opts.priority !== undefined && opts.priority !== task.priority) {
      noteParts.push(`priority: ${task.priority} -> ${opts.priority}`);
      task.priority = opts.priority;
    }
    if (opts.appendDesc !== undefined) {
      const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const marker = `\n\n--- APPENDED ${stamp} ---\n${opts.appendDesc}`;
      task.description = (task.description ?? '') + marker;
      noteParts.push(`description: appended ${opts.appendDesc.length} chars`);
    }
    task.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    atomicWriteSync(filePath, JSON.stringify(task));
  } catch (err) {
    throw new Error(`Task ${taskId} update failed: ${err}`);
  }

  // Symmetric edge maintenance — mirrors createTask's own post-write step.
  // Cycle-safe now: validation already passed above.
  for (const depId of newBlockers) addSymmetricEdge(paths, depId, 'blocks', taskId);

  appendTaskAudit(paths, taskId, {
    event: 'update',
    agent: auditAgent || 'unknown',
    from: prevStatus,
    to: status ?? prevStatus,
    ...(noteParts.length ? { note: noteParts.join(', ') } : {}),
  });
}

/**
 * One audit entry written to a task's append-only JSONL log. Every
 * status transition, claim, and completion emits one of these so the
 * full lifecycle can be replayed from disk.
 */
export interface TaskAuditEntry {
  ts: string; // ISO 8601
  event: 'create' | 'claim' | 'update' | 'complete';
  agent: string; // who caused the event
  from?: TaskStatus;
  to?: TaskStatus;
  note?: string;
}

/**
 * Append one audit line to `<taskDir>/audit/<taskId>.jsonl`. Uses
 * appendFileSync so concurrent writers each get O_APPEND semantics on
 * POSIX — partial interleaving at the sub-line level is possible on
 * some filesystems for lines over PIPE_BUF, but our entries are
 * ~200 bytes, comfortably under the 4096-byte atomicity bound.
 *
 * Best-effort: a failing audit write never blocks the caller. The
 * audit log is an observability aid, not the source of truth.
 */
export function appendTaskAudit(
  paths: BusPaths,
  taskId: string,
  entry: Omit<TaskAuditEntry, 'ts'>,
): void {
  // Validate before the try so a traversal id is rejected loudly rather than
  // swallowed by the audit-never-blocks catch below.
  validateTaskId(taskId);
  try {
    const auditDir = join(paths.taskDir, 'audit');
    ensureDir(auditDir);
    const line: TaskAuditEntry = {
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      ...entry,
    };
    appendFileSync(join(auditDir, `${taskId}.jsonl`), JSON.stringify(line) + '\n', { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // Never block a real operation on audit-log write failure.
  }
}

/**
 * Read all audit entries for a task in write-order. Returns empty
 * array if no audit log exists. Corrupt lines are skipped so a
 * partially-written line (rare: write crashed mid-line) does not
 * block history replay of surrounding entries.
 */
export function readTaskAudit(
  paths: BusPaths,
  taskId: string,
): TaskAuditEntry[] {
  validateTaskId(taskId);
  const path = join(paths.taskDir, 'audit', `${taskId}.jsonl`);
  if (!existsSync(path)) return [];
  const entries: TaskAuditEntry[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { entries.push(JSON.parse(trimmed) as TaskAuditEntry); } catch { /* skip corrupt */ }
  }
  return entries;
}

/**
 * Atomically claim a task for an agent. Prevents two agents from double-
 * picking the same task — a race that previously could happen because
 * `update-task <id> in_progress` was a read-modify-write with no lock.
 *
 * Mechanism: write a companion claim-lock file via the POSIX O_EXCL
 * path (`writeFileSync` with `flag: 'wx'`). The first writer wins; the
 * second gets EEXIST and claimTask throws "already claimed by X". Only
 * after the lock is taken do we flip the task's status + assigned_to.
 *
 * Re-claiming a task you already own is idempotent (returns the task
 * without mutation). Claiming a non-pending task is rejected with a
 * message that names the current status so operators can diagnose.
 *
 * Claim-lock files live at `<taskDir>/.claims/<taskId>.claim` and carry
 * `<agent>\t<iso8601>` for audit. A later compaction pass can prune
 * claim-locks for completed tasks; for now they are append-only.
 */
export function claimTask(
  paths: BusPaths,
  taskId: string,
  agent: string,
): Task {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) {
    throw new Error(
      `Task ${taskId} not found in any org under ${paths.ctxRoot}/orgs/`,
    );
  }

  let task: Task;
  try {
    task = JSON.parse(readFileSync(filePath, 'utf-8')) as Task;
  } catch (err) {
    throw new Error(`Task ${taskId} claim failed (unreadable): ${err}`);
  }

  const claimsDir = join(paths.taskDir, '.claims');
  ensureDir(claimsDir);
  const claimPath = join(claimsDir, `${taskId}.claim`);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Idempotency: if this agent already owns the claim, succeed silently.
  if (existsSync(claimPath)) {
    try {
      const owner = readFileSync(claimPath, 'utf-8').split('\t')[0];
      if (owner === agent) {
        return task;
      }
      throw new Error(
        `Task ${taskId} already claimed by ${owner} (current status=${task.status})`,
      );
    } catch (err) {
      if (err instanceof Error && err.message.startsWith(`Task ${taskId} already claimed`)) throw err;
      // Unreadable claim file — fall through and try the exclusive write.
    }
  }

  if (task.status !== 'pending') {
    throw new Error(
      `Task ${taskId} is not pending (status=${task.status}); cannot claim`,
    );
  }

  // Atomic: O_EXCL fails if the file exists, giving us true mutual
  // exclusion even under concurrent claims from two agents.
  try {
    writeFileSync(claimPath, `${agent}\t${now}\n`, { flag: 'wx', encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    // Someone else won the race — read the winner and surface it.
    let owner = 'unknown';
    try { owner = readFileSync(claimPath, 'utf-8').split('\t')[0]; } catch { /* stays 'unknown' */ }
    if (owner === agent) return task; // Benign race with self — treat as idempotent success.
    throw new Error(`Task ${taskId} already claimed by ${owner}`);
  }

  // Lock held — safe to mutate the task JSON.
  const prevStatus = task.status;
  task.status = 'in_progress';
  task.assigned_to = agent;
  task.updated_at = now;
  try {
    atomicWriteSync(filePath, JSON.stringify(task));
  } catch (err) {
    // Roll back the claim so a retry can succeed; we never want a ghost
    // lock surviving a write failure on the task JSON itself.
    try { unlinkSync(claimPath); } catch { /* best-effort */ }
    throw new Error(`Task ${taskId} claim commit failed: ${err}`);
  }
  appendTaskAudit(paths, taskId, { event: 'claim', agent, from: prevStatus, to: 'in_progress' });
  return task;
}

/**
 * Complete a task. Sets status to done, completed_at, and optional result.
 * Matches bash complete-task.sh behavior, with the cross-org fallback from
 * findTaskFile so an assignee in one org can complete a task filed by an
 * orchestrator in a sibling org.
 *
 * Side-effect: emits a `task/task_completed` event on the activity feed so
 * completions are visible on the dashboard without agents having to follow
 * every complete-task call with a separate log-event. The event is written
 * best-effort — a failing event write never unblocks task completion from
 * persisting to disk.
 */
export function completeTask(
  paths: BusPaths,
  taskId: string,
  result?: string,
): void {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) {
    throw new Error(
      `Task ${taskId} not found in any org under ${paths.ctxRoot}/orgs/`,
    );
  }
  let prevStatus: TaskStatus | undefined;
  let assignee: string | undefined;
  let taskOrg: string = '';
  try {
    const content = readFileSync(filePath, 'utf-8');
    const task: Task = JSON.parse(content);
    prevStatus = task.status;
    assignee = task.assigned_to;
    taskOrg = task.org || '';
    task.status = 'completed';
    task.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    task.completed_at = task.updated_at;
    if (result) {
      task.result = result;
    }
    atomicWriteSync(filePath, JSON.stringify(task));
  } catch (err) {
    throw new Error(`Task ${taskId} complete failed: ${err}`);
  }
  appendTaskAudit(paths, taskId, { event: 'complete', agent: assignee || 'unknown', from: prevStatus, to: 'completed', note: result });

  // Activity-feed event. Best-effort — the task is already persisted.
  if (assignee) {
    try {
      // Cross-org completion (caller's org ≠ task's org) is allowed via
      // findTaskFile, but the caller's `paths.analyticsDir` is scoped to
      // the caller's org. Rewrite the analytics path to the task's actual
      // org so dashboards/metrics see the completion under the right tree.
      // Only rewrite analyticsDir when the resolved task path is in the
      // nested cross-org layout: <ctxRoot>/orgs/<org>/tasks/<taskId>.json.
      // Flat/single-org test harnesses use <ctxRoot>/tasks + <ctxRoot>/analytics
      // and should keep the caller-provided analyticsDir unchanged.
      const pathOrgMatch = filePath.match(/[\\/]orgs[\\/](?<org>[^\\/]+)[\\/]tasks[\\/]/);
      const fileOrg = pathOrgMatch?.groups?.org || '';
      const eventPaths: BusPaths = fileOrg
        ? { ...paths, analyticsDir: join(paths.ctxRoot, 'orgs', fileOrg, 'analytics') }
        : paths;
      logEvent(eventPaths, assignee, taskOrg, 'task', 'task_completed', 'info', {
        task_id: taskId,
        ...(result ? { result } : {}),
      });
    } catch {
      // Never let observability break task completion.
    }
  }
}

/**
 * Reconstruct Task-shaped summaries from `compactTasks`'s `archive-YYYY-MM.jsonl`
 * files in `taskDir`. Each JSONL line only carries {id, title, org, assigned_to,
 * completed_at, archived_at, result} — compaction deletes the full task JSON
 * (see {@link compactTasks}), so this is a lookup surface, not a full replay.
 *
 * Fields the archive line doesn't carry get a fixed, documented default rather
 * than an inferred guess: `status: 'completed'` is exact (compaction only ever
 * archives completed tasks, so this is not a default in the guessing sense);
 * `priority`/`description`/`project`/`type`/`created_by`/`due_date`/`kpi_key`
 * are genuinely unknown and get the same neutral defaults `createTask` itself
 * uses, so a caller filtering on them gets a stable, documented answer instead
 * of an undefined one. `archived: true` marks every reconstructed entry so a
 * caller (or the CLI renderer) can tell it apart from a live task on sight.
 *
 * Corrupt lines and unreadable/absent archive files are skipped silently —
 * same failure posture as the active-task read loop below, and consistent
 * with `readTaskAudit`'s corrupt-line handling.
 */
function readCompactedTasks(taskDir: string): Task[] {
  let files: string[];
  try {
    files = readdirSync(taskDir).filter(
      f => f.startsWith('archive-') && f.endsWith('.jsonl'),
    );
  } catch {
    return [];
  }

  const tasks: Task[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(join(taskDir, file), 'utf-8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as {
          id: string; title: string; org: string; assigned_to: string;
          completed_at: string; archived_at: string; result?: string;
        };
        tasks.push({
          id: entry.id,
          title: entry.title,
          description: '',
          type: 'agent',
          needs_approval: false,
          status: 'completed',
          assigned_to: entry.assigned_to,
          created_by: entry.assigned_to,
          org: entry.org,
          priority: 'normal',
          project: '',
          kpi_key: null,
          created_at: entry.completed_at,
          updated_at: entry.archived_at,
          completed_at: entry.completed_at,
          due_date: null,
          archived: true,
          ...(entry.result ? { result: entry.result } : {}),
        });
      } catch {
        // Skip corrupt lines — matches readTaskAudit's posture.
      }
    }
  }
  return tasks;
}

/**
 * List tasks with optional filters.
 * Matches bash list-tasks.sh behavior.
 *
 * `includeArchived` additionally surfaces compacted tasks reconstructed via
 * {@link readCompactedTasks} — see that function for exactly which fields are
 * exact vs. defaulted. Without the flag, a task `compactTasks` has processed
 * is invisible here by construction (its JSON no longer exists), the gap this
 * flag exists to close: a retired task must stay matchable by the same key a
 * caller would use to look it up, or a recurrence reads as a first occurrence.
 */
export function listTasks(
  paths: BusPaths,
  filters?: {
    agent?: string;
    status?: TaskStatus;
    priority?: Priority;
    respectDeps?: boolean;
    includeArchived?: boolean;
  },
): Task[] {
  const { taskDir } = paths;
  let files: string[];
  try {
    files = readdirSync(taskDir).filter(
      f => f.startsWith('task_') && f.endsWith('.json'),
    );
  } catch {
    return [];
  }

  const tasks: Task[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(taskDir, file), 'utf-8');
      const task: Task = JSON.parse(content);

      // Apply filters
      if (filters?.agent && task.assigned_to !== filters.agent) continue;
      if (filters?.status && task.status !== filters.status) continue;
      if (filters?.priority && task.priority !== filters.priority) continue;
      if (task.archived) continue;

      tasks.push(task);
    } catch {
      // Skip corrupt files
    }
  }

  if (filters?.includeArchived) {
    for (const task of readCompactedTasks(taskDir)) {
      if (filters?.agent && task.assigned_to !== filters.agent) continue;
      if (filters?.status && task.status !== filters.status) continue;
      if (filters?.priority && task.priority !== filters.priority) continue;
      tasks.push(task);
    }
  }

  const sorted = tasks.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  if (!filters?.respectDeps) return sorted;

  // DAG-aware ordering: unblocked tasks first, blocked ones after, with
  // the secondary order preserving created_at DESC within each bucket.
  // "Blocked" = any blocked_by entry resolves to non-completed.
  const byId = new Map<string, Task>();
  for (const t of sorted) byId.set(t.id, t);
  const isBlocked = (t: Task): boolean => {
    for (const depId of t.blocked_by ?? []) {
      const dep = byId.get(depId);
      // Out-of-list deps are checked on-disk via checkTaskDependencies,
      // but the list-view only considers in-list tasks for speed.
      if (!dep) continue;
      if (dep.status !== 'completed') return true;
    }
    return false;
  };
  const unblocked: Task[] = [];
  const blocked: Task[] = [];
  for (const t of sorted) (isBlocked(t) ? blocked : unblocked).push(t);
  return [...unblocked, ...blocked];
}

/**
 * Helper: read all task JSON files from a directory (non-recursive).
 */
function readAllTasks(taskDir: string): Task[] {
  let files: string[];
  try {
    files = readdirSync(taskDir).filter(
      f => f.startsWith('task_') && f.endsWith('.json'),
    );
  } catch {
    return [];
  }

  const tasks: Task[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(taskDir, file), 'utf-8');
      tasks.push(JSON.parse(content));
    } catch {
      // Skip corrupt files
    }
  }
  return tasks;
}

/**
 * Check for stale tasks. Matches bash check-stale-tasks.sh behavior.
 */
export function checkStaleTasks(paths: BusPaths): StaleTaskReport {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const STALE_IN_PROGRESS = 7200;   // 2 hours
  const STALE_PENDING = 86400;      // 24 hours
  const STALE_HUMAN = 86400;        // 24 hours

  const report: StaleTaskReport = {
    stale_in_progress: [],
    stale_pending: [],
    stale_human: [],
    overdue: [],
  };

  const tasks = readAllTasks(paths.taskDir);

  for (const task of tasks) {
    // Skip completed/done tasks
    if (task.status === 'completed' || task.status === 'cancelled') continue;

    const updatedEpoch = Math.floor(new Date(task.updated_at).getTime() / 1000);
    const createdEpoch = Math.floor(new Date(task.created_at).getTime() / 1000);
    const age = nowEpoch - updatedEpoch;
    const createdAge = nowEpoch - createdEpoch;

    // Stale in_progress: updated_at > 2 hours ago
    if (task.status === 'in_progress' && age > STALE_IN_PROGRESS) {
      report.stale_in_progress.push(task);
    }

    // Stale pending: created_at > 24 hours ago
    if (task.status === 'pending' && createdAge > STALE_PENDING) {
      report.stale_pending.push(task);
    }

    // Human tasks: assigned to "human" or "user", or in human-tasks project
    if (
      (['human', 'user'].includes(task.assigned_to ?? '') ||
        task.project === 'human-tasks') &&
      createdAge > STALE_HUMAN
    ) {
      report.stale_human.push(task);
    }

    // Overdue: has due_date and it's in the past
    if (task.due_date) {
      const dueEpoch = Math.floor(new Date(task.due_date).getTime() / 1000);
      if (dueEpoch > 0 && nowEpoch > dueEpoch) {
        report.overdue.push(task);
      }
    }
  }

  return report;
}

/**
 * Archive completed tasks older than 7 days. Matches bash archive-tasks.sh behavior.
 */
export function archiveTasks(paths: BusPaths, dryRun: boolean = false): ArchiveReport {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const ARCHIVE_AGE = 604800; // 7 days

  let archived = 0;
  let skipped = 0;

  const tasks = readAllTasks(paths.taskDir);

  for (const task of tasks) {
    // Only archive completed tasks
    if (task.status !== 'completed') continue;

    if (!task.completed_at) {
      skipped++;
      continue;
    }

    const completedEpoch = Math.floor(new Date(task.completed_at).getTime() / 1000);
    const age = nowEpoch - completedEpoch;

    if (age > ARCHIVE_AGE) {
      // task.id comes from the file's JSON body and is used to build the
      // rename source/dest below; a tampered id must not escape the task tree.
      try { validateTaskId(task.id); } catch { skipped++; continue; }
      if (!dryRun) {
        const archiveDir = join(paths.taskDir, 'archive');
        ensureDir(archiveDir);

        // Mark as archived
        task.archived = true;
        const srcPath = join(paths.taskDir, `${task.id}.json`);
        atomicWriteSync(srcPath, JSON.stringify(task));

        // Move to archive
        renameSync(srcPath, join(archiveDir, `${task.id}.json`));
      }
      archived++;
    }
  }

  return { archived, skipped, dry_run: dryRun };
}

/**
 * Semantic compaction of old completed tasks (beads-inspired). Each
 * eligible task becomes a one-line summary entry in a monthly
 * `archive-YYYY-MM.jsonl` file (bucketed by the task's completed_at
 * month), and the active task JSON is removed to keep the task board
 * small. The audit log (audit/<id>.jsonl) is intentionally preserved
 * so full lifecycle history survives compaction.
 *
 * Guards (a task is SKIPPED if any of the following holds):
 *   - status !== 'completed'
 *   - completed_at missing OR completed_at within the cutoff window
 *   - the task is still listed in some OTHER task's `blocked_by` where
 *     that other task is not yet completed (compaction must not
 *     orphan dependency references for unresolved dependents)
 *
 * No LLM calls. The "summary" is just title + result + key metadata;
 * callers supply clean result strings via `complete-task --result`.
 *
 * Idempotent: running twice over the same data does nothing the
 * second time because eligible tasks have already been removed.
 */
export interface CompactTasksReport {
  archived: Array<{ id: string; archive_file: string }>;
  skipped: Array<{ id: string; reason: string }>;
  dry_run: boolean;
}

export function compactTasks(
  paths: BusPaths,
  options: { olderThanDays?: number; dryRun?: boolean } = {},
): CompactTasksReport {
  const { olderThanDays = 30, dryRun = false } = options;
  const report: CompactTasksReport = { archived: [], skipped: [], dry_run: dryRun };
  const cutoffMs = Date.now() - olderThanDays * 86400_000;

  const { taskDir } = paths;
  let files: string[];
  try {
    files = readdirSync(taskDir).filter(f => f.startsWith('task_') && f.endsWith('.json'));
  } catch {
    return report;
  }

  // First pass: load every task so we can check cross-task dependency
  // references without re-reading files per candidate.
  const tasks: Task[] = [];
  for (const f of files) {
    try { tasks.push(JSON.parse(readFileSync(join(taskDir, f), 'utf-8')) as Task); }
    catch { /* skip corrupt */ }
  }

  // Build a "still-needed" set: the TRANSITIVE blocker closure of
  // every open task. A completed blocker must survive compaction as
  // long as ANY open task has it in its blocked_by chain — not just
  // direct parents. With A <- B <- C and C open, the direct-only
  // guard preserved B but archived A, leaving B with a dangling
  // reference to an archived task. Phase 4 directive was
  // "still in the blocked_by chain of a pending task" — the
  // full-chain reading is the correct one.
  const byId = new Map<string, Task>();
  for (const t of tasks) byId.set(t.id, t);
  const stillNeededAsBlocker = new Set<string>();
  const stack: string[] = [];
  for (const t of tasks) {
    if (t.status === 'completed') continue;
    for (const blockerId of t.blocked_by ?? []) stack.push(blockerId);
  }
  while (stack.length) {
    const cur = stack.pop()!;
    if (stillNeededAsBlocker.has(cur)) continue;
    stillNeededAsBlocker.add(cur);
    const parent = byId.get(cur);
    if (parent?.blocked_by?.length) stack.push(...parent.blocked_by);
  }

  for (const task of tasks) {
    if (task.status !== 'completed') continue;
    if (!task.completed_at) { report.skipped.push({ id: task.id, reason: 'no completed_at timestamp' }); continue; }
    const completedMs = new Date(task.completed_at).getTime();
    if (isNaN(completedMs) || completedMs > cutoffMs) {
      report.skipped.push({ id: task.id, reason: 'completed_at within cutoff' });
      continue;
    }
    if (stillNeededAsBlocker.has(task.id)) {
      report.skipped.push({ id: task.id, reason: 'still referenced by an open task\'s blocked_by chain' });
      continue;
    }

    // task.id (from the file's JSON body) is used to unlink the source file
    // below; a tampered id must not delete a file outside the task tree.
    try { validateTaskId(task.id); } catch { report.skipped.push({ id: String(task.id), reason: 'invalid task id (path-traversal guard)' }); continue; }

    const yyyymm = task.completed_at.substring(0, 7); // YYYY-MM
    // completed_at is from the JSON body and feeds the archive filename below;
    // reject anything that isn't a literal YYYY-MM so a tampered timestamp can't
    // traverse out of the task tree via the archive path.
    if (!/^\d{4}-\d{2}$/.test(yyyymm)) {
      report.skipped.push({ id: String(task.id), reason: 'invalid completed_at (path-traversal guard)' });
      continue;
    }
    const archiveFile = `archive-${yyyymm}.jsonl`;
    const archivePath = join(taskDir, archiveFile);
    const entry = {
      id: task.id,
      title: task.title,
      org: task.org,
      assigned_to: task.assigned_to,
      completed_at: task.completed_at,
      archived_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      result: task.result ?? '',
    };

    if (!dryRun) {
      try {
        appendFileSync(archivePath, JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });
        unlinkSync(join(taskDir, `${task.id}.json`));
      } catch (err) {
        report.skipped.push({ id: task.id, reason: `archive write failed: ${err}` });
        continue;
      }
    }
    report.archived.push({ id: task.id, archive_file: archiveFile });
  }

  return report;
}

/**
 * Find stale human-assigned tasks. Matches bash check-human-tasks.sh behavior.
 */
export function checkHumanTasks(paths: BusPaths): Task[] {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const STALE_THRESHOLD = 86400; // 24 hours

  const tasks = readAllTasks(paths.taskDir);
  const result: Task[] = [];

  for (const task of tasks) {
    if (task.status === 'completed' || task.status === 'cancelled') continue;
    if (!['human', 'user'].includes(task.assigned_to ?? '') && task.project !== 'human-tasks') continue;

    const createdEpoch = Math.floor(new Date(task.created_at).getTime() / 1000);
    const age = nowEpoch - createdEpoch;

    if (age > STALE_THRESHOLD) {
      result.push(task);
    }
  }

  return result;
}
