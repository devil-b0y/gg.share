// GET /api/admin/storage -- disk usage of uploads/ and the database.
import { route } from '@/lib/server/http/route';
import { json } from '@/lib/server/http/errors';
import { storageOverview } from '@/lib/server/admin/queries';
import { ADMIN } from '../../_shared/admin-options';

export const GET = route(async () => json(storageOverview()), ADMIN);
