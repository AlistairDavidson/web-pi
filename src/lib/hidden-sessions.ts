// hidden-sessions.ts — hide-from-list state for past pi sessions.
// pi's session store is append-only history, so 'delete' in the UI means
// 'hide from the sidebar': hidden-ness persists as a row in the state db's
// `sessions` overlay table (hidden_at set = hidden; src/lib/db.ts) and can
// be unhidden again — unhide just NULLs the flag, since the row may later
// carry other per-session metadata. pi's session files themselves are
// never touched. Reads and writes answer Results (database_read /
// database_update) so the API can 500 instead of lying. Ids arrive branded
// (validated at the request boundary by PiSessionIdSchema).
import { databaseRead, databaseUpdate, type StateDb } from './db';
import { asPiSessionId, type PiSessionId } from '../types/branded';

const SAVE_FAILED = 'could not save hidden state';

export class HiddenSessions {
  constructor(private state: StateDb) {}

  /** Every hidden session id — including ones beyond the sidebar's
   *  newest-sessions cap, so its size is the full hidden count. Ids come
   *  from our own db, validated on write (trusted). */
  hiddenIds() {
    return databaseRead('could not read hidden state', () => new Set(
      (this.state.stmt('SELECT session_id FROM sessions WHERE hidden_at IS NOT NULL')
        .all() as Array<{ session_id: string }>)
        .map(r => asPiSessionId(r.session_id))));
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
