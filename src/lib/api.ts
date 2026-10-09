// api.ts — zod schemas for the JSON request bodies the REST endpoints
// accept (server/main.ts). readBody (there) already caps the size and
// guarantees a JSON object; these are the field-level gate on top, so
// handlers use parsed fields without typeof dances, and a mistyped field
// is a 400 that names itself (firstIssue).
//
// What deliberately does NOT live here: validation where a regex IS the
// rule (JOB_NAME_RE and cron schedules in jobs.ts, SESSION_ID_RE's home
// in db.ts is reused below, tmux NAME_RE) and value normalization
// (name slugification in main.ts, resize clamps) — that is domain logic,
// not shape checking, and moving it into schemas would split one rule
// across two places.
import { z } from 'zod';
import { SESSION_ID_RE } from './db';

/** POST /login — both fields must be strings; a parse failure answers 401
 *  upstream (like the old typeof check), because fail2ban counts 401/429
 *  on that route. Empty strings pass: verify() decides those. */
export const loginBody = z.object({ username: z.string(), password: z.string() });

/** POST /api/new — any string; slugification and the empty check ('name
 *  required') stay in the handler: normalization is not validation. */
export const newSessionBody = z.object({ name: z.string() });

/** POST /api/jobs (save) — strings only; the name/schedule/command rules
 *  (normalizeName, JOB_NAME_RE, checkCron, length caps) live in jobs.ts. */
export const jobSaveBody = z.object({ name: z.string(), schedule: z.string(), command: z.string() });

/** POST /api/jobs/validate — the schedule string. '' passes: checkCron
 *  answers { valid: false, 'schedule is required' } with a 200. */
export const jobValidateBody = z.object({ schedule: z.string() });

/** POST /api/session/hide */
export const hideBody = z.object({ id: z.string().regex(SESSION_ID_RE, 'invalid session id') });

/** POST /api/session/unhide — {all:true} (restore everything) or {id} to
 *  restore one; all wins when both are present, like the old check. */
export const unhideBody = z.union([
  z.object({ all: z.literal(true) }),
  z.object({ id: z.string().regex(SESSION_ID_RE, 'invalid session id') }),
]);

/** POST /api/update-pi — dryRun defaults to false (a real update), like
 *  the old `dryRun === true`; a mistyped dryRun is now a 400 instead of
 *  silently falling through to a real install. */
export const updatePiBody = z.object({ dryRun: z.boolean().default(false) });

/** First issue of a failed parse as a one-line 400 body:
 *  'field: message' (or the bare message at the root). */
export function firstIssue(err: z.ZodError): string {
  const i = err.issues[0];
  if (!i) return 'bad request';
  const at = i.path.join('.');
  return at ? `${at}: ${i.message}` : i.message;
}
