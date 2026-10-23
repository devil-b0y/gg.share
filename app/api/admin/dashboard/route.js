// GET /api/admin/dashboard -- headline counts plus the current settings.
import { route } from '@/lib/server/http/route';
import { json } from '@/lib/server/http/errors';
import { dashboard } from '@/lib/server/admin/queries';
import { ADMIN } from '../../_shared/admin-options';

export const GET = route(async () => json(dashboard()), ADMIN);
