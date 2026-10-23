// DELETE /api/admin/bans/:kind/:value -- lifts a ban.
import { route } from '@/lib/server/http/route';
import { json } from '@/lib/server/http/errors';
import { unban } from '@/lib/server/security/bans';
import { audit } from '@/lib/server/content/moderation';
import { ADMIN } from '../../../../_shared/admin-options';

export const DELETE = route(async (ctx) => {
  // Next.js has already URL-decoded the segments.
  const { kind, value } = ctx.params;
  unban(kind, value);
  audit('unban', value, { kind });
  return json({ ok: true });
}, ADMIN);
