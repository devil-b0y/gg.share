// GET /api/admin/reports[?include=all] -- reported posts, most-reported first.
// Without `include=all`, only posts with unresolved reports.
import { route } from '@/lib/server/http/route';
import { json } from '@/lib/server/http/errors';
import { listReports } from '@/lib/server/admin/queries';
import { ADMIN } from '../../_shared/admin-options';

export const GET = route(async (ctx) => json(listReports(ctx.query.get('include') === 'all')), ADMIN);
