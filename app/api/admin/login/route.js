// POST /api/admin/login -- body: { password } -> sets the session cookie.
//
// Limited twice: the admin API ceiling, then a tight 5-per-15-minutes login
// limit. Every attempt, successful or not, is recorded by iphash for the
// Security center view.
import { route } from '@/lib/server/http/route';
import { json, errorJson } from '@/lib/server/http/errors';
import { serializeCookie } from '@/lib/server/http/cookies';
import { adminApiLimiter, adminLoginLimiter } from '@/lib/server/security/ratelimit';
import { hashIp, clientIp } from '@/lib/server/security/iphash';
import auth from '@/lib/server/security/auth';
import { audit } from '@/lib/server/content/moderation';
import db from '@/lib/server/core/db';

export const POST = route(async (ctx) => {
  const { password } = ctx.body;
  // A non-string password (`{"password": {...}}`) must fail as a wrong
  // password, not reach scrypt and throw.
  const ok = typeof password === 'string' && await auth.checkAdminPassword(password);

  db.prepare('INSERT INTO admin_login_attempts (iphash, created_at, success) VALUES (?, ?, ?)')
    .run(hashIp(clientIp(ctx)), Date.now(), ok ? 1 : 0);
  if (!ok) return errorJson(401, 'invalid password');

  const token = auth.createSession();
  audit('login', null, null);
  return json({ ok: true }, 200, {
    'Set-Cookie': serializeCookie(auth.COOKIE_NAME, token, auth.sessionCookieOptions(ctx))
  });
}, {
  limit: [adminApiLimiter, adminLoginLimiter],
  body: 'json'
});
