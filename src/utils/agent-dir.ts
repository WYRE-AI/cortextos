import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { AGENT_NAME_REGEX } from './validate.js';

export interface DiscoveredAgent {
  /** Qualified name, ready to pass to resolveAgentDir/parseQualifiedName ("boss" or "aaron/dev"). */
  name: string;
  org: string;
  enabled: boolean;
}

export interface QualifiedName {
  /** Engineer namespace, if this is a personal agent. */
  engineer?: string;
  /** Bare agent name. */
  agent: string;
}

/**
 * Parse an agent reference into its parts.
 *   "boss"       -> { agent: 'boss' }            (shared org agent)
 *   "aaron/dev"  -> { engineer: 'aaron', agent: 'dev' }  (personal agent)
 */
export function parseQualifiedName(name: string): QualifiedName {
  const parts = name.split('/');
  if (parts.length > 2) {
    throw new Error(`Invalid qualified agent name "${name}": at most one "/" allowed.`);
  }
  if (parts.length === 2) {
    const [engineer, agent] = parts;
    if (!AGENT_NAME_REGEX.test(engineer)) {
      throw new Error(`Invalid engineer segment "${engineer}" in "${name}": must match ${AGENT_NAME_REGEX}.`);
    }
    if (!AGENT_NAME_REGEX.test(agent)) {
      throw new Error(`Invalid agent segment "${agent}" in "${name}": must match ${AGENT_NAME_REGEX}.`);
    }
    return { engineer, agent };
  }
  if (!AGENT_NAME_REGEX.test(name)) {
    throw new Error(`Invalid agent name "${name}": must match ${AGENT_NAME_REGEX}.`);
  }
  return { agent: name };
}

/**
 * Resolve the on-disk framework directory for an agent.
 * `frameworkRoot` is the cortextOS checkout (CTX_FRAMEWORK_ROOT).
 * `qualifiedName` is bare ("boss") or engineer-qualified ("aaron/dev").
 */
export function resolveAgentDir(frameworkRoot: string, org: string, qualifiedName: string): string {
  if (!frameworkRoot) {
    throw new Error('resolveAgentDir: frameworkRoot is empty — CTX_FRAMEWORK_ROOT is likely unset.');
  }
  const { engineer, agent } = parseQualifiedName(qualifiedName);
  if (engineer) {
    return join(frameworkRoot, 'orgs', org, 'engineers', engineer, 'agents', agent);
  }
  return join(frameworkRoot, 'orgs', org, 'agents', agent);
}

/**
 * Discover every agent in the system — the single source of truth for
 * "the full fleet", shared by any command that needs to scan/iterate all
 * agents rather than just the caller's own. Combines config/enabled-agents.json
 * with a filesystem scan of both shared org agents (orgs/ORG/agents/NAME) and
 * namespaced personal agents (orgs/ORG/engineers/ENGINEER/agents/NAME)
 * (a config entry alone doesn't guarantee a directory exists yet, and vice versa).
 *
 * task_1785723303692: originally duplicated inline in `bus list-agents` only —
 * any other fleet-wide scan (e.g. `list-experiments` with no --agent) that
 * re-implemented its own enumeration independently would silently drift out
 * of sync with this one (the "propagation-gap" sibling of silent-subset-scoping).
 * Extracted here so every fleet-wide scan shares one definition of "the fleet".
 */
export function discoverAllAgents(frameworkRoot: string, ctxRoot: string): DiscoveredAgent[] {
  const agentMap: Record<string, { org: string; enabled: boolean }> = {};

  // Guard on truthiness, not just existsSync: path.join('', 'config', ...)
  // silently resolves to a real CWD-relative path ("config/...") rather than
  // a safely-nonexistent one, so an empty/falsy ctxRoot from a caller that
  // doesn't have one must skip this lookup entirely, not join through it.
  const enabledFile = ctxRoot ? join(ctxRoot, 'config', 'enabled-agents.json') : '';
  if (enabledFile && existsSync(enabledFile)) {
    try {
      const data = JSON.parse(readFileSync(enabledFile, 'utf-8'));
      for (const [name, cfg] of Object.entries(data as Record<string, any>)) {
        agentMap[name] = { org: cfg.org ?? '', enabled: cfg.enabled !== false };
      }
    } catch { /* skip corrupt */ }
  }

  const orgsDir = join(frameworkRoot, 'orgs');
  if (existsSync(orgsDir)) {
    for (const org of readdirSync(orgsDir)) {
      // Shared agents: orgs/<org>/agents/<name>
      const agentsDir = join(orgsDir, org, 'agents');
      if (existsSync(agentsDir)) {
        for (const name of readdirSync(agentsDir)) {
          if (!agentMap[name]) agentMap[name] = { org, enabled: true };
        }
      }
      // Namespaced agents: orgs/<org>/engineers/<eng>/agents/<name>
      const engineersDir = join(orgsDir, org, 'engineers');
      if (existsSync(engineersDir)) {
        for (const engineer of readdirSync(engineersDir)) {
          const nsAgentsDir = join(engineersDir, engineer, 'agents');
          if (!existsSync(nsAgentsDir)) continue;
          for (const name of readdirSync(nsAgentsDir)) {
            const qualified = `${engineer}/${name}`;
            if (!agentMap[qualified]) agentMap[qualified] = { org, enabled: true };
          }
        }
      }
    }
  }

  return Object.entries(agentMap).map(([name, info]) => ({ name, org: info.org, enabled: info.enabled }));
}
