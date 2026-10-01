// sessions.ts — sidebar data from pi's session store.
// Layout: <sessionsDir>/<cwd-slug>/<timestamp>_<uuid>.jsonl
// Line 1 is the SessionHeader (v1/v2/v3 tolerated): {type:"session", id,
// timestamp, cwd}. Title preview = first user message text, capped.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PastSession } from './types';

const MAX_FILES = 200;             // newest N across all scopes
const PREVIEW_BYTES = 64 * 1024;   // cap read per file for title hunt

interface Header { id: string; timestamp: string; cwd: string }

function parseHeader(file: string): Header | null {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const nl = buf.indexOf(0x0a, 0, n);
      const line = buf.subarray(0, nl > 0 ? nl : n).toString('utf8');
      const o = JSON.parse(line) as Partial<Header> & { type?: string };
      if (o && o.type === 'session' && typeof o.id === 'string') {
        return { id: o.id, timestamp: o.timestamp ?? '', cwd: o.cwd ?? '' };
      }
    } finally { fs.closeSync(fd); }
  } catch { /* tolerate */ }
  return null;
}

interface MessageEntry {
  type: 'message';
  message?: { role?: string; content?: string | Array<{ type?: string; text?: string }> };
}

function firstUserText(file: string): string {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(PREVIEW_BYTES);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
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
    } finally { fs.closeSync(fd); }
  } catch { /* tolerate */ }
  return '';
}

/** Newest-first session list, capped. */
export function listSessions(sessionsDir: string): PastSession[] {
  const files: Array<{ file: string; mtime: number }> = [];
  let scopes: fs.Dirent[];
  try { scopes = fs.readdirSync(sessionsDir, { withFileTypes: true }); }
  catch { return []; }
  for (const d of scopes) {
    if (!d.isDirectory()) continue;
    const dir = path.join(sessionsDir, d.name);
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const f of names) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        files.push({ file: full, mtime: st.mtimeMs });
      } catch { continue; }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  files.length = Math.min(files.length, MAX_FILES);
  return files.map(e => {
    const h = parseHeader(e.file) ?? { id: path.basename(e.file), timestamp: '', cwd: '' };
    return {
      id: h.id,
      title: firstUserText(e.file) || '(no preview)',
      mtime: e.mtime,
      timestamp: h.timestamp,
      cwd: h.cwd || '(unknown cwd)',
    };
  });
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
