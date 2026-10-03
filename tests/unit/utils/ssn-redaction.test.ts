import { describe, it, expect } from 'vitest';
import { redactSSN, detectSSN } from '../../../src/utils/ssn-redaction';

// Ported alongside src/utils/ssn-redaction.ts from grandamenium/cortextos@d647b862d
// as part of the Slack inbound-redaction wiring (task_1790871245210_64848240).
// Minimal sanity coverage for our actual call site (redactSSN as used by
// slack-redact.ts's redactInboundText) — not a full re-verification of
// upstream's own extensive design-decision test matrix.
describe('redactSSN (ported module, sanity coverage for our call site)', () => {
  it('redacts a dash-formatted SSN', () => {
    expect(redactSSN('123-45-6789')).toBe('[REDACTED-SSN]');
  });

  it('redacts an SSN embedded in prose', () => {
    expect(redactSSN('my ssn is 123-45-6789, thanks')).toBe('my ssn is [REDACTED-SSN], thanks');
  });

  it('does NOT redact a 10-digit phone number (XXX-XXX-XXXX shape)', () => {
    expect(redactSSN('call me at 555-123-4567')).toBe('call me at 555-123-4567');
  });

  it('detectSSN reports presence without mutating', () => {
    expect(detectSSN('123-45-6789')).toBe(true);
    expect(detectSSN('555-123-4567')).toBe(false);
  });
});
