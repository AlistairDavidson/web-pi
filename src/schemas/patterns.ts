// patterns.ts — the ID rules as plain regexes (no zod import, so browser
// code that only needs a pattern doesn't bundle zod). src/schemas/ids.ts
// builds the validating, branding schemas from these.
//
// Every literal `-` inside a character class is escaped: these patterns
// also become HTML `pattern` attributes, which compile with the `v` flag,
// where an unescaped `-` in a class is a syntax error and the browser
// silently ignores the whole pattern.

/** pi session ids (uuid); also caps junk written into the state db. */
export const SESSION_ID_RE = /^[0-9a-zA-Z\-]{1,64}$/;

/** tmux session names on the app socket. 64, not 40: a job run's session
 *  is `webpi-<job name>` and job names go up to 40 (JOB_NAME_RE), so a
 *  40-char cap rejected every run of a job named longer than 34. */
export const TMUX_SESSION_NAME_RE = /^[a-zA-Z0-9_\-]{1,64}$/;

/** Job name charset: tmux-session-name-safe. Names starting with "webpi-"
 *  are rejected so a job can never produce a doubly-prefixed (confusingly
 *  nested) webpi-webpi-* run session. */
export const JOB_NAME_RE = /^(?!webpi-)[a-z0-9][a-z0-9_\-]{0,39}$/;

/** Normalize a user-supplied job name the way /api/new does for sessions. */
export function normalizeJobName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 40);
}
