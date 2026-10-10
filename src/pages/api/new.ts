// POST /api/new — start a new interactive session. The name is slugified
// (normalization, not validation); an empty slug is 'name required'.
import type { APIRoute } from 'astro';
import { assertWebPiLocals } from '../../lib/web/locals';
import { parseAndValidateAPIRequest } from '../../lib/web/parsing.service';
import { failureResponse, jsonResponse, tmuxSessionFailureResponse } from '../../lib/web/responses.service';
import { newSessionBody } from '../../schemas/api';
import { TmuxSessionNameSchema } from '../../schemas/ids';
import { normalizeSessionName } from '../../schemas/patterns';

export const POST: APIRoute = async ({ locals, request }) => {
  const { webpi } = assertWebPiLocals(locals);
  const parsed = await parseAndValidateAPIRequest(request, newSessionBody);
  if (!parsed.ok) return failureResponse(parsed);
  const slug = normalizeSessionName(parsed.data.name);
  if (!slug) return jsonResponse({ error: 'name required', code: 'name_required' }, 400);
  const name = TmuxSessionNameSchema.safeParse(slug); // in-charset by construction
  if (!name.success) return jsonResponse({ error: 'invalid session name', code: 'invalid_session_name' }, 400);
  const created = await webpi.newSession(name.data);
  if (!created.ok) return tmuxSessionFailureResponse(created);
  return jsonResponse({ name: created.data.name }, 200);
};
