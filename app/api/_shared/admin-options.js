// route() options shared by every admin endpoint behind the session check.
//
// adminApiLimiter is a blanket ceiling on the whole admin API (see
// lib/server/security/ratelimit.js); `admin: true` rejects requests without
// a valid session cookie with 401 before the handler runs.
import { adminApiLimiter } from '@/lib/server/security/ratelimit';

export const ADMIN = { limit: [adminApiLimiter], admin: true };
export const ADMIN_JSON = { ...ADMIN, body: 'json' };
