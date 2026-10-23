// GET /api/admin/security -- login attempts, sessions, bans and active limits.
import { route } from '@/lib/server/http/route';
import { json } from '@/lib/server/http/errors';
import { securityOverview } from '@/lib/server/admin/queries';
import { ADMIN } from '../../_shared/admin-options';

export const GET = route(async () => json(securityOverview()), ADMIN);
