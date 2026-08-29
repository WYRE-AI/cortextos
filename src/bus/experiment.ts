import { readdirSync, readFileSync, existsSync, appendFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { randomString } from '../utils/random.js';
import { discoverAllAgents, resolveAgentDir } from '../utils/agent-dir.js';

// --- Types ---

export interface Experiment {
  id: string;
  agent: string;
  metric: string;
  hypothesis: string;
  surface: string;
  direction: 'higher' | 'lower';
  window: string;
  measurement: string;
  status: 'proposed' | 'running' | 'completed';
  /** The baseline this experiment was actually evaluated against. Frozen at
   * whatever value it held when the experiment was created — evaluateExperiment
   * never mutates it. Historical fact: "what was this cycle compared against."
   * Do NOT read this to seed the next cycle's --baseline; use next_baseline_value. */
  baseline_value: number | null;
  result_value: number | null;
  /** Independent qualitative-score field (--score). Distinct from result_value,
   * which always records the raw measuredValue actually passed to
   * evaluateExperiment — see that function's docstring for why they must not
   * be conflated. null when no score was given. */
  score: number | null;
  decision: 'keep' | 'discard' | null;
  /** Set by evaluateExperiment on completion: the value the NEXT experiment on
   * this metric should pass as --baseline. On 'keep' this is the effective
   * (decision-driving) value — the ratchet moves forward. On 'discard' it is
   * the unchanged baseline_value — nothing improved, so the target doesn't move.
   * null until the experiment completes. This is the ratchet mechanism;
   * baseline_value itself is never touched, so history stays readable. */
  next_baseline_value: number | null;
  /** True when this experiment's baseline_value was a forced placeholder (no
   * real prior measurement existed) rather than a genuine measured baseline.
   * Set at creation via --placeholder-baseline. Doesn't change decision
   * computation — only marks the completed record for manual review, since a
   * mechanical decision against a placeholder baseline isn't ground truth. */
  baseline_is_placeholder: boolean;
  /** Set true by evaluateExperiment on completion when baseline_is_placeholder
   * was true — flags that this record's decision needs a human/agent to
   * confirm it rather than being trusted as a normal mechanical result. */
  needs_manual_review: boolean;
  learning: string;
  experiment_commit: string | null;
  tracking_commit: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  changes_description: string | null;
  kind: 'intervention' | 'snapshot';
}

export interface ExperimentCreateOptions {
  surface?: string;
  direction?: 'higher' | 'lower';
  window?: string;
  measurement?: string;
  approval_required?: boolean;
  kind?: 'intervention' | 'snapshot';
  baseline?: number;
  baselineIsPlaceholder?: boolean;
}

export interface ExperimentEvaluateOptions {
  learning?: string;
  score?: number;
  justification?: string;
}

export interface ExperimentFilters {
  status?: string;
  metric?: string;
  agent?: string;
}

export interface GatherContextOptions {
  format?: 'json' | 'markdown';
}

export interface ExperimentContext {
  agent: string;
  total_experiments: number;
  keeps: number;
  discards: number;
  keep_rate: number;
  learnings: string;
  results_tsv: string;
  identity: string;
  goals: string;
}

export interface ExperimentCycle {
  name: string;
  agent: string;
  metric: string;
  metric_type: 'quantitative' | 'qualitative';
  surface: string;
  direction: 'higher' | 'lower';
  window: string;
  measurement: string;
  loop_interval: string;
  enabled: boolean;
  created_by: string;
  created_at: string;
}

export interface ExperimentConfig {
  approval_required?: boolean;
  cycles?: ExperimentCycle[];
  theta_wave?: {
    enabled?: boolean;
    interval?: string;
    metric?: string;
    metric_type?: string;
    direction?: string;
    auto_create_agent_cycles?: boolean;
    auto_modify_agent_cycles?: boolean;
  };
  monitoring?: Record<string, unknown>;
}

// --- Helpers ---

function nowISO(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function historyDir(agentDir: string): string {
  return join(agentDir, 'experiments', 'history');
}

function loadExperiment(agentDir: string, experimentId: string): Experiment {
  const filePath = join(historyDir(agentDir), `${experimentId}.json`);
  if (!existsSync(filePath)) {
    throw new Error(`Experiment ${experimentId} not found`);
  }
  return JSON.parse(readFileSync(filePath, 'utf-8').trim());
}

function saveExperiment(agentDir: string, experiment: Experiment): void {
  const dir = historyDir(agentDir);
  ensureDir(dir);
  atomicWriteSync(join(dir, `${experiment.id}.json`), JSON.stringify(experiment, null, 2));
}

export function loadExperimentConfig(agentDir: string): ExperimentConfig {
  return loadConfig(agentDir);
}

function loadConfig(agentDir: string): ExperimentConfig {
  const configPath = join(agentDir, 'experiments', 'config.json');
  if (!existsSync(configPath)) {
    return {};
  }
  return JSON.parse(readFileSync(configPath, 'utf-8').trim());
}

function saveConfig(agentDir: string, config: ExperimentConfig): void {
  const dir = join(agentDir, 'experiments');
  ensureDir(dir);
  atomicWriteSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
}

// --- Public API ---

/**
 * Guard for the create-experiment CLI boundary: refuses a missing --baseline
 * up front instead of letting the caller find out from evaluate-experiment's
 * refusal after the measurement window has already run and been wasted
 * (evaluateExperiment's own null-baseline guard is the last line of defense,
 * not the first). `raw` is the CLI flag's raw string value (undefined when
 * the flag was omitted) — pass `'0'` explicitly for a genuine from-zero
 * baseline, since that's a real value, not an omission.
 */
export function validateExperimentBaseline(raw: string | undefined): void {
  if (raw === undefined) {
    throw new Error(
      'create-experiment refused: no --baseline given.\n' +
      'evaluate-experiment will refuse to score this experiment later (comparing against an\n' +
      'implicit 0 baseline structurally forces every direction=higher result to KEEP) — but\n' +
      'that refusal only fires after the measurement window has already run, wasting it.\n' +
      'Pass --baseline <n>, or --baseline 0 if genuinely starting from zero.',
    );
  }
}

/**
 * Create a new experiment proposal.
 *
 * Fields with no explicit option fall back to the matching cycle in
 * `experiments/config.json` (same metric + same agent) before using the
 * static default. The autoresearch skill registers its measurement method,
 * direction, window, and surface once in the cycle config; with the cycle
 * fallback, repeat experiments on that metric stop losing the measurement
 * description because the agent forgot to pass --measurement.
 * Explicit options always win over the cycle so ad-hoc overrides still work.
 */
export function createExperiment(
  agentDir: string,
  agentName: string,
  metric: string,
  hypothesis: string,
  options?: ExperimentCreateOptions,
): string {
  const epoch = Math.floor(Date.now() / 1000);
  const rand = randomString(5);
  const id = `exp_${epoch}_${rand}`;

  const cycleDefaults = findCycleDefaults(agentDir, agentName, metric);

  const experiment: Experiment = {
    id,
    agent: agentName,
    metric,
    hypothesis,
    surface: options?.surface ?? cycleDefaults.surface ?? '',
    direction: options?.direction ?? cycleDefaults.direction ?? 'higher',
    window: options?.window ?? cycleDefaults.window ?? '24h',
    measurement: options?.measurement ?? cycleDefaults.measurement ?? '',
    status: 'proposed',
    baseline_value: options?.baseline ?? null,
    result_value: null,
    score: null,
    decision: null,
    next_baseline_value: null,
    baseline_is_placeholder: options?.baselineIsPlaceholder ?? false,
    needs_manual_review: false,
    learning: '',
    experiment_commit: null,
    tracking_commit: null,
    created_at: nowISO(),
    started_at: null,
    completed_at: null,
    changes_description: null,
    kind: options?.kind ?? 'intervention',
  };

  saveExperiment(agentDir, experiment);

  return id;
}

/**
 * Look up cycle-level defaults for a new experiment on the given metric.
 * Matches a cycle by metric + agent. Returns an empty object if no cycle
 * is configured — createExperiment then falls through to its static
 * defaults. Best-effort: any config-read error returns empty so the
 * experiment create path never breaks on malformed config.
 */
function findCycleDefaults(
  agentDir: string,
  agentName: string,
  metric: string,
): Partial<Pick<ExperimentCreateOptions, 'surface' | 'direction' | 'window' | 'measurement'>> {
  try {
    const config = loadConfig(agentDir);
    const cycle = config.cycles?.find(
      (c) => c.metric === metric && c.agent === agentName,
    );
    if (!cycle) return {};
    return {
      surface: cycle.surface || undefined,
      direction: cycle.direction || undefined,
      window: cycle.window || undefined,
      measurement: cycle.measurement || undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Start running a proposed experiment.
 */
export function runExperiment(
  agentDir: string,
  experimentId: string,
  changesDescription?: string,
): Experiment {
  const experiment = loadExperiment(agentDir, experimentId);

  if (experiment.status !== 'proposed') {
    throw new Error(`Experiment ${experimentId} is '${experiment.status}', expected 'proposed'`);
  }

  experiment.status = 'running';
  experiment.started_at = nowISO();
  if (changesDescription) {
    experiment.changes_description = changesDescription;
  }

  saveExperiment(agentDir, experiment);

  // Write active.json
  const activeDir = join(agentDir, 'experiments');
  ensureDir(activeDir);
  atomicWriteSync(join(activeDir, 'active.json'), JSON.stringify(experiment, null, 2));

  return experiment;
}

/**
 * Evaluate a running experiment with a measured value.
 */
export function evaluateExperiment(
  agentDir: string,
  experimentId: string,
  measuredValue: number,
  options?: ExperimentEvaluateOptions,
): Experiment {
  const experiment = loadExperiment(agentDir, experimentId);

  if (experiment.status !== 'running') {
    throw new Error(`Experiment ${experimentId} is '${experiment.status}', expected 'running'`);
  }

  if (experiment.baseline_value === null) {
    throw new Error(
      `Experiment ${experimentId} has no baseline_value — it was created without --baseline. ` +
      `Refusing to evaluate: comparing against an implicit 0 baseline structurally forces ` +
      `every 'direction=higher' result to KEEP, which is a measurement-integrity bug, not a ` +
      `valid measurement. Re-create the experiment with --baseline <n>.`,
    );
  }
  const baseline = experiment.baseline_value;

  // score only ever drives the decision for a QUALITATIVE evaluation, whose
  // convention (see every --score test) is a placeholder measuredValue of 0.
  // A non-zero measuredValue given alongside --score is ambiguous — which one
  // is real? — and score would silently win, discarding a genuine measurement
  // for decision purposes. Refuse rather than guess (cortextos analyst spec,
  // adoption's exp_1786934595_ltugf: self-inflicted --score alongside a real
  // measured_value=8 silently flipped a correct 'keep' into a wrong 'discard').
  if (options?.score !== undefined && measuredValue !== 0) {
    throw new Error(
      `evaluate-experiment refused: --score ${options.score} given alongside a non-zero ` +
      `measured_value (${measuredValue}). --score is only for qualitative metrics, where ` +
      `measured_value is passed as a 0 placeholder and score is the real value. Passing a ` +
      `real measured_value AND a score is ambiguous — which one should drive the keep/discard ` +
      `decision? Pass measured_value 0 if this is a qualitative evaluation (score drives), or ` +
      `drop --score if this is a quantitative evaluation (measured_value drives).`,
    );
  }

  // The value the keep/discard decision (and, on keep, the next baseline) is
  // computed against. For qualitative metrics the agent passes 0 as a
  // placeholder measuredValue and --score 7 as the real one, so score — when
  // given — IS the effective value, not measuredValue. This does NOT touch
  // result_value below: result_value always records measuredValue exactly as
  // passed, and score (when given) is stored in its own field. Conflating the
  // two used to overwrite result_value with the score, destroying the record
  // of what was actually passed as measuredValue (e.g. the placeholder 0) and
  // leaving no way to tell, from stored history, whether a given number was a
  // real measurement or a qualitative score.
  const effectiveValue = options?.score !== undefined ? options.score : measuredValue;

  let decision: 'keep' | 'discard';
  if (experiment.direction === 'higher') {
    decision = effectiveValue > baseline ? 'keep' : 'discard';
  } else {
    decision = effectiveValue < baseline ? 'keep' : 'discard';
  }

  experiment.status = 'completed';
  experiment.completed_at = nowISO();
  experiment.result_value = measuredValue;
  experiment.score = options?.score ?? null;
  experiment.decision = decision;

  if (experiment.baseline_is_placeholder) {
    experiment.needs_manual_review = true;
    console.error(
      `⚠ ${experimentId}: baseline_value was a placeholder (no real prior existed) — ` +
      `decision '${decision}' is mechanical, not ground truth. Needs manual review before ` +
      `treating this result as a real keep/discard.`,
    );
  }

  // Build learning from options
  const learningParts: string[] = [];
  if (options?.learning) learningParts.push(options.learning);
  if (options?.justification) learningParts.push(options.justification);
  if (learningParts.length > 0) {
    experiment.learning = learningParts.join(' — ');
  }

  // next_baseline_value is the ratchet: what the NEXT experiment on this
  // metric should pass as --baseline. On keep it's the effective
  // (decision-driving) value, so a qualitative metric's next evaluation
  // compares score against score, not score against a stale placeholder. On
  // discard nothing improved, so the target for next time doesn't move.
  // baseline_value itself is NEVER touched here — it stays the frozen fact of
  // what THIS cycle was actually compared against, so a reader auditing a
  // completed experiment sees real history instead of a clobbered value that
  // happens to equal its own result (cortextos analyst spec, 2026-08-27).
  experiment.next_baseline_value = decision === 'keep' ? effectiveValue : baseline;

  saveExperiment(agentDir, experiment);

  // Append to results.tsv. measured_value always mirrors result_value (raw,
  // never the score) — score gets its own column — so the tsv can't drift
  // from the JSON source of truth the way it used to when both were derived
  // from the same silently-reassigned local.
  const expDir = join(agentDir, 'experiments');
  ensureDir(expDir);
  const tsvPath = join(expDir, 'results.tsv');
  if (!existsSync(tsvPath)) {
    appendFileSync(
      tsvPath,
      'experiment_id\tagent\tmetric\tmeasured_value\tbaseline\tdecision\thypothesis\ttimestamp\tscore\n',
      'utf-8',
    );
  }
  // score is APPENDED last, not inserted mid-row: the header is only ever
  // written for a brand-new file (guarded above), so a pre-existing
  // results.tsv keeps its original 8-column header forever. A mid-row
  // insert would silently shift baseline/decision/hypothesis/timestamp one
  // position out of alignment with that old header on every future row —
  // a trailing column is backward-compatible for any positional reader,
  // an inserted one is not (walter, cortextos#90 review).
  const tsvLine = [
    experiment.id,
    experiment.agent,
    experiment.metric,
    String(measuredValue),
    String(decision === 'keep' ? effectiveValue : baseline),
    decision,
    experiment.hypothesis,
    experiment.completed_at,
    experiment.score === null ? '' : String(experiment.score),
  ].join('\t');
  appendFileSync(tsvPath, tsvLine + '\n', 'utf-8');

  // Append to learnings.md
  const learningsPath = join(expDir, 'learnings.md');
  if (!existsSync(learningsPath)) {
    appendFileSync(learningsPath, '# Experiment Learnings\n\n', 'utf-8');
  }
  const resultLine =
    experiment.score !== null
      ? `- **Result:** score ${experiment.score} (measured_value: ${measuredValue}, baseline: ${decision === 'keep' ? effectiveValue : baseline})`
      : `- **Result:** ${measuredValue} (baseline: ${decision === 'keep' ? effectiveValue : baseline})`;
  const learningEntry = [
    `## ${experiment.id} (${decision})`,
    `- **Metric:** ${experiment.metric}`,
    `- **Hypothesis:** ${experiment.hypothesis}`,
    resultLine,
    experiment.learning ? `- **Learning:** ${experiment.learning}` : '',
    '',
  ]
    .filter(Boolean)
    .join('\n');
  appendFileSync(learningsPath, learningEntry + '\n', 'utf-8');

  // Remove active.json
  const activePath = join(expDir, 'active.json');
  if (existsSync(activePath)) {
    try {
      unlinkSync(activePath);
    } catch {
      // ignore
    }
  }

  return experiment;
}

/**
 * List experiments with optional filters.
 */
export function listExperiments(
  agentDir: string,
  filters?: ExperimentFilters,
): Experiment[] {
  const dir = historyDir(agentDir);
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }

  let experiments: Experiment[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), 'utf-8').trim();
      experiments.push(JSON.parse(content));
    } catch {
      // skip corrupt files
    }
  }

  if (filters?.status) {
    experiments = experiments.filter(e => e.status === filters.status);
  }
  if (filters?.metric) {
    experiments = experiments.filter(e => e.metric === filters.metric);
  }
  if (filters?.agent) {
    experiments = experiments.filter(e => e.agent === filters.agent);
  }

  // Sort by created_at desc
  experiments.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return experiments;
}

/**
 * List experiments across every agent in the system, not just one directory.
 *
 * task_1785723303692: `bus list-experiments` with no --agent used to silently
 * fall back to the caller's own agentDir — a "list every experiment" scan
 * quietly returning a subset with no error. Uses the same canonical fleet
 * enumerator as list-agents/checkGoalStaleness so the definition of "every
 * agent" can't drift between callers.
 */
export function listAllExperiments(
  frameworkRoot: string,
  ctxRoot: string,
  filters?: Pick<ExperimentFilters, 'status' | 'metric'>,
): Experiment[] {
  const agents = discoverAllAgents(frameworkRoot, ctxRoot);
  const experiments = agents.flatMap(a =>
    listExperiments(resolveAgentDir(frameworkRoot, a.org, a.name), filters),
  );
  experiments.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return experiments;
}

// The baseline a completed experiment's derived views (results.tsv,
// gatherContext) should display. Recomputed LIVE from decision/score/
// result_value/baseline_value — the same rule evaluateExperiment used —
// rather than trusting the stored next_baseline_value field directly. That
// matters because every real correction incident in this corpus (murph,
// adoption) hand-edited only the `decision` field; recomputing from decision
// keeps the ratchet target self-consistent with a decision-only correction
// instead of silently displaying a now-stale next_baseline_value alongside a
// corrected decision (task_1787278742191_41460753 item D).
function displayBaseline(experiment: Experiment): number | null {
  if (experiment.decision === null || experiment.result_value === null || experiment.baseline_value === null) {
    return experiment.baseline_value;
  }
  const effectiveValue = experiment.score ?? experiment.result_value;
  return experiment.decision === 'keep' ? effectiveValue : experiment.baseline_value;
}

// Regenerate the results.tsv content from live experiment records, oldest
// first (matching the append order the physical file uses). Reading the
// static file directly would go stale the moment any completed record is
// corrected after the fact — this always matches listExperiments/
// list-experiments for the same experiment id (task_1787278742191_41460753).
function formatResultsTsv(completed: Experiment[]): string {
  if (completed.length === 0) return '';
  const rows = [...completed].sort(
    (a, b) => new Date(a.completed_at ?? 0).getTime() - new Date(b.completed_at ?? 0).getTime(),
  );
  const lines = ['experiment_id\tagent\tmetric\tmeasured_value\tbaseline\tdecision\thypothesis\ttimestamp\tscore'];
  for (const exp of rows) {
    lines.push([
      exp.id,
      exp.agent,
      exp.metric,
      String(exp.result_value),
      String(displayBaseline(exp)),
      exp.decision,
      exp.hypothesis,
      exp.completed_at,
      exp.score === null ? '' : String(exp.score),
    ].join('\t'));
  }
  return lines.join('\n') + '\n';
}

// Regenerate learnings.md content the same way, for the same staleness reason.
function formatLearnings(completed: Experiment[]): string {
  if (completed.length === 0) return '';
  const rows = [...completed].sort(
    (a, b) => new Date(a.completed_at ?? 0).getTime() - new Date(b.completed_at ?? 0).getTime(),
  );
  const entries = rows.map(exp => {
    const resultLine = exp.score !== null
      ? `- **Result:** score ${exp.score} (measured_value: ${exp.result_value}, baseline: ${displayBaseline(exp)})`
      : `- **Result:** ${exp.result_value} (baseline: ${displayBaseline(exp)})`;
    return [
      `## ${exp.id} (${exp.decision})`,
      `- **Metric:** ${exp.metric}`,
      `- **Hypothesis:** ${exp.hypothesis}`,
      resultLine,
      exp.learning ? `- **Learning:** ${exp.learning}` : '',
      '',
    ].filter(Boolean).join('\n');
  });
  return '# Experiment Learnings\n\n' + entries.join('\n') + '\n';
}

/**
 * Gather experiment context for an agent: learnings, stats, identity, goals.
 */
export function gatherContext(
  agentDir: string,
  agentName: string,
  _options?: GatherContextOptions,
): ExperimentContext {
  // Calculate stats from history
  const all = listExperiments(agentDir);
  const completed = all.filter(e => e.status === 'completed');
  const keeps = completed.filter(e => e.decision === 'keep').length;
  const discards = completed.filter(e => e.decision === 'discard').length;
  const total = all.length;
  const keepRate = completed.length > 0 ? keeps / completed.length : 0;

  // learnings/results_tsv are regenerated fresh from `completed` above, not
  // read from the static learnings.md/results.tsv files — those files are
  // append-only and never rewritten if a completed record is corrected later,
  // so reading them directly could serve a value that has gone stale relative
  // to list-experiments for the same experiment id (analyst spec item 3).
  const learnings = formatLearnings(completed);
  const resultsTsv = formatResultsTsv(completed);

  // Read agent IDENTITY.md and GOALS.md
  const identityPath = join(agentDir, 'IDENTITY.md');
  const identity = existsSync(identityPath) ? readFileSync(identityPath, 'utf-8') : '';

  const goalsPath = join(agentDir, 'GOALS.md');
  const goals = existsSync(goalsPath) ? readFileSync(goalsPath, 'utf-8') : '';

  return {
    agent: agentName,
    total_experiments: total,
    keeps,
    discards,
    keep_rate: keepRate,
    learnings,
    results_tsv: resultsTsv,
    identity,
    goals,
  };
}

/**
 * Manage experiment cycles in config.json.
 */
export function manageCycle(
  agentDir: string,
  action: 'create' | 'modify' | 'remove' | 'list',
  options: {
    agent?: string;
    name?: string;
    metric?: string;
    metric_type?: 'quantitative' | 'qualitative';
    surface?: string;
    direction?: 'higher' | 'lower';
    window?: string;
    measurement?: string;
    loop_interval?: string;
    enabled?: boolean;
  },
): ExperimentCycle[] {
  const config = loadConfig(agentDir);
  if (!config.cycles) {
    config.cycles = [];
  }

  switch (action) {
    case 'create': {
      if (!options.name || !options.agent || !options.metric) {
        throw new Error('Cycle create requires name, agent, and metric');
      }
      const cycle: ExperimentCycle = {
        name: options.name,
        agent: options.agent,
        metric: options.metric,
        metric_type: options.metric_type || 'qualitative',
        surface: options.surface || '',
        direction: options.direction || 'higher',
        window: options.window || '24h',
        measurement: options.measurement || '',
        loop_interval: options.loop_interval || options.window || '24h',
        enabled: true,
        created_by: options.agent,
        created_at: nowISO(),
      };
      config.cycles.push(cycle);
      saveConfig(agentDir, config);
      return config.cycles;
    }

    case 'modify': {
      if (!options.name) {
        throw new Error('Cycle modify requires name');
      }
      const idx = config.cycles.findIndex(c => c.name === options.name);
      if (idx === -1) {
        throw new Error(`Cycle '${options.name}' not found`);
      }
      if (options.metric) config.cycles[idx].metric = options.metric;
      if (options.metric_type) config.cycles[idx].metric_type = options.metric_type;
      if (options.surface) config.cycles[idx].surface = options.surface;
      if (options.direction) config.cycles[idx].direction = options.direction;
      if (options.enabled !== undefined) config.cycles[idx].enabled = options.enabled;
      if (options.window) config.cycles[idx].window = options.window;
      if (options.measurement) config.cycles[idx].measurement = options.measurement;
      if (options.loop_interval) config.cycles[idx].loop_interval = options.loop_interval;
      if (options.agent) config.cycles[idx].agent = options.agent;
      saveConfig(agentDir, config);
      return config.cycles;
    }

    case 'remove': {
      if (!options.name) {
        throw new Error('Cycle remove requires name');
      }
      const removeIdx = config.cycles.findIndex(c => c.name === options.name);
      if (removeIdx === -1) {
        throw new Error(`Cycle '${options.name}' not found`);
      }
      config.cycles.splice(removeIdx, 1);
      saveConfig(agentDir, config);
      return config.cycles;
    }

    case 'list': {
      // When an agent filter is supplied, return only that agent's cycles.
      // Omitting the agent returns the full list (back-compat for callers
      // that explicitly want a global view).
      if (options.agent) {
        return config.cycles.filter((c) => c.agent === options.agent);
      }
      return config.cycles;
    }

    default:
      throw new Error(`Unknown cycle action: ${action}`);
  }
}
