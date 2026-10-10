// GET /api/settings — the read-only dashboard's effective config. Paths
// and versions only; no credential or hash contents ever leave.
import type { APIRoute } from 'astro';
import { assertWebPiLocals } from '../../lib/web/locals';
import { jsonResponse } from '../../lib/web/responses.service';

export const GET: APIRoute = ({ locals }) => {
  const { webpi } = assertWebPiLocals(locals);
  return jsonResponse(webpi.settingsState(), 200);
};
