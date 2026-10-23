// GET /api/admin/reputation -- per-address behaviour summary, worst first.
import { route } from '@/lib/server/http/route';
import { json } from '@/lib/server/http/errors';
import { reputation } from '@/lib/server/admin/queries';
import { ADMIN } from '../../_shared/admin-options';

export const GET = route(async () => json({ addresses: reputation() }), ADMIN);
