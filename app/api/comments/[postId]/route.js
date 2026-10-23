// GET /api/comments/:postId -- live comments on a post, newest first.
import { route } from '@/lib/server/http/route';
import { json, errorJson } from '@/lib/server/http/errors';
import { readLimiter } from '@/lib/server/security/ratelimit';
import { toRowId } from '@/lib/server/security/signed';
import { listComments } from '@/lib/server/content/comments';

export const GET = route(async (ctx) => {
  const postId = toRowId(ctx.params.postId);
  if (!postId) return errorJson(400, 'invalid post id');
  return json({ comments: listComments(postId) });
}, {
  limit: [readLimiter]
});
