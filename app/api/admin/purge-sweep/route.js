// POST /api/admin/purge-sweep -- runs the quarantine purge now instead of
// waiting for the half-hourly timer started by server.js.
import { route } from '@/lib/server/http/route';
import { json } from '@/lib/server/http/errors';
import { purgeExpiredQuarantine } from '@/lib/server/media/queue';
import { audit } from '@/lib/server/content/moderation';
import { ADMIN } from '../../_shared/admin-options';

export const POST = route(async () => {
  purgeExpiredQuarantine();
  audit('manual_purge_sweep', null, null);
  return json({ ok: true });
}, ADMIN);
