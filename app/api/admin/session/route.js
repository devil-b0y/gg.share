// GET /api/admin/session -> { authenticated } -- lets the panel decide
// between the login screen and the app without a failing request.
import { route } from '@/lib/server/http/route';
import { json } from '@/lib/server/http/errors';
import { adminApiLimiter } from '@/lib/server/security/ratelimit';
import auth from '@/lib/server/security/auth';

export const GET = route(async (ctx) => json({ authenticated: auth.isAdminRequest(ctx) }), {
  limit: [adminApiLimiter]
});
