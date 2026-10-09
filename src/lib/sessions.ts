// sessions.ts — sidebar data from pi's session store.
// Layout: <sessionsDir>/<cwd-slug>/<timestamp>_<uuid>.jsonl
// Line 1 is the SessionHeader (v1/v2/v3 tolerated): {type:"session", id,
// timestamp, cwd}. Title preview = first user message text, capped.
// The /api/state scan is async (fs.promises) and caches each file's parsed
// result by (path, mtime, size), so a poll never holds the event loop —
// terminal WS traffic keeps flowing while a scan runs (DESIGN_REVIEW §2).
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { PastSession } from './types';

const MAX_FILES = 200;             // newest N across all scopes
const HEADER_BYTES = 4096;         // cap read per file for the header line
const PREVIEW_BYTES = 64 * 1024;   // cap read per file for title hunt

interface Header { id: string; timestamp: string; cwd: string }

/** Header from the first line of the first n bytes of buf. The hunt never
 *  looks past HEADER_BYTES, matching the old 4 KiB sync read (a first line
 *  longer than that is not a header). */
function headerFromPrefix(buf: Buffer, n: number): Header | null {
  const limit = Math.min(n, HEADER_BYTES);
  // subarray scopes the hunt: indexOf's third arg is the encoding slot,
  // not an end limit — a plain indexOf(0x0a, 0, limit) would scan the whole
  // 64 KiB prefix and could accept a header line findSession can't.
  const nl = buf.subarray(0, limit).indexOf(0x0a);
  const line = buf.subarray(0, nl > 0 ? nl : limit).toString('utf8');
  try {
    const o = JSON.parse(line) as Partial<Header> & { type?: string };
    if (o && o.type === 'session' && typeof o.id === 'string') {
      return { id: o.id, timestamp: o.timestamp ?? '', cwd: o.cwd ?? '' };
    }
  } catch { /* tolerate */ }
  return null;
}

function parseHeader(file: string): Header | null {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(HEADER_BYTES);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return headerFromPrefix(buf, n);
    } finally { fs.closeSync(fd); }
  } catch { /* tolerate */ }
  return null;
}

interface MessageEntry {
  type: 'message';
  message?: { role?: string; content?: string | Array<{ type?: string; text?: string }> };
}

function firstUserTextFrom(buf: Buffer, n: number): string {
  const text = buf.subarray(0, n).toString('utf8');
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let o: MessageEntry; try { o = JSON.parse(line) as MessageEntry; } catch { continue; }
    if (o.type !== 'message' || !o.message || o.message.role !== 'user') continue;
    const c = o.message.content;
    const s = typeof c === 'string' ? c
      : Array.isArray(c)
        ? c.filter(p => p && p.type === 'text').map(p => p.text ?? '').join(' ')
        : '';
    const t = s.replace(/\s+/g, ' ').trim();
    if (t) return t.slice(0, 90);
  }
  return '';
}

// Title cache: path -> parsed result + the (mtime, size) it was read at.
// Unchanged files are never re-opened; a changed mtime OR size means one
// fresh bounded read. The size half matters on coarse-mtime storage (NFS
// reports ~1 s): an append landing inside the mtime tick still grows the
// file, so the stale-title window is closed. .jsonl only grows — a smaller
// size means a rewrite, which also re-reads. A plain Map is safe — every
// get/set runs on the event loop between awaits, so the only interleave
// possible (two concurrent polls reading the same changed file) duplicates
// work, it can't corrupt state. Pruned on every scan to the paths that
// still exist, keeping it bounded.
const titleCache = new Map<string, { mtime: number; size: number; session: PastSession }>();

/** Header fields + title preview from one bounded (PREVIEW_BYTES) read.
 *  Junk and unreadable files degrade exactly like the old sync scan —
 *  id falls back to the file name, title to '(no preview)' — never a
 *  throw, so a bad file can't 500 the poll. */
async function readSessionEntry(file: string, mtime: number): Promise<PastSession> {
  let h: Header | null = null;
  let title = '';
  try {
    const fh = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(PREVIEW_BYTES);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      h = headerFromPrefix(buf, bytesRead);
      title = firstUserTextFrom(buf, bytesRead);
    } finally { await fh.close(); }
  } catch { /* tolerate */ }
  return {
    id: h ? h.id : path.basename(file),
    title: title || '(no preview)',
    mtime,
    timestamp: h ? h.timestamp : '',
    cwd: h?.cwd || '(unknown cwd)',
  };
}

/** Newest-first session list, capped. Async: stats every candidate file,
 *  then reads only those whose mtime or size changed since the last scan. */
export async function listSessions(sessionsDir: string): Promise<PastSession[]> {
  const files: Array<{ file: string; mtime: number; size: number }> = [];
  let scopes: fs.Dirent[];
  try { scopes = await fsp.readdir(sessionsDir, { withFileTypes: true }); }
  catch { return []; }
  await Promise.all(scopes.map(async d => {
    if (!d.isDirectory()) return;
    const dir = path.join(sessionsDir, d.name);
    let names: string[];
    try { names = await fsp.readdir(dir); } catch { return; }
    await Promise.all(names.map(async f => {
      if (!f.endsWith('.jsonl')) return;
      const full = path.join(dir, f);
      try {
        const st = await fsp.stat(full);
        files.push({ file: full, mtime: st.mtimeMs, size: st.size });
      } catch { /* raced away mid-scan */ }
    }));
  }));
  // mtime desc, filename asc as the tiebreaker: concurrent scope scans
  // complete in arbitrary order, so mtime ties need a deterministic order
  // (a stable sort alone would preserve nondeterministic insertion order
  // and the sidebar could reshuffle between polls).
  files.sort((a, b) => b.mtime - a.mtime || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  // Drop cache entries for files gone from the store — against the full
  // scan, not the capped list, so entries just past the cap survive.
  const seen = new Set(files.map(e => e.file));
  for (const p of titleCache.keys()) if (!seen.has(p)) titleCache.delete(p);
  files.length = Math.min(files.length, MAX_FILES);
  return Promise.all(files.map(async e => {
    const hit = titleCache.get(e.file);
    if (hit && hit.mtime === e.mtime && hit.size === e.size) return hit.session;
    const session = await readSessionEntry(e.file, e.mtime);
    titleCache.set(e.file, { mtime: e.mtime, size: e.size, session });
    return session;
  }));
}

/** Read a session header back by id (resume needs cwd + exact file). */
export function findSession(sessionsDir: string, id: string):
  { file: string; id: string; timestamp: string; cwd: string } | null {
  if (!/^[0-9a-zA-Z-]{1,64}$/.test(id)) return null;
  let scopes: fs.Dirent[];
  try { scopes = fs.readdirSync(sessionsDir, { withFileTypes: true }); }
  catch { return null; }
  for (const d of scopes) {
    if (!d.isDirectory()) continue;
    const dir = path.join(sessionsDir, d.name);
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const f of names) {
      if (!f.endsWith('.jsonl') || !f.includes(id)) continue;
      const full = path.join(dir, f);
      const h = parseHeader(full);
      if (h && h.id === id) return { file: full, ...h };
    }
  }
  return null;
}
