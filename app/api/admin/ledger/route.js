// GET /api/admin/ledger[?limit=50] -- recent blocks, totals and the integrity check.
import { route } from '@/lib/server/http/route';
import { json } from '@/lib/server/http/errors';
import { ledgerOverview } from '@/lib/server/admin/queries';
import { ADMIN } from '../../_shared/admin-options';

const MAX_BLOCKS = 200;

export const GET = route(async (ctx) => {
  const limit = Math.min(parseInt(ctx.query.get('limit'), 10) || 50, MAX_BLOCKS);
  return json(ledgerOverview(limit));
}, ADMIN);
