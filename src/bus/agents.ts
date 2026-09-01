import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { AgentInfo, AgentConfig, BusPaths, Priority, RelayFanoutResult } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { sendMessage } from './message.js';
import { resolveAgentDir, parseQualifiedName } from '../utils/agent-dir.js';
import { randomString } from '../utils/random.js';
import { validateCapability, validateOrgName } from '../utils/validate.js';

/**
 * List all agents in the system.
 *
 * Merges two sources of truth:
 *   1. The framework directory scan (`${CTX_FRAMEWORK_ROOT}/orgs/<org>/agents/`)
 *      — this is what the daemon discovers and runs.
 *   2. `enabled-agents.json` — explicit user-set enable/disable state from
 *      `cortextos enable`/`disable` and the dashboard.
 *
 * BUG-028: previously this function treated `enabled-agents.json` as
 * authoritative — if the file existed, the directory scan was skipped, causing
 * `cortextos list-agents` to miss agents that the daemon was actually running.
 * Now both sources are always merged, with the file providing the explicit
 * enabled flag and the directory scan providing the canonical existence check.
 */
export function listAgents(ctxRoot: string, org?: string): AgentInfo[] {
  const agents: AgentInfo[] = [];
  const seen = new Set<string>();

  // 1. Read enabled-agents.json for explicit enable/disable state.
  // This is treated as metadata, not as the list of agents to display.
  const enabledFile = join(ctxRoot, 'config', 'enabled-agents.json');
  let enabledAgents: Record<string, { org?: string; enabled?: boolean }> = {};
  if (existsSync(enabledFile)) {
    try {
      enabledAgents = JSON.parse(readFileSync(enabledFile, 'utf-8'));
    } catch {
      // Skip corrupt file — fall through to directory scan only.
    }
  }

  // 2. ALWAYS scan org agent directories (BUG-028 fix).
  // The directory scan is now the primary source for "what agents exist".
  // The enabled-agents.json entries are merged in as metadata.
  const cliProjectRoot = process.env.CTX_FRAMEWORK_ROOT;
  const scanRoots: string[] = [];
  if (cliProjectRoot && existsSync(join(cliProjectRoot, 'orgs'))) {
    scanRoots.push(cliProjectRoot);
  }
  // Fallback: cwd, but ONLY when CTX_FRAMEWORK_ROOT is completely unset.
  // If CTX_FRAMEWORK_ROOT is set (even to a path without orgs/), respect it and
  // do not scan cwd — the caller explicitly configured a root that has no agents.
  // This prevents test contamination when cwd happens to be the framework repo.
  if (scanRoots.length === 0 && !cliProjectRoot) {
    const cwd = process.cwd();
    if (existsSync(join(cwd, 'orgs'))) {
      scanRoots.push(cwd);
    }
  }

  for (const root of scanRoots) {
    const orgsDir = join(root, 'orgs');
    if (!existsSync(orgsDir)) continue;

    let orgDirs: string[];
    try {
      orgDirs = readdirSync(orgsDir);
    } catch {
      continue;
    }

    for (const orgName of orgDirs) {
      if (org && orgName !== org) continue;

      const agentsDir = join(orgsDir, orgName, 'agents');
      if (!existsSync(agentsDir)) continue;

      let agentDirs: string[];
      try {
        agentDirs = readdirSync(agentsDir);
      } catch {
        continue;
      }

      for (const agentName of agentDirs) {
        if (!/^[a-z0-9_-]+$/.test(agentName)) continue;
        if (seen.has(agentName)) continue;

        seen.add(agentName);

        // Determine enabled state: explicit from enabled-agents.json if present,
        // otherwise default to enabled (matches the daemon's discoverAndStart
        // default-on behavior).
        const explicitEntry = enabledAgents[agentName];
        const isEnabled = explicitEntry ? explicitEntry.enabled !== false : true;

        agents.push(buildAgentInfo(agentName, orgName, isEnabled, ctxRoot));
      }

      // Namespaced (per-engineer) agents: orgs/<org>/engineers/<eng>/agents/<name>
      const engineersDir = join(orgsDir, orgName, 'engineers');
      if (existsSync(engineersDir)) {
        let engineerDirs: string[];
        try {
          engineerDirs = readdirSync(engineersDir);
        } catch {
          engineerDirs = [];
        }
        for (const engineer of engineerDirs) {
          if (!/^[a-z0-9_-]+$/.test(engineer)) continue;
          const nsAgentsDir = join(engineersDir, engineer, 'agents');
          if (!existsSync(nsAgentsDir)) continue;
          let nsAgentDirs: string[];
          try {
            nsAgentDirs = readdirSync(nsAgentsDir);
          } catch {
            continue;
          }
          for (const agentName of nsAgentDirs) {
            if (!/^[a-z0-9_-]+$/.test(agentName)) continue;
            const qualified = `${engineer}/${agentName}`;
            if (seen.has(qualified)) continue;
            seen.add(qualified);
            const explicitEntry = enabledAgents[qualified];
            const isEnabled = explicitEntry ? explicitEntry.enabled !== false : true;
            const info = buildAgentInfo(qualified, orgName, isEnabled, ctxRoot);
            info.engineer = engineer;
            agents.push(info);
          }
        }
      }
    }
  }

  // 3. Append any entries from enabled-agents.json that don't have a corresponding
  // directory on disk (stale registrations — file has them but the dir was deleted
  // or never existed). These are surfaced so users can clean them up.
  // Use parseQualifiedName to accept both bare names and namespaced names like
  // "aaron/dev" — the old inline regex /^[a-z0-9_-]+$/ silently dropped them.
  for (const [name, cfg] of Object.entries(enabledAgents)) {
    try { parseQualifiedName(name); } catch { continue; }
    if (seen.has(name)) continue;
    const agentOrg = cfg.org || '';
    if (org && agentOrg !== org) continue;
    seen.add(name);
    agents.push(buildAgentInfo(name, agentOrg, cfg.enabled !== false, ctxRoot));
  }

  return agents;
}

/**
 * Build an AgentInfo object by reading heartbeat, IDENTITY.md, and config.
 */
function buildAgentInfo(
  name: string,
  org: string,
  enabled: boolean,
  ctxRoot: string,
): AgentInfo {
  // Read heartbeat from state dir (bash uses state/{agent}/heartbeat.json)
  let lastHeartbeat: string | null = null;
  let currentTask: string | null = null;
  let mode: string | null = null;
  let running = false;

  const stateHeartbeat = join(ctxRoot, 'state', name, 'heartbeat.json');
  if (existsSync(stateHeartbeat)) {
    try {
      const hb = JSON.parse(readFileSync(stateHeartbeat, 'utf-8'));
      lastHeartbeat = hb.last_heartbeat || hb.timestamp || null;
      currentTask = hb.current_task || null;
      mode = hb.mode || null;
      // Running = heartbeat written within last 10 minutes
      if (lastHeartbeat) {
        const age = Date.now() - new Date(lastHeartbeat).getTime();
        running = age < 10 * 60 * 1000;
      }
    } catch {
      // Skip corrupt
    }
  }

  // Get display name and role from IDENTITY.md
  let role = '';
  let displayName: string | undefined;
  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || '';
  if (frameworkRoot) {
    const identityPaths = [
      join(resolveAgentDir(frameworkRoot, org, name), 'IDENTITY.md'),
      join(frameworkRoot, 'agents', name, 'IDENTITY.md'),
    ];
    for (const idPath of identityPaths) {
      if (existsSync(idPath)) {
        try {
          const content = readFileSync(idPath, 'utf-8');
          const lines = content.split('\n');

          // Parse "## Name" — user-configured display name (e.g. "Alpha", "Beta")
          const nameIdx = lines.findIndex(l => l.trim() === '## Name');
          if (nameIdx >= 0) {
            for (let i = nameIdx + 1; i < lines.length; i++) {
              const line = lines[i].trim();
              if (!line || line.startsWith('<!--')) continue;
              if (line.startsWith('##')) break;
              displayName = line;
              break;
            }
          }

          // Find "## Role" then take the first non-empty, non-comment line after it
          const roleIdx = lines.findIndex(l => l.startsWith('## Role'));
          if (roleIdx >= 0) {
            for (let i = roleIdx + 1; i < lines.length; i++) {
              const line = lines[i].trim();
              // Skip empty lines and HTML comment placeholders
              if (!line || line.startsWith('<!--') || line.startsWith('##')) break;
              role = line;
              break;
            }
          }
          // Fallback: first non-comment, non-heading line
          if (!role) {
            for (const line of lines) {
              const t = line.trim();
              if (t && !t.startsWith('#') && !t.startsWith('<!--')) {
                role = t;
                break;
              }
            }
          }
        } catch {
          // Skip
        }
        break;
      }
    }
  }

  // Read config.json for model info
  const configFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || '';
  if (configFrameworkRoot) {
    const configPaths = [
      join(resolveAgentDir(configFrameworkRoot, org, name), 'config.json'),
      join(configFrameworkRoot, 'agents', name, 'config.json'),
    ];
    for (const cfgPath of configPaths) {
      if (existsSync(cfgPath)) {
        try {
          const cfg: AgentConfig = JSON.parse(readFileSync(cfgPath, 'utf-8'));
          if (cfg.enabled !== undefined) enabled = cfg.enabled;
        } catch {
          // Skip
        }
        break;
      }
    }
  }

  return {
    name,
    org,
    display_name: displayName,
    role,
    enabled,
    running,
    last_heartbeat: lastHeartbeat,
    current_task: currentTask,
    mode,
  };
}

/**
 * Send an urgent notification to an agent.
 * Writes .urgent-signal file and sends a bus message.
 * Mirrors bash notify-agent.sh behavior.
 */
export function notifyAgent(
  paths: BusPaths,
  from: string,
  targetAgent: string,
  message: string,
  ctxRoot: string,
): void {
  // Write signal file to state dir
  const signalDir = join(ctxRoot, 'state', targetAgent);
  ensureDir(signalDir);

  const signal = {
    from,
    message,
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };

  atomicWriteSync(join(signalDir, '.urgent-signal'), JSON.stringify(signal));

  // Also send via normal message bus for persistence
  try {
    sendMessage(paths, from, targetAgent, 'urgent', message);
  } catch {
    // Ignore bus send failures - signal file is the primary mechanism
  }
}

/**
 * Return the names of every ENABLED agent in `org` whose config.json lists
 * `capability` in its `capabilities` array.
 *
 * Fix for the "angela-relay" single point of failure (task_1788300871646_92090539,
 * modeled on Hermes's `a2a_orchestrate(capability, mode="first")` —
 * task_1788300304747_69074594): a cross-boundary comms path used to require
 * hardcoding one specific agent's name as the sole handler. Tagging N agents
 * with the same capability (e.g. `"capabilities": ["comms-relay"]` in
 * config.json) lets `sendToCapability` fan a message out to all of them, so
 * the path survives any single tagged agent being down.
 *
 * Disabled agents are excluded — fanning a message out to an agent nobody
 * expects to run defeats the point of failover. Scoped to top-level org
 * agents (`orgs/<org>/agents/*`), matching where a relay/bridge role would
 * actually be assigned; engineer-namespaced personal agents are not
 * considered relay candidates.
 */
export function getAgentsWithCapability(ctxRoot: string, org: string, capability: string): string[] {
  validateOrgName(org);
  validateCapability(capability);

  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || '';
  if (!frameworkRoot) return [];

  const enabledNames = new Set(
    listAgents(ctxRoot, org)
      .filter(a => a.enabled && !a.engineer)
      .map(a => a.name),
  );

  const tagged: string[] = [];
  const agentsDir = join(frameworkRoot, 'orgs', org, 'agents');
  let agentDirs: string[];
  try {
    agentDirs = readdirSync(agentsDir);
  } catch {
    return [];
  }

  for (const agentName of agentDirs) {
    if (!enabledNames.has(agentName)) continue;
    const cfgPath = join(agentsDir, agentName, 'config.json');
    if (!existsSync(cfgPath)) continue;
    try {
      const cfg: AgentConfig = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      if (Array.isArray(cfg.capabilities) && cfg.capabilities.includes(capability)) {
        tagged.push(agentName);
      }
    } catch {
      // Skip unreadable/corrupt config.json — never let a bad file on one
      // agent hide a working relay on another.
    }
  }

  return tagged;
}

/**
 * Fan a message out to every enabled agent tagged with `capability` instead
 * of addressing one hardcoded agent name — the bus-level fix for the
 * "angela-relay" SPOF (task_1788300871646_92090539). Each tagged agent gets
 * its own copy in its own inbox (via `sendMessage`), all sharing one
 * `fanout.id`. First-ack-wins: whichever recipient calls `ack-inbox` first
 * has `ackInbox` (bus/message.ts) cancel the others' still-pending copies —
 * modeled on Hermes's `a2a_orchestrate(mode="first")`
 * (task_1788300304747_69074594).
 *
 * Throws if no enabled agent currently carries the capability — a silent
 * no-op fan-out (0 recipients) would be worse than the SPOF it replaces,
 * since it fails without ever reaching anyone.
 */
export function sendToCapability(
  paths: BusPaths,
  from: string,
  org: string,
  capability: string,
  priority: Priority,
  text: string,
  replyTo?: string,
): RelayFanoutResult {
  const recipients = getAgentsWithCapability(paths.ctxRoot, org, capability);
  if (recipients.length === 0) {
    throw new Error(
      `No enabled agent in org '${org}' is tagged with capability '${capability}' — nothing to relay to. ` +
      `Tag at least one agent by adding "capabilities": ["${capability}"] to its config.json.`
    );
  }

  const fanoutId = `fanout-${Date.now()}-${randomString(6)}`;
  const msgIds = recipients.map(to =>
    sendMessage(paths, from, to, priority, text, replyTo, { id: fanoutId, capability, recipients }),
  );

  return { fanoutId, capability, recipients, msgIds };
}
