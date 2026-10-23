// POST /api/comments -- body: { addr, pubkey, signature,
//   payload: { type: 'comment', postId, body, parentId, ts, nonce } }
import { route } from '@/lib/server/http/route';
import { json, errorJson } from '@/lib/server/http/errors';
import { writeLimiter } from '@/lib/server/security/ratelimit';
import { authenticateAction } from '@/lib/server/security/signed';
import { createComment } from '@/lib/server/content/comments';

export const POST = route(async (ctx) => {
  const action = authenticateAction(ctx, ctx.body, 'comment');
  if (!action.ok) return errorJson(action.status, action.error);

  const result = createComment(action);
  if (!result.ok) return errorJson(result.status, result.error);
  return json({ id: result.id }, 201);
}, {
  limit: [writeLimiter],
  body: 'json'
});
