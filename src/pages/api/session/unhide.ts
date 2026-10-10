// POST /api/session/unhide — {id} restores one hidden session, {all:true}
// restores every one.
import type { APIRoute } from 'astro';
import { assertWebPiLocals } from '../../../lib/web/locals';
import { parseAndValidateAPIRequest } from '../../../lib/web/parsing.service';
import { databaseUpdateFailureResponse, failureResponse, jsonResponse } from '../../../lib/web/responses.service';
import { unhideBody } from '../../../schemas/api';

export const POST: APIRoute = async ({ locals, request }) => {
  const { webpi } = assertWebPiLocals(locals);
  const parsed = await parseAndValidateAPIRequest(request, unhideBody);
  if (!parsed.ok) return failureResponse(parsed);
  const saved = 'all' in parsed.data
    ? webpi.hiddenSessions.unhideAll()
    : webpi.hiddenSessions.unhide(parsed.data.id);
  if (!saved.ok) return databaseUpdateFailureResponse(saved, 'could not save hidden state');
  return jsonResponse({ ok: true }, 200);
};
