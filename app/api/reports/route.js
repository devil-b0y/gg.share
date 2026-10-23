// POST /api/reports -- body: { addr, pubkey, signature,
//   payload: { type: 'report', postId, reason, note, ts, nonce } }
// -> { id, reportCount, autoBlacklisted }
import { route } from '@/lib/server/http/route';
import { json, errorJson } from '@/lib/server/http/errors';
import { reportLimiter } from '@/lib/server/security/ratelimit';
import { authenticateAction } from '@/lib/server/security/signed';
import { fileReport } from '@/lib/server/content/reports';

export const POST = route(async (ctx) => {
  const action = authenticateAction(ctx, ctx.body, 'report');
  if (!action.ok) return errorJson(action.status, action.error);

  const result = fileReport(action);
  if (!result.ok) return errorJson(result.status, result.error);
  return json({ id: result.id, reportCount: result.reportCount, autoBlacklisted: result.autoBlacklisted }, 201);
}, {
  limit: [reportLimiter],
  body: 'json'
});
