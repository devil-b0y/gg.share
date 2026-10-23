// GET /api/admin/audit -- the latest 300 admin actions.
import { route } from '@/lib/server/http/route';
import { json } from '@/lib/server/http/errors';
import { auditLog } from '@/lib/server/admin/queries';
import { ADMIN } from '../../_shared/admin-options';

export const GET = route(async () => json({ audit: auditLog() }), ADMIN);
