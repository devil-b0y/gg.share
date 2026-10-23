// POST /api/admin/reports/:postId/dismiss -- "Keep this post". Clears its
// open reports; if a mass report had auto-blacklisted it, also restores it.
import { route } from '@/lib/server/http/route';
import { json } from '@/lib/server/http/errors';
import { dismissReports, audit } from '@/lib/server/content/moderation';
import { ADMIN } from '../../../../_shared/admin-options';

export const POST = route(async (ctx) => {
  const { postId } = ctx.params;
  const { restored } = dismissReports(postId);
  audit('dismiss_reports', postId, { restored });
  return json({ ok: true, restored });
}, ADMIN);
