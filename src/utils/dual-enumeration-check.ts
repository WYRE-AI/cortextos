/**
 * Fail-loud dual enumeration check.
 *
 * Origin (2026-08-15): three independent same-night incidents where an
 * enumeration tool undercounted with NO error — a smaller number that
 * looked like a complete answer:
 *   - the shell `grep` shim (ugrep) honours .gitignore -> blind to
 *     tracked-but-ignored-matching files
 *   - `git grep` honours the git index -> blind to gitignored trees
 *     entirely (orgs/ is the live case)
 *   - `glob.glob('**\/*.md', recursive=True)` skips dot-directories ->
 *     missed 9/25 tracked files, no error
 * Three unrelated mechanisms, one output shape. A rule ("always
 * double-check") decays exactly like every other discipline unless it's
 * wired into something that runs by construction — this is that something.
 *
 * DESIGN CONSTRAINT (non-negotiable): the two backends compared MUST be
 * blind for DIFFERENT, KNOWN reasons. Pairing two tools that share a
 * blind spot (e.g. two .gitignore-respecting tools) produces a clean
 * agreement that proves nothing — the check reports "agreement" while
 * both sides silently miss the same files. Agreement between two sources
 * sharing an origin carries the information of ONE source, not two.
 *
 * The default pair is deliberately NOT the shimmed shell grep on either
 * side (its blindness is the one that started this incident). It is:
 *
 *   listGitTrackedFiles  — index-based. BLIND TO UNTRACKED files: never
 *                          `git add`ed, gitignored, or living under a
 *                          gitignored directory. Does NOT skip
 *                          dot-directories on its own.
 *   listAllFilesOnDisk   — raw filesystem walk. BLIND TO NOTHING — sees
 *                          every file that physically exists under root,
 *                          tracked or not, ignored or not, dot-prefixed
 *                          or not. It therefore "sees too much" relative
 *                          to either backend, which is exactly why it is
 *                          a genuine independent check rather than a
 *                          sibling with the same blind spot.
 *
 * Anyone adding a third backend must document its blindness the same way
 * these two do, and must NOT pick a backend whose blindness is a subset
 * or superset of an existing one (that reproduces the false-agreement
 * trap this file exists to prevent).
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * BLIND TO: any file not tracked in the git index — never `git add`ed,
 * matched by .gitignore before it was ever added, or living anywhere
 * under a gitignored directory (orgs/ is the live 2026-08-15 case).
 * NOT blind to: dot-directories — a tracked file under `.claude/` shows
 * up fine, because git tracking has nothing to do with leading dots.
 */
export function listGitTrackedFiles(root: string): string[] {
  const out = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  return out.split('\n').filter(Boolean).sort();
}

/**
 * BLIND TO: nothing. Walks every directory entry under root, including
 * dot-directories and gitignored content, and returns every file found.
 * The only path skipped is `.git/` itself — git's own bookkeeping, not
 * tree content, and skipping it is unconditional (not gitignore-driven).
 * This "sees too much" relative to a tool meant to answer "what does the
 * project actually contain" (build artifacts, scratch files, anything
 * never meant to be tracked) — that asymmetry with listGitTrackedFiles
 * (blind-to-untracked vs blind-to-nothing) is what makes the pair a
 * genuine independent check rather than two tools sharing a blind spot.
 */
export function listAllFilesOnDisk(root: string): string[] {
  const results: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        results.push(relative(root, full));
      }
    }
  };
  walk(root);
  return results.sort();
}

export interface EnumerationDisagreement {
  /** Present in the first backend's result but absent from the second's. */
  onlyInA: string[];
  /** Present in the second backend's result but absent from the first's. */
  onlyInB: string[];
}

export function diffEnumerations(a: string[], b: string[]): EnumerationDisagreement {
  const setA = new Set(a);
  const setB = new Set(b);
  return {
    onlyInA: a.filter((x) => !setB.has(x)).sort(),
    onlyInB: b.filter((x) => !setA.has(x)).sort(),
  };
}

export interface DualEnumerationOptions {
  backendA?: (root: string) => string[];
  backendB?: (root: string) => string[];
  labelA?: string;
  labelB?: string;
}

/**
 * Run a file enumeration two ways and throw with a full diff if they
 * disagree. Defaults to the orthogonal pair documented above
 * (listGitTrackedFiles / listAllFilesOnDisk); callers substituting a
 * different pair are responsible for keeping the two blind spots
 * genuinely independent — see the module docblock.
 */
export function assertFileEnumerationAgreement(root: string, opts: DualEnumerationOptions = {}): void {
  const backendA = opts.backendA ?? listGitTrackedFiles;
  const backendB = opts.backendB ?? listAllFilesOnDisk;
  const labelA = opts.labelA ?? 'git ls-files (index-based, blind to untracked)';
  const labelB = opts.labelB ?? 'raw filesystem walk (blind to nothing)';

  const { onlyInA, onlyInB } = diffEnumerations(backendA(root), backendB(root));
  if (onlyInA.length === 0 && onlyInB.length === 0) return;

  const lines = [`Enumeration disagreement under ${root}:`, `  '${labelA}' vs '${labelB}'`];
  if (onlyInA.length > 0) {
    lines.push(`  Only in ${labelA} (${onlyInA.length}): ${onlyInA.join(', ')}`);
  }
  if (onlyInB.length > 0) {
    lines.push(`  Only in ${labelB} (${onlyInB.length}): ${onlyInB.join(', ')}`);
  }
  lines.push(
    'A count that only one method found means the other is blind to something real ' +
      '— never trust the smaller number as complete without explaining the gap.',
  );
  throw new Error(lines.join('\n'));
}

/**
 * Return the verified/true file list under root: the union of both
 * backends. In practice this equals listAllFilesOnDisk's own result,
 * since it's documented as blind to nothing — the union is taken
 * defensively (and to state the intent honestly) rather than assuming
 * one backend can never be surprised. Callers who want the fail-loud
 * behavior on disagreement should call assertFileEnumerationAgreement
 * first; this function does not throw, it just answers "what's really
 * there."
 */
export function enumerateVerifiedFiles(root: string, opts: DualEnumerationOptions = {}): string[] {
  const backendA = opts.backendA ?? listGitTrackedFiles;
  const backendB = opts.backendB ?? listAllFilesOnDisk;
  return [...new Set([...backendA(root), ...backendB(root)])].sort();
}
