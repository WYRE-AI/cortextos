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
 *
 * CALLER-SIDE CONSTRUCTION THAT CANNOT FAIL (marketing, 2026-08-15): a
 * QUOTED heredoc delimiter (`cat >file <<'EOF' ... EOF`) passes backticks,
 * $(...), and $HOME through completely literally — an UNQUOTED delimiter
 * (`<<EOF`) interpolates all three. Writing the body to a file via a
 * quoted-delimiter heredoc, then passing that file with --body-file,
 * prevents the corruption before argv even exists — complementary to the
 * checks here, which only see what already survived to argv.
 *
 * THE "-" SENTINEL (2026-08-25): the CLI help text has always said "omit
 * the argument to read from stdin" — but a fixed-arity commander command
 * makes that awkward once you need a LATER positional too (e.g. reply-to),
 * and "-" is the standard Unix idiom (curl, tar, git, jq) for "read this
 * from stdin" that anyone reaches for instead of reading the help text
 * again. Before this fix, "-" was ordinary inline text: it passed the
 * metachar check untouched and was sent as a literal one-character body,
 * with a normal message ID returned to the sender — no error on either
 * side. boss lost 4 coordination messages to this in one session before
 * noticing. "-" is now a reserved sentinel for both resolveMessageBody and
 * resolveOptionalTextField: it reads stdin explicitly and bypasses
 * checkInlineText entirely, so it can never again reach the recipient as
 * literal text.
 */
import { readFileSync } from 'node:fs';

const SHELL_METACHAR_PATTERN = /`|\$\(/;
const LONG_INLINE_BODY_WARNING_THRESHOLD = 500;

export class UnsafeInlineBodyError extends Error {}

export interface ResolveMessageBodyOptions {
  /** The positional body argument, if the caller passed one inline. */
  inlineText?: string;
  /** --body-file <path> (or the call site's equivalent), takes priority over inlineText and stdin. */
  bodyFile?: string;
  /** Injectable for tests; defaults to reading fd 0 synchronously. */
  readStdin?: () => string;
  /** Injectable for tests. */
  warn?: (msg: string) => void;
  /** Name of this call site's file flag, for the error/warning text. Defaults to '--body-file'. */
  fileFlagName?: string;
  /** Whether stdin is a valid fallback at this call site, for the error text. Defaults to true. */
  stdinAvailable?: boolean;
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
 *
 * A bare "-" as the inline argument is a reserved stdin sentinel (the same
 * convention curl/tar/git use), never a literal one-character body — see
 * the 2026-08-25 incident note below. It bypasses checkInlineText entirely,
 * the same way --body-file and stdin content do.
 */
export function resolveMessageBody(opts: ResolveMessageBodyOptions): string {
  if (opts.bodyFile) {
    return readFileSync(opts.bodyFile, 'utf8');
  }

  const readStdin = opts.readStdin ?? (() => readFileSync(0, 'utf8'));

  if (opts.inlineText !== undefined) {
    if (opts.inlineText === '-') {
      return readStdin();
    }
    return checkInlineText(opts.inlineText, opts);
  }

  return readStdin();
}

/**
 * Same fail-closed checks as resolveMessageBody, for OPTIONAL free-text
 * fields that must NOT fall back to reading stdin when omitted (e.g.
 * create-task --desc, which is valid to leave unset entirely — silently
 * blocking on stdin there would hang every caller that doesn't pass one).
 * Returns undefined when neither an inline value nor a file was given.
 *
 * Same scope as send-message/send-telegram — this covers create-task
 * --desc and complete-task's result, which take free-text through the
 * identical double-quoted shell-argument construction and are exposed to
 * the same corruption (2026-08-15, scribe: a stored task description
 * missing backtick-formatted content it should have had, consistent with
 * this same failure hitting the task-write path, not just messaging).
 */
export function resolveOptionalTextField(opts: ResolveMessageBodyOptions): string | undefined {
  if (opts.bodyFile) {
    return readFileSync(opts.bodyFile, 'utf8');
  }
  if (opts.inlineText !== undefined) {
    if (opts.inlineText === '-') {
      const readStdin = opts.readStdin ?? (() => readFileSync(0, 'utf8'));
      return readStdin();
    }
    return checkInlineText(opts.inlineText, { ...opts, stdinAvailable: false });
  }
  return undefined;
}

function checkInlineText(
  inlineText: string,
  opts: { warn?: (msg: string) => void; fileFlagName?: string; stdinAvailable?: boolean },
): string {
  const fileFlag = opts.fileFlagName ?? '--body-file';
  const viaStdin = opts.stdinAvailable === false ? '' : ', or omit the argument and pipe it via stdin';
  if (SHELL_METACHAR_PATTERN.test(inlineText)) {
    throw new UnsafeInlineBodyError(
      'Refusing to proceed: this text contains a backtick or $( character. ' +
        'Passing arbitrary content through an inline shell argument is unsafe — either this ' +
        'character survived shell quoting (meaning something else in the same string may already ' +
        'have been silently substituted away before this command even ran), or it was typed on ' +
        "purpose, in which case an inline argument still isn't a safe channel for it. " +
        `Pass it safely instead: ${fileFlag} <path>${viaStdin}.`,
    );
  }
  const warn = opts.warn ?? ((msg: string) => process.stderr.write(msg + '\n'));
  if (inlineText.length > LONG_INLINE_BODY_WARNING_THRESHOLD) {
    warn(
      `Warning: inline text is ${inlineText.length} chars — long inline bodies are where ` +
        `shell metacharacters hide undetected. Consider ${fileFlag}${viaStdin ? ' or stdin' : ''} instead.`,
    );
  }
  return inlineText;
}
