// jobs.ts — the scheduled-job form, defined once: the /jobs dialog
// validates against it in the browser (validation-enhancer-zod), and
// POST /api/jobs parses with it on the server (a failure is a 400 with
// per-field issues). Node-free. The cron schedule's *validity* is not
// here: cron-parser stays server-side — saveJob checks it (and the
// dialog's live feedback asks POST /api/jobs/validate).
import { z } from 'zod';
import { asJobName } from '../types/branded';
import { JOB_NAME_RE, normalizeJobName } from './patterns';

export const MAX_SCHEDULE = 120;
export const MAX_COMMAND = 4000;
const SINGLE_LINE = /^[^\r\n]*$/;

export const JobSaveSchema = z.object({
  // Normalized first ("Nightly Check" → nightly-check), then validated —
  // what the user typed is fine as long as it slugs to a valid name.
  name: z.string().transform(normalizeJobName).pipe(
    z.string()
      .min(1, 'name is required')
      .regex(JOB_NAME_RE, 'use letters, digits, - and _ (and not webpi-…)')
      .transform(asJobName)),
  schedule: z.string().trim()
    .min(1, 'schedule is required')
    .max(MAX_SCHEDULE, `schedule is too long (max ${MAX_SCHEDULE})`)
    .regex(SINGLE_LINE, 'schedule must be one line'),
  command: z.string().trim()
    .min(1, 'command is required')
    .max(MAX_COMMAND, `command is too long (max ${MAX_COMMAND})`)
    .regex(SINGLE_LINE, 'command must be one line'),
});

/** A parsed save: name normalized + branded, schedule/command trimmed and
 *  shape-checked — saveJob's input. */
export type SaveInput = z.output<typeof JobSaveSchema>;
