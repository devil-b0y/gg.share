// GET /api/admin/analytics[?days=14] -- daily activity series (max 60 days).
import { route } from '@/lib/server/http/route';
import { json } from '@/lib/server/http/errors';
import { analytics } from '@/lib/server/admin/queries';
import { ADMIN } from '../../_shared/admin-options';

const MAX_DAYS = 60;

export const GET = route(async (ctx) => {
  const days = Math.min(parseInt(ctx.query.get('days'), 10) || 14, MAX_DAYS);
  return json(analytics(days));
}, ADMIN);
