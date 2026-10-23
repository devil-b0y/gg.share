// GET /api/chain/verify -- walks the whole ledger and reports whether it's
// intact, and if not, exactly where it broke. Public: verifiability is the
// point of a hash-chained ledger.
import { route } from '@/lib/server/http/route';
import { json } from '@/lib/server/http/errors';
import { readLimiter } from '@/lib/server/security/ratelimit';
import { verifyChain } from '@/lib/server/content/ledger';

export const GET = route(async () => json(verifyChain()), { limit: [readLimiter] });
