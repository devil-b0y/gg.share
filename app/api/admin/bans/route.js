// GET  /api/admin/bans                          -- every ban, newest first
// POST /api/admin/bans  { kind, value, reason } -- kind = 'addr' | 'iphash'
import { route } from '@/lib/server/http/route';
import { json, errorJson } from '@/lib/server/http/errors';
import { ban, listBans } from '@/lib/server/security/bans';
import { audit } from '@/lib/server/content/moderation';
import { ADMIN, ADMIN_JSON } from '../../_shared/admin-options';

const MAX_BAN_VALUE_LEN = 200;

export const GET = route(async () => json({ bans: listBans() }), ADMIN);

export const POST = route(async (ctx) => {
  const { kind, value, reason } = ctx.body;
  if (!['addr', 'iphash'].includes(kind) || typeof value !== 'string' || !value || value.length > MAX_BAN_VALUE_LEN) {
    return errorJson(400, 'bad kind/value');
  }
  const note = typeof reason === 'string' ? reason : null;
  ban(kind, value, note, 'admin');
  audit('ban', value, { kind, reason: note });
  return json({ ok: true });
}, ADMIN_JSON);
