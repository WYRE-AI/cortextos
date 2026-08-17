import { describe, it, expect } from 'vitest';
import { decideSubagentPriming, alreadyPrimed, PRIMING_LINE } from '../../../src/hooks/hook-subagent-priming';

describe('hook-subagent-priming alreadyPrimed', () => {
  it('detects the priming line by its distinctive phrase', () => {
    expect(alreadyPrimed(`Do the thing.\n\n${PRIMING_LINE}`)).toBe(true);
  });

  it('detects a hand-written equivalent mentioning a benign date notice', () => {
    expect(alreadyPrimed('Heads up, there is a benign date-rollover notice you might see.')).toBe(true);
  });

  it('returns false for an ordinary prompt', () => {
    expect(alreadyPrimed('Find all usages of foo() in the codebase.')).toBe(false);
  });
});

describe('hook-subagent-priming decideSubagentPriming', () => {
  it('appends the priming line to an Agent tool prompt', () => {
    const result = decideSubagentPriming('Agent', {
      description: 'quick search',
      prompt: 'Find the config file.',
      subagent_type: 'Explore',
    });

    expect(result).not.toBeNull();
    expect(result!.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(result!.hookSpecificOutput.updatedInput.prompt).toBe(`Find the config file.\n\n${PRIMING_LINE}`);
    // Non-prompt fields must pass through unchanged.
    expect(result!.hookSpecificOutput.updatedInput.description).toBe('quick search');
    expect(result!.hookSpecificOutput.updatedInput.subagent_type).toBe('Explore');
  });

  it('is a no-op for a non-Agent tool', () => {
    expect(decideSubagentPriming('Bash', { command: 'ls' })).toBeNull();
  });

  it('is a no-op when tool_input has no prompt field', () => {
    expect(decideSubagentPriming('Agent', { description: 'no prompt here' })).toBeNull();
  });

  it('is a no-op when the prompt is already primed', () => {
    const result = decideSubagentPriming('Agent', {
      prompt: `Do the thing.\n\n${PRIMING_LINE}`,
    });
    expect(result).toBeNull();
  });

  it('is a no-op when prompt is not a string', () => {
    expect(decideSubagentPriming('Agent', { prompt: 12345 })).toBeNull();
  });

  it('handles a missing tool_input object without throwing', () => {
    expect(decideSubagentPriming('Agent', undefined)).toBeNull();
    expect(decideSubagentPriming('Agent', null)).toBeNull();
  });
});
