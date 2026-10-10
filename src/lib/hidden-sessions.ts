// hidden-sessions.ts — hide-from-list state for past pi sessions.
// pi's session store is append-only history, so 'delete' in the UI means
// 'hide from the sidebar': hidden-ness persists as a row in the state db's
// `sessions` overlay table (hidden_at set = hidden; src/lib/db.ts) and can
// be unhidden again — unhide just NULLs the flag, since the row may later
// carry other per-session metadata. pi's session files themselves are
// never touched. Writes answer a DatabaseUpdateResult so the API can 500
// instead of lying. Ids arrive branded (validated at the request boundary
// by PiSessionIdSchema).
import { databaseUpdate, type StateDb } from './db';
import type { PiSessionId } from '../types/branded';

const SAVE_FAILED = 'could not save hidden state';

export class HiddenSessions {
  constructor(private state: StateDb) {}

  get size(): number {
    return (this.state.stmt('SELECT COUNT(*) AS n FROM sessions WHERE hidden_at IS NOT NULL')
      .get() as { n: number }).n;
  }
  has(id: PiSessionId): boolean {
    return this.state.stmt('SELECT 1 FROM sessions WHERE session_id = ? AND hidden_at IS NOT NULL')
      .get(id) !== undefined;
  }
  hide(id: PiSessionId) {
    return databaseUpdate(SAVE_FAILED, () =>
      this.state.stmt(`INSERT INTO sessions (session_id, hidden_at) VALUES (?, ?)
                       ON CONFLICT (session_id) DO UPDATE SET hidden_at = excluded.hidden_at`)
        .run(id, Date.now()));
  }
  unhide(id: PiSessionId) {
    return databaseUpdate(SAVE_FAILED, () =>
      this.state.stmt('UPDATE sessions SET hidden_at = NULL WHERE session_id = ?').run(id));
  }
  unhideAll() {
    return databaseUpdate(SAVE_FAILED, () =>
      this.state.stmt('UPDATE sessions SET hidden_at = NULL').run());
  }
}
