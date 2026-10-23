// POST /api/admin/logout -- revokes the session server-side and clears the cookie.
import { route } from '@/lib/server/http/route';
import { json } from '@/lib/server/http/errors';
import { clearCookie } from '@/lib/server/http/cookies';
import { adminApiLimiter } from '@/lib/server/security/ratelimit';
import auth from '@/lib/server/security/auth';

export const POST = route(async (ctx) => {
  const token = ctx.cookies[auth.COOKIE_NAME];
  if (token) auth.destroySession(token);
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(auth.COOKIE_NAME) });
}, {
  limit: [adminApiLimiter]
});
