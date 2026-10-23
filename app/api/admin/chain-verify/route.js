// GET /api/admin/chain-verify -- same check as the public /api/chain/verify,
// under the admin rate limit.
import { route } from '@/lib/server/http/route';
import { json } from '@/lib/server/http/errors';
import { verifyChain } from '@/lib/server/content/ledger';
import { ADMIN } from '../../_shared/admin-options';

export const GET = route(async () => json(verifyChain()), ADMIN);
