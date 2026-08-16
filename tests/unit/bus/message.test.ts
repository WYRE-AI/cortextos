import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sendMessage, checkInbox, checkInboxWithStatus, ackInbox } from '../../../src/bus/message';
import { acquireLock, releaseLock } from '../../../src/utils/lock';
import { resolvePaths } from '../../../src/utils/paths';
import type { BusPaths } from '../../../src/types';

describe('Message Bus', () => {
  let testDir: string;
  let senderPaths: BusPaths;
  let receiverPaths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-bus-test-'));
    // Override ctxRoot to use temp directory
    senderPaths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'sender'),
      inflight: join(testDir, 'inflight', 'sender'),
      processed: join(testDir, 'processed', 'sender'),
      logDir: join(testDir, 'logs', 'sender'),
      stateDir: join(testDir, 'state', 'sender'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
    receiverPaths = {
      ...senderPaths,
      inbox: join(testDir, 'inbox', 'receiver'),
      inflight: join(testDir, 'inflight', 'receiver'),
      processed: join(testDir, 'processed', 'receiver'),
      logDir: join(testDir, 'logs', 'receiver'),
      stateDir: join(testDir, 'state', 'receiver'),
    };
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('sendMessage', () => {
    it('creates a JSON file in receiver inbox', () => {
      const msgId = sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'Hello');
      expect(msgId).toBeTruthy();

      const receiverInbox = join(testDir, 'inbox', 'receiver');
      const files = readdirSync(receiverInbox).filter(f => f.endsWith('.json'));
      expect(files.length).toBe(1);

      // Verify filename format: {pnum}-{epochMs}-from-{sender}-{rand5}.json
      expect(files[0]).toMatch(/^2-\d+-from-sender-[a-z0-9]{5}\.json$/);
    });

    it('produces JSON matching bash format', () => {
      sendMessage(senderPaths, 'paul', 'boris', 'high', 'Build the page');

      const receiverInbox = join(testDir, 'inbox', 'boris');
      const files = readdirSync(receiverInbox).filter(f => f.endsWith('.json'));
      const content = JSON.parse(readFileSync(join(receiverInbox, files[0]), 'utf-8'));

      // Verify all fields match bash send-message.sh format
      expect(content).toHaveProperty('id');
      expect(content).toHaveProperty('from', 'paul');
      expect(content).toHaveProperty('to', 'boris');
      expect(content).toHaveProperty('priority', 'high');
      expect(content).toHaveProperty('timestamp');
      expect(content).toHaveProperty('text', 'Build the page');
      expect(content).toHaveProperty('reply_to', null);

      // Verify filename has priority 1 (high)
      expect(files[0]).toMatch(/^1-/);
    });

    it('encodes priority correctly in filename', () => {
      sendMessage(senderPaths, 'a', 'b', 'urgent', 'test');
      sendMessage(senderPaths, 'a', 'b', 'high', 'test');
      sendMessage(senderPaths, 'a', 'b', 'normal', 'test');
      sendMessage(senderPaths, 'a', 'b', 'low', 'test');

      const inbox = join(testDir, 'inbox', 'b');
      const files = readdirSync(inbox).filter(f => f.endsWith('.json')).sort();

      expect(files[0]).toMatch(/^0-/); // urgent
      expect(files[1]).toMatch(/^1-/); // high
      expect(files[2]).toMatch(/^2-/); // normal
      expect(files[3]).toMatch(/^3-/); // low
    });

    it('rejects invalid agent names', () => {
      expect(() =>
        sendMessage(senderPaths, '../bad', 'good', 'normal', 'test')
      ).toThrow();
    });
  });

  describe('checkInbox', () => {
    it('returns empty array for empty inbox', () => {
      const messages = checkInbox(receiverPaths);
      expect(messages).toEqual([]);
    });

    it('returns messages sorted by priority', () => {
      sendMessage(senderPaths, 'sender', 'receiver', 'low', 'low priority');
      sendMessage(senderPaths, 'sender', 'receiver', 'urgent', 'urgent');
      sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'normal');

      const messages = checkInbox(receiverPaths);
      expect(messages.length).toBe(3);
      expect(messages[0].priority).toBe('urgent');
      expect(messages[1].priority).toBe('normal');
      expect(messages[2].priority).toBe('low');
    });

    it('moves messages to inflight', () => {
      sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'test');
      checkInbox(receiverPaths);

      const inboxFiles = readdirSync(receiverPaths.inbox).filter(f => f.endsWith('.json'));
      const inflightFiles = readdirSync(receiverPaths.inflight).filter(f => f.endsWith('.json'));

      expect(inboxFiles.length).toBe(0);
      expect(inflightFiles.length).toBe(1);
    });

    it('warns (rate-limited) when the inbox lock cannot be acquired', () => {
      sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'test');
      // Hold the lock from this (live) process so checkInbox cannot acquire it
      expect(acquireLock(receiverPaths.inbox)).toBe(true);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(checkInbox(receiverPaths)).toEqual([]);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(String(warnSpy.mock.calls[0][0])).toContain(receiverPaths.inbox);

        // Immediate re-check must not warn again (rate-limited per inbox)
        expect(checkInbox(receiverPaths)).toEqual([]);
        expect(warnSpy).toHaveBeenCalledTimes(1);
      } finally {
        warnSpy.mockRestore();
        releaseLock(receiverPaths.inbox);
      }
    });
  });

  describe('ackInbox', () => {
    it('moves message from inflight to processed', () => {
      const msgId = sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'test');
      checkInbox(receiverPaths); // moves to inflight

      ackInbox(receiverPaths, msgId);

      const inflightFiles = readdirSync(receiverPaths.inflight).filter(f => f.endsWith('.json'));
      const processedFiles = readdirSync(receiverPaths.processed).filter(f => f.endsWith('.json'));

      expect(inflightFiles.length).toBe(0);
      expect(processedFiles.length).toBe(1);
    });
  });
});

describe('inbox check completion status — "nothing there" vs "I did not look"', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-inbox-status-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'receiver'),
      inflight: join(testDir, 'inflight', 'receiver'),
      processed: join(testDir, 'processed', 'receiver'),
      logDir: join(testDir, 'logs', 'receiver'),
      stateDir: join(testDir, 'state', 'receiver'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // Hold the lock with a LIVE pid (our own), so acquireLock takes the
  // "process is alive — lock is held" branch rather than stealing it as stale.
  const holdInboxLock = (): void => {
    mkdirSync(paths.inbox, { recursive: true });
    const lockDir = join(paths.inbox, '.lock.d');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'pid'), String(process.pid));
  };

  it('CONTROL: a genuinely empty inbox reports a COMPLETED check', () => {
    const r = checkInboxWithStatus(paths);
    expect(r.messages).toEqual([]);
    expect(r.skipped).toBe(false); // real emptiness — safe to act on
  });

  it('CONTROL: the lock recipe actually blocks acquisition', () => {
    // Without this, a lock that silently failed to hold would make the
    // skipped-case test below pass for the wrong reason.
    holdInboxLock();
    expect(acquireLock(paths.inbox)).toBe(false);
  });

  it('a held lock reports the inbox was NOT checked', () => {
    holdInboxLock();
    const r = checkInboxWithStatus(paths);
    expect(r.messages).toEqual([]);
    expect(r.skipped).toBe(true); // [] here means "did not look", not "empty"
  });

  it('THE COLLAPSE: a wedged inbox and an empty one are identical through the wrapper', () => {
    const empty = checkInbox(paths);
    holdInboxLock();
    const wedged = checkInbox(paths);
    // This is what `bus check-inbox` prints, and what an agent reads as
    // "inbox empty, nothing owed to anyone". Wrapper is intentionally lossy.
    expect(JSON.stringify(empty)).toBe(JSON.stringify(wedged));
  });

  it('a real message still arrives, and reports a completed check', () => {
    sendMessage(paths, 'sender', 'receiver', 'normal', 'hello');
    const r = checkInboxWithStatus(paths);
    expect(r.messages.length).toBe(1);
    expect(r.skipped).toBe(false);
  });

  it('a held lock does NOT consume messages — they survive for the next poll', () => {
    sendMessage(paths, 'sender', 'receiver', 'normal', 'hello');
    holdInboxLock();
    expect(checkInboxWithStatus(paths).messages).toEqual([]);
    rmSync(join(paths.inbox, '.lock.d'), { recursive: true, force: true });
    expect(checkInboxWithStatus(paths).messages.length).toBe(1);
  });
});
