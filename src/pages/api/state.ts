// GET /api/state — the console's poll (every open tab, every 15 s). It
// also re-arms the browser cookie's Max-Age when it has drifted near half
// the sliding window (auth.cookieRefresh decides — see the justification
// there).
import type { APIRoute } from 'astro';
import { assertWebPiLocals } from '../../lib/web/locals';
import { consoleStateFailureResponse, jsonResponse } from '../../lib/web/responses.service';

export const GET: APIRoute = async ({ locals }) => {
  const { webpi, session } = assertWebPiLocals(locals);
  const refresh = webpi.auth.cookieRefresh(session, webpi.cfg.base);
  const state = await webpi.consoleState();
  if (!state.ok) return consoleStateFailureResponse(state);
  return jsonResponse(state.data, 200, refresh === null ? undefined : { 'Set-Cookie': refresh });
};
