import fs from 'fs';
import path from 'path';

export interface BusMessage {
  id: string;
  from: string;
  to: string;
  priority: string;
  timestamp: string;
  text: string;
  reply_to: string | null;
}

interface MessageFileRef {
  file: string;
  /** Epoch-ms parsed from the filename, used to order without opening files. */
  epoch: number;
}

/**
 * Bus message filenames look like:
 *   2-1786740815529-from-boss-3znol.json
 *    ^ priority
 *      ^ epoch-ms          ^ sender   ^ nonce
 *
 * Matched as a standalone 13-digit run so a sender name containing digits or
 * dashes cannot be mistaken for the timestamp. Files we cannot parse sort last
 * (epoch 0) rather than being dropped.
 */
function epochFromFilename(name: string): number {
  const m = name.match(/(?:^|-)(\d{13})(?:-|$)/);
  return m ? Number(m[1]) : 0;
}

/**
 * Enumerate every bus-message file under inbox/ (+ inflight) and processed/,
 * newest first, WITHOUT reading any file contents.
 *
 * Directory entries are cheap; message bodies are not. This box has ~32k
 * processed messages, so ordering by filename first is what makes it possible
 * to open only the handful a request actually needs.
 */
function listMessageFilesNewestFirst(ctxRoot: string): MessageFileRef[] {
  const refs: MessageFileRef[] = [];
  const inboxBase = path.join(ctxRoot, 'inbox');
  const processedBase = path.join(ctxRoot, 'processed');

  for (const [base, subs] of [
    [inboxBase, ['inflight', '']],
    [processedBase, ['']],
  ] as const) {
    if (!fs.existsSync(base)) continue;

    let agentDirs: string[];
    try {
      agentDirs = fs
        .readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }

    for (const agent of agentDirs) {
      for (const sub of subs) {
        const dir = sub ? path.join(base, agent, sub) : path.join(base, agent);
        let files: string[];
        try {
          files = fs.readdirSync(dir);
        } catch {
          continue; // missing dir or unreadable — nothing to contribute
        }
        for (const f of files) {
          if (!f.endsWith('.json') || f.startsWith('.')) continue;
          refs.push({ file: path.join(dir, f), epoch: epochFromFilename(f) });
        }
      }
    }
  }

  refs.sort((a, b) => b.epoch - a.epoch);
  return refs;
}

/**
 * Read bus messages newest-first, stopping as soon as `want` of them satisfy
 * `accept`.
 *
 * Callers sort the merged result by timestamp descending and slice to the same
 * `want`, so taking the newest `want` acceptable messages yields an identical
 * result set to reading all of them — for a fraction of the I/O. Before this,
 * the default feed request opened and JSON.parsed every message on disk
 * (~32k files here) to then discard all but 200.
 *
 * Ordering uses the filename epoch while the final sort uses `msg.timestamp`;
 * both are stamped when the message is written, so the two orders agree.
 */
export function readMessagesNewestFirst(
  ctxRoot: string,
  want: number,
  accept: (msg: BusMessage) => boolean,
): BusMessage[] {
  const out: BusMessage[] = [];
  const seen = new Set<string>();

  for (const ref of listMessageFilesNewestFirst(ctxRoot)) {
    if (out.length >= want) break;
    let msg: BusMessage;
    try {
      msg = JSON.parse(fs.readFileSync(ref.file, 'utf-8')) as BusMessage;
    } catch {
      continue; // unreadable or corrupt — skip, same as before
    }
    if (!msg.id || !msg.from || !msg.to || !msg.timestamp) continue;
    if (seen.has(msg.id)) continue;
    if (!accept(msg)) continue;
    seen.add(msg.id);
    out.push(msg);
  }

  return out;
}
