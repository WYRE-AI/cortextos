// tests/unit/utils/resolve-message-body.test.ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveMessageBody,
  resolveOptionalTextField,
  UnsafeInlineBodyError,
} from '../../../src/utils/resolve-message-body.js';

// The acceptance test (infra's spec, 2026-08-15): a body containing
// backticks, $(, and apostrophes must round-trip byte-identical. That
// replaces a weaker "cannot corrupt" criterion — byte-identical is
// checkable, "cannot corrupt" is a claim about intent.
const DANGEROUS_BODY = "task `task_1786762901707_37606875` costs $(echo 5) — don't drop it.";

describe('resolveMessageBody — safe paths (--body-file, stdin)', () => {
  it('--body-file round-trips a body containing backticks, $(, and apostrophes byte-identical', () => {
    const dir = mkdtempSync(join(tmpdir(), 'resolve-body-'));
    const file = join(dir, 'body.txt');
    writeFileSync(file, DANGEROUS_BODY);

    try {
      expect(resolveMessageBody({ bodyFile: file })).toBe(DANGEROUS_BODY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stdin round-trips a body containing backticks, $(, and apostrophes byte-identical', () => {
    const readStdin = () => DANGEROUS_BODY;
    expect(resolveMessageBody({ readStdin })).toBe(DANGEROUS_BODY);
  });

  it('--body-file takes priority over inlineText when both are given', () => {
    const dir = mkdtempSync(join(tmpdir(), 'resolve-body-'));
    const file = join(dir, 'body.txt');
    writeFileSync(file, 'from the file');

    try {
      expect(resolveMessageBody({ inlineText: 'from argv', bodyFile: file })).toBe('from the file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not apply the metachar/length checks to file or stdin content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'resolve-body-'));
    const file = join(dir, 'body.txt');
    const longDangerousBody = 'x'.repeat(600) + ' `oops` $(oops)';
    writeFileSync(file, longDangerousBody);
    const warn = vi.fn();

    try {
      expect(resolveMessageBody({ bodyFile: file, warn })).toBe(longDangerousBody);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveMessageBody — inline path (fail-closed)', () => {
  it('accepts a normal inline body with no shell metacharacters', () => {
    expect(resolveMessageBody({ inlineText: 'all clear, standing by' })).toBe('all clear, standing by');
  });

  it('rejects an inline body containing a backtick', () => {
    expect(() => resolveMessageBody({ inlineText: 'see `task_123` for context' })).toThrow(
      UnsafeInlineBodyError,
    );
  });

  it('rejects an inline body containing $(', () => {
    expect(() => resolveMessageBody({ inlineText: 'total is $(echo 5)' })).toThrow(UnsafeInlineBodyError);
  });

  it('the rejection error names the safe form', () => {
    try {
      resolveMessageBody({ inlineText: 'see `task_123`' });
      expect.unreachable('expected resolveMessageBody to throw');
    } catch (err) {
      expect((err as Error).message).toMatch(/--body-file/);
      expect((err as Error).message).toMatch(/stdin/);
    }
  });

  it('never sends a partially-substituted body — the exact received string is never returned on the reject path', () => {
    // The inline text here is what the shell ALREADY reduced the body to
    // (e.g. after a botched double-quoted substitution elsewhere) — if a
    // literal backtick/$( is still visible, resolveMessageBody must throw
    // rather than pass it through, however plausible-looking the string is.
    expect(() => resolveMessageBody({ inlineText: 'partial `' })).toThrow(UnsafeInlineBodyError);
  });

  it('warns (but still sends) on a long inline body with no metacharacters', () => {
    const warn = vi.fn();
    const longBody = 'a'.repeat(600);

    expect(resolveMessageBody({ inlineText: longBody, warn })).toBe(longBody);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/--body-file/);
  });

  it('does not warn on a short inline body', () => {
    const warn = vi.fn();
    resolveMessageBody({ inlineText: 'short and fine', warn });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('resolveMessageBody — priority order', () => {
  it('falls through to stdin only when neither bodyFile nor inlineText is given', () => {
    const readStdin = vi.fn(() => 'from stdin');
    expect(resolveMessageBody({ readStdin })).toBe('from stdin');
    expect(readStdin).toHaveBeenCalledOnce();
  });

  it('does not read stdin when inlineText is given (even an empty string)', () => {
    const readStdin = vi.fn(() => 'from stdin');
    expect(resolveMessageBody({ inlineText: '', readStdin })).toBe('');
    expect(readStdin).not.toHaveBeenCalled();
  });
});

// 2026-08-25 incident: boss piped a body via stdin but ALSO passed the
// conventional Unix "-" sentinel as the positional text argument (the
// convention curl/tar/git etc. use for "read this from stdin"). Because
// "-" !== undefined, the old code treated it as a literal one-character
// inline body — sent with no error, recipient got the text "-", sender got
// a normal message ID back. Four coordination messages were lost this way
// before anyone noticed. "-" must be an explicit, unambiguous stdin
// request, not literal text — never fall through to the metachar/length
// checks that ordinary inline text gets, and never silently succeed.
describe('resolveMessageBody — "-" is an explicit stdin sentinel', () => {
  it('reads from stdin when inlineText is exactly "-"', () => {
    const readStdin = vi.fn(() => 'piped body');
    expect(resolveMessageBody({ inlineText: '-', readStdin })).toBe('piped body');
    expect(readStdin).toHaveBeenCalledOnce();
  });

  it('round-trips a "-"-sentinel stdin body containing backticks/$()/apostrophes byte-identical', () => {
    const readStdin = () => DANGEROUS_BODY;
    expect(resolveMessageBody({ inlineText: '-', readStdin })).toBe(DANGEROUS_BODY);
  });

  it('--body-file still takes priority over a "-" sentinel', () => {
    const dir = mkdtempSync(join(tmpdir(), 'resolve-body-'));
    const file = join(dir, 'body.txt');
    writeFileSync(file, 'from the file');
    const readStdin = vi.fn(() => 'from stdin');

    try {
      expect(resolveMessageBody({ inlineText: '-', bodyFile: file, readStdin })).toBe('from the file');
      expect(readStdin).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a single dash can no longer be sent as literal text', () => {
    // Documents the deliberate behavior change: "-" is reserved as the
    // stdin sentinel, so it is not a valid inline body value any more.
    const readStdin = () => 'not a dash';
    expect(resolveMessageBody({ inlineText: '-', readStdin })).not.toBe('-');
  });
});

describe('resolveOptionalTextField — "-" is an explicit stdin sentinel', () => {
  it('reads from stdin when inlineText is exactly "-", even though omission does not', () => {
    const readStdin = vi.fn(() => 'piped description');
    expect(resolveOptionalTextField({ inlineText: '-', readStdin })).toBe('piped description');
    expect(readStdin).toHaveBeenCalledOnce();
  });

  it('still returns undefined on omission (the "-" sentinel does not change the no-stdin-on-omit default)', () => {
    const readStdin = vi.fn(() => 'should not be called');
    expect(resolveOptionalTextField({ readStdin })).toBeUndefined();
    expect(readStdin).not.toHaveBeenCalled();
  });

  it('--*-file still takes priority over a "-" sentinel', () => {
    const dir = mkdtempSync(join(tmpdir(), 'resolve-optional-'));
    const file = join(dir, 'desc.txt');
    writeFileSync(file, 'from the file');
    const readStdin = vi.fn(() => 'from stdin');

    try {
      expect(resolveOptionalTextField({ inlineText: '-', bodyFile: file, readStdin })).toBe('from the file');
      expect(readStdin).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// resolveOptionalTextField backs create-task's --desc and complete-task's
// result — free-text fields that must stay valid when OMITTED entirely
// (an empty task description is normal), so unlike resolveMessageBody they
// must never fall back to reading stdin. Same corruption class applies
// (2026-08-15, scribe: a stored task description missing backtick content
// it should have had), same fail-closed check, different default.
describe('resolveOptionalTextField', () => {
  it('returns undefined when neither inlineText nor bodyFile is given (does not read stdin)', () => {
    expect(resolveOptionalTextField({})).toBeUndefined();
  });

  it('returns the inline text unchanged when safe', () => {
    expect(resolveOptionalTextField({ inlineText: 'a normal description' })).toBe('a normal description');
  });

  it('rejects an inline value containing a backtick', () => {
    expect(() => resolveOptionalTextField({ inlineText: 'see `task_123`' })).toThrow(UnsafeInlineBodyError);
  });

  it('reads a file when --*-file is given, round-tripping backticks/$()/apostrophes byte-identical', () => {
    const dir = mkdtempSync(join(tmpdir(), 'resolve-optional-'));
    const file = join(dir, 'desc.txt');
    writeFileSync(file, DANGEROUS_BODY);

    try {
      expect(resolveOptionalTextField({ bodyFile: file })).toBe(DANGEROUS_BODY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
