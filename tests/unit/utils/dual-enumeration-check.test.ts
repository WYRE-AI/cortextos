// tests/unit/utils/dual-enumeration-check.test.ts
//
// Acceptance discipline (restated 2026-08-15 after an over-narrow first
// draft of this same criterion): the helper's job is not to reproduce
// three separate tool blindnesses — the three blindnesses belong to OTHER
// tools (ugrep's .gitignore, glob's dot-directories, git grep's index),
// and this helper is not blind in any of those ways. Three isolated
// single-trap fixtures can each pass while the helper still miscounts a
// tree containing all three traps at once — a plausible partial wearing a
// passing test suite, which is exactly the class of bug this file exists
// to prevent.
//
// So the real tests are:
//   1. ONE combined fixture tree with all three trap shapes simultaneously
//      -> assert the helper's verified/true file set is exactly right.
//   2. A synthetic divergence -> assert the fail-loud path actually fires
//      (a helper that always agrees is as useless as one that always
//      objects).
//   3. One-line proofs that the REAL naive tools (git grep, python's
//      glob.glob) get the combined tree wrong — not testing this helper,
//      documenting that the traps are live and reproducible so a future
//      reader doesn't have to take their existence on faith.
//
// The three original single-shape fixture tests are kept below as
// regression coverage and as documentation of why each shape maps to the
// same underlying trigger against THIS backend pair (an untracked file
// the raw walk sees and git ls-files does not) — useful, but insufficient
// alone, which is why they're not the whole suite.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertFileEnumerationAgreement,
  diffEnumerations,
  enumerateVerifiedFiles,
  listAllFilesOnDisk,
  listGitTrackedFiles,
} from '../../../src/utils/dual-enumeration-check.js';

function initRepo(root: string): void {
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: root });
}

function commitAll(root: string): void {
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: root });
}

function binaryAvailable(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT = binary not found. Any other failure (e.g. a non-zero exit
    // from a deliberately-no-op probe command) means the binary exists.
    return code !== 'ENOENT';
  }
}

/**
 * Seeds ONE tree containing all three known trap shapes at once, plus a
 * normal tracked baseline file so the test can't pass by accident on an
 * empty/degenerate tree.
 */
function seedCombinedTrapTree(root: string): { allExpectedFiles: string[] } {
  writeFileSync(join(root, '.gitignore'), 'secret.md\norgs/\n');
  writeFileSync(join(root, 'README.md'), '# tracked baseline\n');
  commitAll(root);

  // Trap 1: .gitignore-shadowed file (ugrep-shim blindness). Matches the
  // ignore rule -> stays untracked, same as a real shadowed file would.
  writeFileSync(join(root, 'secret.md'), 'shhh\n');

  // Trap 2: file inside a dot-directory (python glob.glob blindness).
  mkdirSync(join(root, '.claude'));
  writeFileSync(join(root, '.claude', 'notes.md'), 'scratch\n');

  // Trap 3: file inside a gitignored subtree (git-grep blindness — orgs/
  // is the live 2026-08-15 case).
  mkdirSync(join(root, 'orgs', 'wyre', 'agents', 'dev', 'memory'), { recursive: true });
  writeFileSync(join(root, 'orgs', 'wyre', 'agents', 'dev', 'memory', '2026-08-15.md'), 'entry\n');

  return {
    allExpectedFiles: [
      '.gitignore',
      'README.md',
      'secret.md',
      '.claude/notes.md',
      'orgs/wyre/agents/dev/memory/2026-08-15.md',
    ].sort(),
  };
}

describe('diffEnumerations', () => {
  it('reports empty diff on identical lists', () => {
    expect(diffEnumerations(['a', 'b'], ['b', 'a'])).toEqual({ onlyInA: [], onlyInB: [] });
  });

  it('reports entries unique to each side', () => {
    expect(diffEnumerations(['a', 'b'], ['b', 'c'])).toEqual({ onlyInA: ['a'], onlyInB: ['c'] });
  });
});

describe('enumerateVerifiedFiles — the real acceptance test', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'enum-check-combined-'));
    initRepo(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns the exact true file set over a tree containing all three trap shapes at once', () => {
    const { allExpectedFiles } = seedCombinedTrapTree(root);

    expect(enumerateVerifiedFiles(root)).toEqual(allExpectedFiles);
  });
});

describe('assertFileEnumerationAgreement — fail-loud path', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'enum-check-divergence-'));
    initRepo(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Negative control: nothing hidden from either backend. A helper that
  // fires on genuine agreement is a decoration, not a control.
  it('does not throw when both backends genuinely agree', () => {
    writeFileSync(join(root, 'README.md'), '# hi\n');
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'notes.md'), 'notes\n');
    commitAll(root);

    expect(() => assertFileEnumerationAgreement(root)).not.toThrow();
  });

  // The mechanism test: prove the fail-loud path can actually fire, via
  // a single synthetic divergence (a file one backend sees and the other
  // cannot) — the minimal case, not tied to any of the three real shapes.
  it('throws when the two backends disagree, reporting which file and which side is missing it', () => {
    // A fresh repo (no commits at all) already has an empty git index —
    // no need to commit anything first for the divergence to exist.
    writeFileSync(join(root, 'only-on-disk.md'), 'x\n'); // untracked -> synthetic divergence

    try {
      assertFileEnumerationAgreement(root);
      expect.unreachable('expected assertFileEnumerationAgreement to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/only-on-disk\.md/);
      expect(message).toMatch(/Only in .*raw filesystem walk/);
      expect(message).not.toMatch(/Only in .*git ls-files.*only-on-disk\.md/s);
    }
  });

  it('catches disagreement on the combined trap tree (all three shapes present)', () => {
    seedCombinedTrapTree(root);
    expect(() => assertFileEnumerationAgreement(root)).toThrow(/Enumeration disagreement/);
  });

  // Kept as regression coverage / documentation for each individual
  // shape — insufficient alone (see file header) but still real and
  // still worth pinning down individually.
  it('catches a .gitignore-shadowed file in isolation (ugrep-shim blind spot)', () => {
    writeFileSync(join(root, '.gitignore'), 'secret.md\n');
    commitAll(root);
    writeFileSync(join(root, 'secret.md'), 'shhh\n');

    expect(() => assertFileEnumerationAgreement(root)).toThrow(/secret\.md/);
  });

  it('catches a file inside a dot-directory in isolation (python glob.glob blind spot)', () => {
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude', 'notes.md'), 'scratch\n');

    expect(() => assertFileEnumerationAgreement(root)).toThrow(/\.claude[/\\]notes\.md/);
  });

  it('catches a file inside a gitignored tree in isolation (git-grep blind spot, the orgs/ case)', () => {
    writeFileSync(join(root, '.gitignore'), 'orgs/\n');
    commitAll(root);
    mkdirSync(join(root, 'orgs', 'wyre', 'agents', 'dev', 'memory'), { recursive: true });
    writeFileSync(join(root, 'orgs', 'wyre', 'agents', 'dev', 'memory', '2026-08-15.md'), 'entry\n');

    expect(() => assertFileEnumerationAgreement(root)).toThrow(/orgs[/\\].*2026-08-15\.md/);
  });
});

// Availability is a property of the runner, not of any individual test's
// fixture — checked once at module load so it.skipIf sees a stable value
// and the skip shows up as its own SKIPPED entry in the test summary
// (distinct from the passed count), not a passing test that quietly
// proved nothing. A skip that only prints a warning from inside a
// passing test body is exactly the "confirming false positive" shape
// this file exists to guard against: a green build with a missing proof
// must be legible as a green build with a missing proof.
const hasPython3 = binaryAvailable('python3', ['--version']);
const hasUgrep = binaryAvailable('ugrep', ['--version']);

if (!hasPython3) {
  // eslint-disable-next-line no-console
  console.warn(
    "[dual-enumeration-check] SKIPPED: python3 not present, dot-directory trap (glob.glob) unproven on this runner",
  );
}
if (!hasUgrep) {
  // eslint-disable-next-line no-console
  console.warn(
    '[dual-enumeration-check] SKIPPED: ugrep not present, .gitignore-shadowing trap (grep) unproven on this runner',
  );
}

describe('the traps are real — proof against the actual naive tools, not this helper', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'enum-check-naive-proof-'));
    initRepo(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // git is guaranteed present (the fixture itself is a git repo) so this
  // one needs no availability gate.
  it('real `git grep` misses content inside a gitignored subtree', () => {
    seedCombinedTrapTree(root);

    let output = '';
    try {
      output = execFileSync('git', ['grep', '-l', 'entry'], { cwd: root, encoding: 'utf8' });
    } catch {
      // `git grep` exits 1 (no match) when it finds nothing — that IS the
      // blindness being documented, not a test failure.
      output = '';
    }
    expect(output).not.toMatch(/orgs\//);
  });

  it.skipIf(!hasPython3)(
    "real python glob.glob('**/*.md', recursive=True) skips dot-directories",
    () => {
      seedCombinedTrapTree(root);

      const script = "import glob, os; os.chdir(%s); print('\\n'.join(glob.glob('**/*.md', recursive=True)))";
      const out = execFileSync('python3', ['-c', script.replace('%s', JSON.stringify(root))], {
        encoding: 'utf8',
      });
      expect(out).not.toMatch(/\.claude/);
    },
  );

  // The 2026-08-15 incident's actual blindness (ugrep aliased with
  // --ignore-files) is a shell-config detail, not something a portable
  // test can assume exists in every environment/CI runner. GNU grep's
  // --exclude-from would reproduce it directly, but the default grep on
  // this Mac is BSD grep, which lacks that flag — so this gates on the
  // real ugrep binary being present rather than assuming a GNU-flag
  // substitute would work everywhere.
  it.skipIf(!hasUgrep)(
    'a .gitignore-respecting grep invocation misses a shadowed-but-present file',
    () => {
      seedCombinedTrapTree(root);

      let output = '';
      try {
        output = execFileSync('ugrep', ['-rl', '--ignore-files', 'shhh', root], { encoding: 'utf8' });
      } catch {
        output = '';
      }
      expect(output).not.toMatch(/secret\.md/);
    },
  );
});

describe('listGitTrackedFiles / listAllFilesOnDisk', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'enum-check-backends-'));
    initRepo(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('listGitTrackedFiles only reports tracked files', () => {
    writeFileSync(join(root, 'tracked.md'), 'x\n');
    commitAll(root);
    writeFileSync(join(root, 'untracked.md'), 'y\n');

    expect(listGitTrackedFiles(root)).toEqual(['tracked.md']);
  });

  it('listAllFilesOnDisk sees tracked and untracked files, skips only .git', () => {
    writeFileSync(join(root, 'tracked.md'), 'x\n');
    commitAll(root);
    writeFileSync(join(root, 'untracked.md'), 'y\n');

    const files = listAllFilesOnDisk(root);
    expect(files).toContain('tracked.md');
    expect(files).toContain('untracked.md');
    expect(files.some((f) => f.startsWith('.git/'))).toBe(false);
  });
});
