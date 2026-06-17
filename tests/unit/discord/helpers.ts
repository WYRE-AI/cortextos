/**
 * Shared test helpers for the Discord adapter unit tests.
 */
import { join } from 'path';
import type { BusPaths } from '../../../src/types/index';

export function makePaths(root: string, agent: string, org: string): BusPaths {
  return {
    ctxRoot: root,
    inbox: join(root, 'inbox', agent),
    inflight: join(root, 'inflight', agent),
    processed: join(root, 'processed', agent),
    logDir: join(root, 'logs', agent),
    stateDir: join(root, 'state', agent),
    taskDir: join(root, 'orgs', org, 'tasks'),
    approvalDir: join(root, 'orgs', org, 'approvals'),
    analyticsDir: join(root, 'orgs', org, 'analytics'),
    deliverablesDir: join(root, 'orgs', org, 'deliverables'),
  };
}
