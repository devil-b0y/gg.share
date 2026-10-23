// GET /api/admin/posts?status=live|review|blacklisted|pending|removed
import { route } from '@/lib/server/http/route';
import { json } from '@/lib/server/http/errors';
import { listPostsByStatus } from '@/lib/server/admin/queries';
import { ADMIN } from '../../_shared/admin-options';

export const GET = route(async (ctx) => json({ posts: listPostsByStatus(ctx.query.get('status') || 'live') }), ADMIN);
