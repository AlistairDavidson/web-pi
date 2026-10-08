// hidden-sessions.ts — hide-from-list state for past pi sessions.
// pi's session store is append-only history, so 'delete' in the UI means
// 'hide from the sidebar': ids persist in a small JSON file and can be
// unhidden again. pi's session files themselves are never touched.
//
// State file: ENV.WEB_PI_HIDDEN_FILE (default: hidden-sessions.json next to
// the auth file — operator state lives there; see env.ts). Read errors are
// tolerated (missing/corrupt → empty set, warned); write failures are
// returned to the caller so the API can 500 instead of lying.
import * as fs from 'node:fs';
import * as path from 'node:path';

/** pi session ids (uuid); also caps junk written into the state file. */
export const SESSION_ID_RE = /^[0-9a-zA-Z-]{1,64}$/;

interface HiddenState { hidden: string[] }

export class HiddenSessions {
  private file: string;
  private ids = new Set<string>();

  constructor(file: string) { this.file = file; }

  get filePath(): string { return this.file; }
  get size(): number { this.ensureLoaded(); return this.ids.size; }
  has(id: string): boolean { this.ensureLoaded(); return this.ids.has(id); }

  hide(id: string): Error | null {
    if (!SESSION_ID_RE.test(id)) return new Error('invalid session id');
    this.ensureLoaded();
    this.ids.add(id);
    return this.save();
  }

  unhide(id: string): Error | null {
    if (!SESSION_ID_RE.test(id)) return new Error('invalid session id');
    this.ensureLoaded();
    this.ids.delete(id);
    return this.save();
  }

  unhideAll(): Error | null {
    this.ensureLoaded();
    this.ids.clear();
    return this.save();
  }

  /** Read the state file lazily, on first use — not at construction.
   * The e2e suite boots the server before its global-setup resets the
   * workspace; an eager load here would latch a previous run's leftover
   * file for this server's whole lifetime (and re-persist it on the next
   * save). First use always happens after startup churn is done. */
  private loaded = false;
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.load();
  }

  private load(): void {
    try {
      const o = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<HiddenState>;
      if (o && Array.isArray(o.hidden)) {
        for (const id of o.hidden) {
          if (typeof id === 'string' && SESSION_ID_RE.test(id)) this.ids.add(id);
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`could not read hidden-sessions state (${this.file}):`,
          (err as Error).message, '— starting with nothing hidden');
      }
    }
  }

  /** Atomic write (tmp + rename), like the auth credential file. */
  private save(): Error | null {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ hidden: [...this.ids] }, null, 2) + '\n',
        { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      return null;
    } catch (err) {
      return err as Error;
    }
  }
}
