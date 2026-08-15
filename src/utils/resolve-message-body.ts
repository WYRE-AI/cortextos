/**
 * Fail-closed message body resolution for send-message / send-telegram.
 *
 * Spec: orgs/wyre/agents/infra/deliverables/infra/bus-message-body-shell-safety-spec.md
 *
 * Origin (2026-08-15): a message body typed inline as a shell argument is
 * interpreted by the shell before this CLI ever sees it. Two real incidents
 * the same night, same rule already known to both authors:
 *   - infra, single-quoted body, apostrophe -> LOUD parse error, nothing
 *     sent, caught in a second.
 *   - boss, double-quoted body, backticks around a task ID -> QUIET AND
 *     DELIVERING: bash ran command substitution, the substitution's (empty)
 *     output silently replaced the backtick-wrapped text, and a coherent-
 *     looking message with a hole in it went out. Only discovered because
 *     the recipient asked what the missing part was.
 * There is no safe quoting convention — single quotes fail loud on
 * apostrophes, double quotes fail quiet-and-delivering on backticks/$(),
 * and real fleet traffic hits both. A prose rule ("use X quotes", "be
 * careful") decays under fatigue or a message judged "quick" — the failure
 * happens at prose-composition time, while the rule only fires at
 * quoting-time. The fix has to remove the choice, not ask someone to make
 * it correctly every time.
 *
 * IMPORTANT, KNOWN LIMITATION of the inline-text check below: it can only
 * see backtick/$( characters that SURVIVED to this process's argv — which
 * happens when the body was single-quoted, or the metacharacter was
 * backslash-escaped inside double quotes. The most dangerous real incident
 * this file exists to prevent (an unescaped backtick/$( inside a
 * DOUBLE-quoted inline argument) is invisible to this check BY
 * CONSTRUCTION: bash performs command substitution and replaces the whole
 * `...`/$(...) sequence with its own (often empty) output BEFORE this
 * process even starts, so the backtick character itself never reaches
 * argv — there is nothing left here to detect. No in-process check can
 * catch that case after the fact. The actual fix for it is making
 * --body-file / stdin the DEFAULT (below) so an inline double-quoted body
 * stops being the common path. Do not read the inline check as covering
 * the double-quote case; it is a secondary net for what's still visible,
 * not the primary fix.
 */
import { readFileSync } from 'node:fs';

const SHELL_METACHAR_PATTERN = /`|\$\(/;
const LONG_INLINE_BODY_WARNING_THRESHOLD = 500;

export class UnsafeInlineBodyError extends Error {}

export interface ResolveMessageBodyOptions {
  /** The positional body argument, if the caller passed one inline. */
  inlineText?: string;
  /** --body-file <path>, takes priority over inlineText and stdin. */
  bodyFile?: string;
  /** Injectable for tests; defaults to reading fd 0 synchronously. */
  readStdin?: () => string;
  /** Injectable for tests. */
  warn?: (msg: string) => void;
}

/**
 * Resolve a message body from --body-file, an inline positional argument,
 * or stdin, in that priority order. --body-file and stdin content pass
 * through completely untouched — no shell re-interpretation, no metachar
 * check — which is what makes them the safe path for a body containing
 * backticks, $(, or apostrophes: it's the only way such a body can reach
 * the recipient byte-identical.
 *
 * Throws UnsafeInlineBodyError (never sends) if an inline body contains a
 * backtick or $( that survived to this process — see the module docblock
 * for why that check cannot see the more dangerous double-quoted case, and
 * is a secondary net rather than the fix.
 */
export function resolveMessageBody(opts: ResolveMessageBodyOptions): string {
  if (opts.bodyFile) {
    return readFileSync(opts.bodyFile, 'utf8');
  }

  if (opts.inlineText !== undefined) {
    if (SHELL_METACHAR_PATTERN.test(opts.inlineText)) {
      throw new UnsafeInlineBodyError(
        'Refusing to send: the message body contains a backtick or $( character. ' +
          'Sending arbitrary content through an inline shell argument is unsafe — either this ' +
          'character survived shell quoting (meaning something else in the same string may already ' +
          'have been silently substituted away before this command even ran), or it was typed on ' +
          "purpose, in which case an inline argument still isn't a safe channel for it. " +
          'Pass the body safely instead: --body-file <path>, or omit the body argument and pipe it via stdin.',
      );
    }
    const warn = opts.warn ?? ((msg: string) => process.stderr.write(msg + '\n'));
    if (opts.inlineText.length > LONG_INLINE_BODY_WARNING_THRESHOLD) {
      warn(
        `Warning: inline message body is ${opts.inlineText.length} chars — long inline bodies are where ` +
          'shell metacharacters hide undetected. Consider --body-file or stdin instead.',
      );
    }
    return opts.inlineText;
  }

  const readStdin = opts.readStdin ?? (() => readFileSync(0, 'utf8'));
  return readStdin();
}
