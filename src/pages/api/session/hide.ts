// POST /api/session/hide — the sidebar's 'delete': reversible by design
// (a hidden flag in the state db's sessions overlay, never pi's store).
import type { APIRoute } from 'astro';
import { assertWebPiLocals } from '../../../lib/web/locals';
import { parseAndValidateAPIRequest } from '../../../lib/web/parsing.service';
import { databaseUpdateFailureResponse, failureResponse, jsonResponse } from '../../../lib/web/responses.service';
import { hideBody } from '../../../schemas/api';

export const POST: APIRoute = async ({ locals, request }) => {
  const { webpi } = assertWebPiLocals(locals);
  const parsed = await parseAndValidateAPIRequest(request, hideBody);
  if (!parsed.ok) return failureResponse(parsed);
  const saved = webpi.hiddenSessions.hide(parsed.data.id);
  if (!saved.ok) return databaseUpdateFailureResponse(saved, 'could not save hidden state');
  return jsonResponse({ ok: true }, 200);
};
